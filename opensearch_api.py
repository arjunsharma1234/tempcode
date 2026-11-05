import asyncio
import json
import os
import re
import uuid
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import jwt
from agents.handler.processing_scripts import STEP_KEY as PROCESSING_SCRIPTS_KEY
from agents.handler.processing_scripts import normalize_scripts
from core.auth.helper import (
    ALGORITHM,
    SECRET_KEY,
    get_current_user_from_request,
    inherit_owner_model_preferences,
)
from core.external_api_calls.call_genz_api import call_genz_api
from core.external_api_calls.call_zetaris_api import zetaris_all_dm_api
from core.feedback_indexes import (
    ALL_REVIEW_FEEDBACK_INDEXES,
    REVIEW_FEEDBACK_APPROVED_INDEX,
    REVIEW_FEEDBACK_APPROVED_READ_INDEXES,
    REVIEW_FEEDBACK_PENDING_INDEX,
    REVIEW_FEEDBACK_PENDING_READ_INDEXES,
    REVIEW_FEEDBACK_REJECTED_INDEX,
    REVIEW_FEEDBACK_REJECTED_READ_INDEXES,
)
from core.logger import PrivateAILogger
from core.opensearch.finance_broker_prompt_sync import (
    FINANCE_BROKER_VALIDATE_PROMPTS_CONTAINER_ID,
    FINANCE_BROKER_VALIDATE_PROMPTS_ENTITY,
    sync_finance_broker_validate_prompt_container,
)
from core.opensearch.helper import (
    ENTITY_TYPES,
    OpenSearchDB,
    normalize_empty_date_strings_for_mapping,
)
from core.opensearch.index_retention_service import IndexRetentionService
from core.scheduler.datasource_scheduler_service import (
    emit_datasource_new_file_event,
    execute_datasource_sync,
    execute_datasource_sync_and_emit,
    prepare_datasource_event_state,
    resync_datasource,
    schedule_datasource,
    unschedule_datasource,
)
from core.scheduler.evaluation_scheduler_service import (
    schedule_evaluation,
    unschedule_evaluation,
)
from core.scheduler.queued_indexing import queued_indexing
from core.scheduler.workflow_scheduler_service import (
    schedule_workflow,
    unschedule_workflow,
)
from dateutil.parser import parse as parse_datetime
from fastapi import APIRouter, Body, HTTPException, Query, Request
from opensearchpy.exceptions import NotFoundError
from schemas.request_schema import GenzRequest
from service.api_console_executor import resolve_api_console_result_index_name
from service.document_extraction_service.helpers.utils import (
    compute_document_index_name,
)
from service.finance_broker_docs_mgmt.compliance_rules_updater import (
    delete_compliance_rule_csv,
    sync_compliance_rule_csv,
)
from service.finance_broker_docs_mgmt.finance_broker_share_access import (
    resolve_finance_shared_headers,
)
from service.origin_vc_simulation_service import (
    install_origin_vc_simulated_datasources,
)
from utils.user_store import (
    decrypt_secret_if_encrypted,
    decrypt_sensitive_system_config_value,
    decrypt_sensitive_tool_parameters,
    encrypt_secret,
    encrypt_sensitive_opensearch_document,
    get_user_zetaris_api_credentials,
    save_user_zetaris_api_credentials,
)
from utils.utils import remove_special_characters, sync_opensearchindex_shared_state

router = APIRouter()
logger = PrivateAILogger().get_logger()

_WORKFLOW_OFF_SCHEDULE_VALUES = {
    "",
    "off",
    "manual",
    "disabled",
    "none",
    "false",
    "0",
}
_WORKFLOW_FALSE_STRINGS = {"0", "false", "f", "no", "n", "off"}


def _workflow_config_enabled(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if text in _WORKFLOW_FALSE_STRINGS:
        return False
    return default


def _clear_other_digihuman_drivers(
    request: Request,
    entity_type: str,
    document_body: Dict[str, Any],
    doc_id: str,
) -> None:
    if entity_type.lower() != "workflow" or not _workflow_config_enabled(
        document_body.get("is_digihuman_driver"), default=False
    ):
        return

    request.app.state.db.client.update_by_query(
        index="workflow",
        body={
            "script": {
                "source": "ctx._source.is_digihuman_driver = false",
                "lang": "painless",
            },
            "query": {
                "bool": {
                    "must": [{"term": {"is_digihuman_driver": True}}],
                    "must_not": [{"ids": {"values": [str(doc_id)]}}],
                }
            },
        },
        refresh=True,
        conflicts="proceed",
    )


_ENTITY_TYPE_ALIASES = {
    "apitoken": "api_token",
    "backuphistory": "backup_history",
    "contractversion": "contract_version",
    "gitbackupconfig": "git_backup_config",
    "resourceshare": "resource_share",
    "contractworkspace": "contract_workspace",
}
_FAILED_STATUS_TOKENS = {
    "fail",
    "failed",
    "error",
    "invalid",
    "corrupt",
    "broken",
    "empty",
}
_PROTECTED_OPENSEARCH_INDEX_NAMES = {
    "opensearchindex",
}
_FINANCE_CUSTOMER_ENTITIES = {"customerdocumentbatch", "customerdocument"}
_PRIVATE_CONTRACT_ENTITIES = {
    "contract",
    "contractfolder",
    "contracttemplate",
    "contract_template",
    "contract_version",
    "contractreview",
}
_CONTRACT_SHARE_ENTITY = "resource_share"
_CONTRACT_SHAREABLE_TYPES = {
    "contract",
    "contractfolder",
    "contracttemplate",
    "contract_template",
    "contract_workspace",
}
_CONTRACT_SHARE_PERMISSION_RANK = {"view": 1, "edit": 2, "admin": 3}
_CONTRACT_OWNER_FIELDS = (
    "owner_email",
    "created_by",
    "created_by_email",
    "salesperson_email",
    "user_email",
)
_SMART_DOC_FEEDBACK_PENDING_INDEX = REVIEW_FEEDBACK_PENDING_INDEX
_SMART_DOC_FEEDBACK_APPROVED_INDEX = REVIEW_FEEDBACK_APPROVED_INDEX
_SMART_DOC_FEEDBACK_REJECTED_INDEX = REVIEW_FEEDBACK_REJECTED_INDEX
_ADMIN_OWNER_SYSTEM_CONFIG_CATEGORIES = {
    "transfer_tool",
}
_ADMIN_OWNER_SYSTEM_CONFIG_KEYS = {
    "TRANSFER_TOOL_GDRIVE_SHARED_DRIVE_ID",
    "TRANSFER_TOOL_GDRIVE_TARGET_FOLDER_ID",
    "gdrive_shared_drive_id",
    "gdrive_target_folder_id",
    "transfer_tool_gdrive_shared_drive_id",
    "transfer_tool_gdrive_target_folder_id",
}
_ENTITY_WRITE_PERMISSIONS = {
    "workflow": "can_create_workflows",
    "workflowtemplate": "can_create_workflows",
    "agent": "can_create_agents",
    "tool": "can_create_tools",
    "datasource": "can_create_datasources",
    "knowledgegraph": "can_create_knowledge_graphs",
    "knowledge_graph": "can_create_knowledge_graphs",
    "contract": "can_create_contracts",
    "contractfolder": "can_create_contracts",
    "contracttemplate": "can_create_contracts",
    "contract_version": "can_create_contracts",
    "contractversion": "can_create_contracts",
    "clause": "can_create_contracts",
    "resource_share": "can_share_resources",
    "resourceshare": "can_share_resources",
    "organizationuser": "can_invite_users",
    "api_token": "can_manage_api_tokens",
    "apitoken": "can_manage_api_tokens",
    "digiavatar_feedback_staged": "can_approve_feedback",
    **{
        index_name: "can_approve_feedback" for index_name in ALL_REVIEW_FEEDBACK_INDEXES
    },
}


def _permission_is_enabled(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "1.0", "yes", "y", "on"}
    return False


def _system_config_key(document: Dict[str, Any] | None) -> str:
    if not isinstance(document, dict):
        return ""
    return str(document.get("key") or "").strip()


def _is_admin_owner_system_config(document: Dict[str, Any] | None) -> bool:
    if not isinstance(document, dict):
        return False
    category = str(document.get("category") or "").strip().lower()
    if category in _ADMIN_OWNER_SYSTEM_CONFIG_CATEGORIES:
        return True
    key = _system_config_key(document)
    return key in _ADMIN_OWNER_SYSTEM_CONFIG_KEYS or key.upper() in {
        value.upper() for value in _ADMIN_OWNER_SYSTEM_CONFIG_KEYS
    }


def _is_admin_or_owner_org_user(org_user: Dict[str, Any] | None) -> bool:
    role = str((org_user or {}).get("role") or "").strip().lower()
    return role in {"admin", "owner"} or bool((org_user or {}).get("is_admin"))


def _normalize_org_user_role(value: Any) -> str:
    return str(value or "").strip().lower()


async def _ensure_owner_role_assignment_allowed(
    request: Request,
    target_document: Dict[str, Any],
    existing_document: Dict[str, Any] | None = None,
) -> None:
    if not isinstance(target_document, dict):
        return

    existing_role = _normalize_org_user_role((existing_document or {}).get("role"))
    target_role = _normalize_org_user_role(target_document.get("role")) or existing_role

    owner_role_change = target_role == "owner" or (
        existing_role == "owner" and target_role != existing_role
    )
    if not owner_role_change:
        return

    current_org_user = await _get_current_org_user(request)
    if _normalize_org_user_role((current_org_user or {}).get("role")) == "owner":
        return

    try:
        current_user, _expires_at = await get_current_user_from_request(request)
    except Exception:
        current_user = {}

    current_email = str((current_user or {}).get("email") or "").strip().lower()
    current_org_id = str((current_user or {}).get("organization_id") or "").strip()
    target_email = str(target_document.get("user_email") or "").strip().lower()
    target_org_id = str(target_document.get("organization_id") or "").strip()

    # Preserve the first-owner bootstrap: a user may create their own owner
    # membership record for the org already embedded in their session.
    if (
        not current_org_user
        and target_role == "owner"
        and current_email
        and current_org_id
        and current_email == target_email
        and current_org_id == target_org_id
    ):
        return

    raise HTTPException(
        403,
        "Permission denied: only organization owners can assign or remove the owner role.",
    )


async def _ensure_admin_owner_access_for_system_config(
    request: Request,
    document: Dict[str, Any] | None,
) -> None:
    if not _is_admin_owner_system_config(document):
        return
    org_user = await _get_current_org_user(request)
    if _is_admin_or_owner_org_user(org_user):
        return
    raise HTTPException(
        403,
        "Permission denied: admin or owner role is required for transfer tool settings.",
    )


def _ensure_contract_version_mapping(request: Request) -> None:
    index_name = "contract_version"
    if not request.app.state.db.client.indices.exists(index=index_name):
        request.app.state.db.create_index(index_name)
        return

    request.app.state.db.client.indices.put_mapping(
        index=index_name,
        body={
            "properties": {
                "id": {"type": "keyword"},
                "contract_id": {"type": "keyword"},
                "version_number": {"type": "integer"},
                "document_url": {"type": "keyword"},
                "markup_url": {"type": "keyword"},
                "changes": {"type": "object", "enabled": True},
                "created_by": {"type": "keyword"},
                "status": {"type": "keyword"},
                "created_date": {"type": "date"},
                "updated_date": {"type": "date"},
            }
        },
    )


def _parse_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except Exception:
        return None


def _has_failed_status(value: Any) -> bool:
    status = str(value or "").strip().lower()
    if not status:
        return False
    return any(token in status for token in _FAILED_STATUS_TOKENS)


async def _get_current_org_user(request: Request) -> Dict[str, Any] | None:
    try:
        user, _expires_at = await get_current_user_from_request(request)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(401, f"Unable to resolve current user: {exc}")

    email = str((user or {}).get("email") or "").strip().lower()
    org_id = str((user or {}).get("organization_id") or "").strip()
    if not email or not org_id:
        return None

    index_name = "organizationuser"
    client = request.app.state.db.client
    if not client.indices.exists(index=index_name):
        return None

    query = {
        "size": 1,
        "sort": [
            {"updated_date": {"order": "desc", "unmapped_type": "date"}},
            {"created_date": {"order": "desc", "unmapped_type": "date"}},
        ],
        "query": {
            "bool": {
                "must": [
                    {
                        "bool": {
                            "should": [
                                {"term": {"organization_id": org_id}},
                                {"term": {"organization_id.keyword": org_id}},
                                {"match_phrase": {"organization_id": org_id}},
                            ],
                            "minimum_should_match": 1,
                        }
                    },
                    {
                        "bool": {
                            "should": [
                                {"term": {"user_email.keyword": email}},
                                {"term": {"user_email": email}},
                                {"match_phrase": {"user_email": email}},
                            ],
                            "minimum_should_match": 1,
                        }
                    },
                ]
            }
        },
    }
    hits = request.app.state.db._run_search(index_name, query).get("hits", [])
    if not hits:
        return None
    source = hits[0].get("_source", {}) if isinstance(hits[0], dict) else {}
    return source if isinstance(source, dict) else None


def _datasource_access_should_clauses(
    current_user_email: str,
) -> list[Dict[str, Any]]:
    """Build datasource ownership and granular sharing clauses.

    Datasources created before granular sharing have no shared-users field;
    those retain the old organization-wide `shared` behaviour.
    """
    email = str(current_user_email or "").strip().lower()
    clauses: list[Dict[str, Any]] = [
        {"term": {"created_by.keyword": email}},
        {"term": {"created_by": email}},
    ]
    access_targets: list[Dict[str, Any]] = [
        {"term": {"shared_users.keyword": email}},
        {"term": {"shared_users": email}},
    ]
    access_targets.append(
        {
            "bool": {
                "must_not": [
                    {"exists": {"field": "shared_users"}},
                ]
            }
        }
    )
    clauses.append(
        {
            "bool": {
                "must": [
                    {"term": {"shared": True}},
                    {
                        "bool": {
                            "should": access_targets,
                            "minimum_should_match": 1,
                        }
                    },
                ]
            }
        }
    )
    return clauses


async def _ensure_datasource_read_access(request: Request, source: Dict[str, Any]):
    email = _normalize_email(_get_authenticated_user_email(request))
    if not email:
        raise HTTPException(403, "Datasource access is required")
    if _normalize_email(source.get("created_by")) == email:
        return
    if not _coerce_bool(source.get("shared")):
        raise HTTPException(403, "Datasource access is required")

    # Missing fields identify legacy globally-shared records.
    if "shared_users" not in source:
        return
    shared_users = {
        _normalize_email(value) for value in (source.get("shared_users") or []) if value
    }
    if email not in shared_users:
        raise HTTPException(403, "Datasource access is required")


def _organization_user_unique_key(organization_id: Any, user_email: Any) -> str | None:
    org_id = str(organization_id or "").strip()
    email = str(user_email or "").strip().lower()
    if not org_id or not email:
        return None
    return f"{org_id}|{email}"


def _organization_user_doc_id(organization_id: Any, user_email: Any) -> str | None:
    unique_key = _organization_user_unique_key(organization_id, user_email)
    if not unique_key:
        return None
    return f"ou_{uuid.uuid5(uuid.NAMESPACE_URL, unique_key).hex}"


def _find_existing_organization_user_doc_id(
    request: Request, organization_id: Any, user_email: Any
) -> str | None:
    org_id = str(organization_id or "").strip()
    email = str(user_email or "").strip().lower()
    if not org_id or not email:
        return None

    index_name = "organizationuser"
    client = request.app.state.db.client
    if not client.indices.exists(index=index_name):
        return None

    query = {
        "size": 1,
        "sort": [
            {"updated_date": {"order": "desc", "unmapped_type": "date"}},
            {"created_date": {"order": "desc", "unmapped_type": "date"}},
        ],
        "query": {
            "bool": {
                "must": [
                    {
                        "bool": {
                            "should": [
                                {"term": {"organization_id": org_id}},
                                {"term": {"organization_id.keyword": org_id}},
                                {"match_phrase": {"organization_id": org_id}},
                            ],
                            "minimum_should_match": 1,
                        }
                    },
                    {
                        "bool": {
                            "should": [
                                {"term": {"user_email.keyword": email}},
                                {"term": {"user_email": email}},
                                {"match_phrase": {"user_email": email}},
                            ],
                            "minimum_should_match": 1,
                        }
                    },
                ]
            }
        },
    }
    hits = request.app.state.db._run_search(index_name, query).get("hits", [])
    if not hits:
        return None
    hit = hits[0] if isinstance(hits[0], dict) else {}
    return str(hit.get("_id") or "").strip() or None


def _get_existing_organization_user_source(
    request: Request, organization_id: Any, user_email: Any
) -> Dict[str, Any] | None:
    doc_id = _find_existing_organization_user_doc_id(
        request, organization_id, user_email
    )
    if not doc_id:
        return None

    try:
        existing_doc = request.app.state.db.get_by_id("organizationuser", doc_id)
    except Exception as exc:
        logger.warning(
            "Unable to load existing organizationuser doc_id=%s: %s", doc_id, exc
        )
        return None

    source = existing_doc.get("_source", {}) if isinstance(existing_doc, dict) else {}
    return source if isinstance(source, dict) else None


def _merge_organization_user_document(
    existing: Dict[str, Any] | None, incoming: Dict[str, Any]
) -> Dict[str, Any]:
    if not existing:
        return incoming

    merged = {**existing, **incoming}
    existing_permissions = existing.get("permissions") or {}
    incoming_permissions = incoming.get("permissions") or {}
    if isinstance(existing_permissions, str):
        try:
            existing_permissions = json.loads(existing_permissions)
        except Exception:
            existing_permissions = {}
    if isinstance(incoming_permissions, str):
        try:
            incoming_permissions = json.loads(incoming_permissions)
        except Exception:
            incoming_permissions = {}

    if isinstance(existing_permissions, dict) or isinstance(incoming_permissions, dict):
        merged["permissions"] = {
            **(existing_permissions if isinstance(existing_permissions, dict) else {}),
            **(incoming_permissions if isinstance(incoming_permissions, dict) else {}),
        }
        for key, value in (
            existing_permissions if isinstance(existing_permissions, dict) else {}
        ).items():
            if _permission_is_enabled(value) and not _permission_is_enabled(
                merged["permissions"].get(key)
            ):
                merged["permissions"][key] = value

    return merged


def _prepare_organization_user_identity(
    request: Request, document: Dict[str, Any], requested_doc_id: str
) -> str:
    org_id = str(document.get("organization_id") or "").strip()
    email = str(document.get("user_email") or "").strip().lower()
    if not org_id or not email:
        return requested_doc_id

    document["organization_id"] = org_id
    document["user_email"] = email

    existing_doc_id = _find_existing_organization_user_doc_id(request, org_id, email)
    if existing_doc_id:
        logger.info(
            "organizationuser create resolved to existing doc_id=%s organization_id=%s user_email=%s",
            existing_doc_id,
            org_id,
            email,
        )
        return existing_doc_id

    deterministic_doc_id = _organization_user_doc_id(org_id, email)
    return deterministic_doc_id or requested_doc_id


def _prepare_evaluation_identity(
    request: Request, document: Dict[str, Any], requested_doc_id: str
) -> str:
    eval_run_id = str(document.get("eval_run_id") or "").strip()
    if not eval_run_id:
        return requested_doc_id

    document["eval_run_id"] = eval_run_id
    index_name = "evaluation"
    client = request.app.state.db.client
    if client.indices.exists(index=index_name):
        query = {
            "size": 1,
            "query": {
                "bool": {
                    "should": [
                        {"term": {"eval_run_id.keyword": eval_run_id}},
                        {"term": {"eval_run_id": eval_run_id}},
                        {"match_phrase": {"eval_run_id": eval_run_id}},
                    ],
                    "minimum_should_match": 1,
                }
            },
        }
        hits = request.app.state.db._run_search(index_name, query).get("hits", [])
        if hits:
            hit = hits[0] if isinstance(hits[0], dict) else {}
            existing_doc_id = str(hit.get("_id") or "").strip()
            if existing_doc_id:
                logger.info(
                    "evaluation create resolved to existing doc_id=%s eval_run_id=%s",
                    existing_doc_id,
                    eval_run_id,
                )
                return existing_doc_id

    return f"eval_{uuid.uuid5(uuid.NAMESPACE_URL, eval_run_id).hex}"


async def _ensure_entity_write_permission(
    request: Request,
    entity_type: str,
    action: str,
    document: Dict[str, Any] | None = None,
) -> None:
    if str(entity_type).lower() in {"systemconfig", "system_config"}:
        await _ensure_admin_owner_access_for_system_config(request, document)

    normalized_entity = str(entity_type).lower()
    permission_key = _ENTITY_WRITE_PERMISSIONS.get(normalized_entity)
    if not permission_key:
        return

    org_user = await _get_current_org_user(request)
    if str(entity_type).lower() == "organizationuser" and _is_admin_or_owner_org_user(
        org_user
    ):
        return
    permissions = (org_user or {}).get("permissions") or {}
    if isinstance(permissions, str):
        try:
            permissions = json.loads(permissions)
        except Exception:
            permissions = {}
    if not isinstance(permissions, dict):
        permissions = {}

    if _permission_is_enabled(permissions.get(permission_key)) or (
        normalized_entity in {"resource_share", "resourceshare"}
        and _permission_is_enabled(permissions.get("can_share_contracts"))
    ):
        return

    # Allow a user to create their own membership record when an org has not
    # created one yet. This preserves the existing Team Management bootstrap
    # flow without allowing viewers to add other users.
    if (
        str(entity_type).lower() == "organizationuser"
        and action == "create"
        and not org_user
        and isinstance(document, dict)
    ):
        try:
            current_user, _expires_at = await get_current_user_from_request(request)
        except Exception:
            current_user = {}
        current_email = str((current_user or {}).get("email") or "").strip().lower()
        current_org_id = str((current_user or {}).get("organization_id") or "").strip()
        document_email = str(document.get("user_email") or "").strip().lower()
        document_org_id = str(document.get("organization_id") or "").strip()
        if (
            current_email
            and current_org_id
            and current_email == document_email
            and current_org_id == document_org_id
        ):
            return

    raise HTTPException(
        403,
        f"Permission denied: {permission_key} is required to {action} {entity_type}.",
    )


def _normalize_entity_type(entity_type: str) -> str:
    normalized = str(entity_type or "").strip().lower()
    return _ENTITY_TYPE_ALIASES.get(normalized, normalized)


def _contract_owner_email(request: Request) -> str:
    """Return the authenticated owner identity used for private contract data."""
    owner_email = _normalize_email(_get_authenticated_user_email(request))
    if not owner_email:
        raise HTTPException(401, "Authentication is required for contract data")
    return owner_email


def _contract_owner_key(value: Any) -> str:
    """Normalize legacy contract owner identifiers for backwards compatibility."""
    return remove_special_characters(_normalize_email(value))


def _contract_owner_matches(owner_email: str, candidate: Any) -> bool:
    normalized_candidate = _normalize_email(candidate)
    return bool(
        normalized_candidate
        and (
            normalized_candidate == owner_email
            or _contract_owner_key(normalized_candidate)
            == _contract_owner_key(owner_email)
        )
    )


def _contract_share_value_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except (TypeError, ValueError):
            return []
    return []


def _contract_share_permission(value: Any) -> str:
    permission = str(value or "view").strip().lower()
    return permission if permission in _CONTRACT_SHARE_PERMISSION_RANK else "view"


def _contract_share_sources(request: Request) -> list[Dict[str, Any]]:
    sources: list[Dict[str, Any]] = []
    for resource_type in ("contract", "contractfolder", "contracttemplate"):
        for resource_id, resource in _contract_index_sources(request, resource_type):
            recipients = sorted(
                {
                    _normalize_email(value)
                    for value in _contract_share_value_list(resource.get("shared_with"))
                    if _normalize_email(value)
                }
            )
            if not resource.get("sharing_enabled") or not recipients:
                continue
            sources.append(
                {
                    "id": f"direct:{resource_type}:{resource_id}",
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "resource_name": resource.get("name")
                    or resource.get("title")
                    or resource_id,
                    "owner_email": next(
                        (
                            resource.get(field)
                            for field in _CONTRACT_OWNER_FIELDS
                            if resource.get(field)
                        ),
                        "",
                    ),
                    "organization_id": resource.get("organization_id"),
                    "visibility": "shared",
                    "shared_with": [
                        {"user_email": email, "permission_level": "edit"}
                        for email in recipients
                    ],
                }
            )
    for organization_id, organization in _contract_index_sources(
        request, "organization"
    ):
        recipients = sorted(
            {
                _normalize_email(value)
                for value in _contract_share_value_list(
                    organization.get("contract_workspace_shared_with")
                )
                if _normalize_email(value)
            }
        )
        if organization.get("contract_workspace_sharing_enabled") and recipients:
            sources.append(
                {
                    "id": f"direct:contract_workspace:{organization_id}",
                    "resource_type": "contract_workspace",
                    "resource_id": organization_id,
                    "resource_name": "Entire workspace",
                    "owner_email": organization.get("owner_email")
                    or organization.get("created_by"),
                    "organization_id": organization_id,
                    "visibility": "shared",
                    "shared_with": [
                        {"user_email": email, "permission_level": "edit"}
                        for email in recipients
                    ],
                }
            )

    # Read legacy records during migration, but all new writes use direct fields.
    client = request.app.state.db.client
    try:
        if client.indices.exists(index=_CONTRACT_SHARE_ENTITY):
            response = client.search(
                index=_CONTRACT_SHARE_ENTITY,
                body={"size": 10000, "query": {"match_all": {}}},
            )
            sources.extend(
                hit.get("_source", {}) or {}
                for hit in response.get("hits", {}).get("hits", [])
                if isinstance(hit, dict) and isinstance(hit.get("_source", {}), dict)
            )
    except Exception:
        pass
    return sources


def _contract_share_grants_for_user(
    request: Request, resource_type: str | None = None
) -> list[Dict[str, Any]]:
    email = _contract_owner_email(request)
    user, _ = _get_authenticated_user_context(request)
    organization_id = str((user or {}).get("organization_id") or "").strip()
    normalized_type = _normalize_entity_type(resource_type or "")
    grants = []
    for source in _contract_share_sources(request):
        if organization_id and str(source.get("organization_id") or "").strip() not in {
            "",
            organization_id,
        }:
            continue
        if (
            normalized_type
            and _normalize_entity_type(source.get("resource_type")) != normalized_type
        ):
            continue
        shared_with = _contract_share_value_list(source.get("shared_with"))
        for recipient in shared_with:
            if not isinstance(recipient, dict):
                continue
            recipient_email = _normalize_email(
                recipient.get("user_email") or recipient.get("email")
            )
            if recipient_email == email:
                grants.append(
                    {
                        **source,
                        "permission_level": _contract_share_permission(
                            recipient.get("permission_level")
                            or recipient.get("access_level")
                        ),
                    }
                )
                break
    return grants


def _contract_folder_path(source: Dict[str, Any]) -> list[str]:
    parent = source.get("parent_path")
    parent_path = _contract_share_value_list(parent)
    if not parent_path and isinstance(parent, str) and parent.strip():
        parent_path = [part for part in parent.split("/") if part.strip()]
    name = str(source.get("name") or "").strip()
    return [str(part).strip() for part in parent_path if str(part).strip()] + (
        [name] if name else []
    )


def _contract_source_folder_path(source: Dict[str, Any]) -> list[str]:
    value = source.get("folder_path")
    path = _contract_share_value_list(value)
    if not path and isinstance(value, str) and value.strip():
        path = [part for part in value.split("/") if part.strip()]
    return [str(part).strip() for part in path if str(part).strip()]


def _contract_path_is_descendant(path: list[str], root: list[str]) -> bool:
    return bool(root) and len(path) >= len(root) and path[: len(root)] == root


def _contract_shared_folder_roots(request: Request) -> list[tuple[list[str], str]]:
    grants = _contract_share_grants_for_user(request, "contractfolder")
    roots: list[tuple[list[str], str]] = []
    client = request.app.state.db.client
    for grant in grants:
        folder_id = str(grant.get("resource_id") or "").strip()
        if not folder_id:
            continue
        try:
            folder = client.get(index="contractfolder", id=folder_id)
        except Exception:
            continue
        path = _contract_folder_path(folder.get("_source", {}) or {})
        if path:
            roots.append(
                (path, _contract_share_permission(grant.get("permission_level")))
            )
    return roots


def _contract_shared_permission(
    request: Request, entity_type: str, source: Dict[str, Any]
) -> str | None:
    normalized_type = _normalize_entity_type(entity_type)
    source_id = str(source.get("id") or source.get("_id") or "").strip()
    direct_types = {
        "contract": "contract",
        "contractfolder": "contractfolder",
        "contracttemplate": "contracttemplate",
        "contract_template": "contracttemplate",
    }
    required_type = direct_types.get(normalized_type)
    best_rank = 0
    best_permission = None
    if required_type:
        for grant in _contract_share_grants_for_user(request, required_type):
            if str(grant.get("resource_id") or "").strip() == source_id:
                permission = _contract_share_permission(grant.get("permission_level"))
                if _CONTRACT_SHARE_PERMISSION_RANK[permission] > best_rank:
                    best_rank = _CONTRACT_SHARE_PERMISSION_RANK[permission]
                    best_permission = permission

    source_org = str(source.get("organization_id") or "").strip()
    workspace_grants = _contract_share_grants_for_user(request, "contract_workspace")
    for grant in workspace_grants:
        grant_org = str(
            grant.get("organization_id") or grant.get("resource_id") or ""
        ).strip()
        member_match = False
        if not source_org or grant_org != source_org:
            for _member_id, member_source in _contract_index_sources(
                request, "organizationuser"
            ):
                if str(
                    member_source.get("organization_id") or ""
                ).strip() == grant_org and any(
                    _contract_owner_matches(
                        member_source.get("user_email"), source.get(field)
                    )
                    for field in _CONTRACT_OWNER_FIELDS
                ):
                    member_match = True
                    break
        if grant_org and (grant_org == source_org or member_match):
            permission = _contract_share_permission(grant.get("permission_level"))
            if _CONTRACT_SHARE_PERMISSION_RANK[permission] > best_rank:
                best_rank = _CONTRACT_SHARE_PERMISSION_RANK[permission]
                best_permission = permission

    if normalized_type == "contractfolder":
        current_path = _contract_folder_path(source)
    elif normalized_type == "contract":
        current_path = _contract_source_folder_path(source)
    else:
        current_path = []
    if current_path:
        for root, permission in _contract_shared_folder_roots(request):
            if _contract_path_is_descendant(current_path, root):
                if _CONTRACT_SHARE_PERMISSION_RANK[permission] > best_rank:
                    best_rank = _CONTRACT_SHARE_PERMISSION_RANK[permission]
                    best_permission = permission

    parent_contract_id = str(source.get("contract_id") or "").strip()
    if normalized_type in {"contract_version", "contractreview"} and parent_contract_id:
        for grant in _contract_share_grants_for_user(request, "contract"):
            if str(grant.get("resource_id") or "").strip() == parent_contract_id:
                permission = _contract_share_permission(grant.get("permission_level"))
                if _CONTRACT_SHARE_PERMISSION_RANK[permission] > best_rank:
                    best_rank = _CONTRACT_SHARE_PERMISSION_RANK[permission]
                    best_permission = permission
        try:
            parent = request.app.state.db.client.get(
                index="contract", id=parent_contract_id
            )
            parent_source = parent.get("_source", {}) or {}
            parent_permission = _contract_shared_permission(
                request, "contract", parent_source
            )
            if (
                parent_permission
                and _CONTRACT_SHARE_PERMISSION_RANK[parent_permission] > best_rank
            ):
                best_permission = parent_permission
        except Exception:
            pass
    return best_permission


def _ensure_contract_access(
    request: Request,
    entity_type: str,
    source: Dict[str, Any],
    required_permission: str = "view",
) -> None:
    normalized_type = _normalize_entity_type(entity_type)
    if normalized_type not in _PRIVATE_CONTRACT_ENTITIES:
        return
    if _contract_document_belongs_to_owner(request, source):
        return
    permission = _contract_shared_permission(request, normalized_type, source)
    if (
        permission
        and _CONTRACT_SHARE_PERMISSION_RANK[permission]
        >= _CONTRACT_SHARE_PERMISSION_RANK[required_permission]
    ):
        return
    raise HTTPException(404, "Document not found")


def _contract_owner_filter(request: Request) -> Dict[str, Any]:
    """Build an owner-only filter for private contract-management entities.

    The older contract records used salesperson_email/created_by, while new
    writes use owner_email as the canonical field. Supporting the legacy fields
    keeps a user's existing records visible without making them organization-wide.
    """
    owner_email = _contract_owner_email(request)
    fields = (
        "owner_email",
        "created_by",
        "created_by_email",
        "salesperson_email",
        "user_email",
    )
    should: list[Dict[str, Any]] = []
    owner_key = _contract_owner_key(owner_email)
    for field in fields:
        should.extend(
            [
                {"term": {f"{field}.keyword": owner_email}},
                {"term": {field: owner_email}},
                {"match_phrase": {field: owner_email}},
            ]
        )
        if owner_key:
            # Legacy records sometimes stored a username/email with punctuation
            # removed or inserted. Match only the same normalized identity.
            wildcard_key = "*" + "*".join(owner_key) + "*"
            should.extend(
                [
                    {"wildcard": {f"{field}.keyword": wildcard_key}},
                    {"wildcard": {field: wildcard_key}},
                ]
            )
    return {"bool": {"should": should, "minimum_should_match": 1}}


def _contract_document_belongs_to_owner(
    request: Request, source: Dict[str, Any]
) -> bool:
    owner_email = _contract_owner_email(request)
    return any(
        _contract_owner_matches(owner_email, source.get(field))
        for field in (
            "owner_email",
            "created_by",
            "created_by_email",
            "salesperson_email",
            "user_email",
        )
    )


def _contract_index_sources(
    request: Request, index: str
) -> list[tuple[str, Dict[str, Any]]]:
    """Load the small contract-management indexes used for ACL expansion."""
    client = request.app.state.db.client
    try:
        if not client.indices.exists(index=index):
            return []
        response = client.search(
            index=index, body={"size": 10000, "query": {"match_all": {}}}
        )
    except Exception:
        return []
    result = []
    for hit in response.get("hits", {}).get("hits", []):
        if not isinstance(hit, dict):
            continue
        source = hit.get("_source", {})
        if isinstance(source, dict):
            result.append((str(hit.get("_id") or source.get("id") or ""), source))
    return result


def _contract_shared_resource_ids(request: Request, entity_type: str) -> set[str]:
    """Expand direct and nested-folder grants into IDs safe for search filters."""
    normalized_type = _normalize_entity_type(entity_type)
    grants = _contract_share_grants_for_user(request)
    direct_ids: dict[str, set[str]] = {}
    folder_roots: list[tuple[list[str], str]] = []
    workspace_orgs: set[str] = set()
    for grant in grants:
        resource_type = _normalize_entity_type(grant.get("resource_type"))
        resource_id = str(grant.get("resource_id") or "").strip()
        if resource_id:
            direct_ids.setdefault(resource_type, set()).add(resource_id)
        if resource_type == "contractfolder" and resource_id:
            for folder_id, folder_source in _contract_index_sources(
                request, "contractfolder"
            ):
                if folder_id == resource_id:
                    folder_roots.append(
                        (
                            _contract_folder_path(folder_source),
                            _contract_share_permission(grant.get("permission_level")),
                        )
                    )
                    break
        if resource_type == "contract_workspace":
            workspace_orgs.add(str(grant.get("organization_id") or resource_id).strip())
    workspace_members: set[str] = set()
    if workspace_orgs:
        for _member_id, member_source in _contract_index_sources(
            request, "organizationuser"
        ):
            if (
                str(member_source.get("organization_id") or "").strip()
                in workspace_orgs
            ):
                member_email = _normalize_email(member_source.get("user_email"))
                if member_email:
                    workspace_members.add(member_email)

    if normalized_type in {"contracttemplate", "contract_template"}:
        result = direct_ids.get("contracttemplate", set()) | direct_ids.get(
            "contract_template", set()
        )
        for template_id, source in _contract_index_sources(request, "contracttemplate"):
            if str(
                source.get("organization_id") or ""
            ).strip() in workspace_orgs or any(
                _contract_owner_matches(member, source.get(field))
                for member in workspace_members
                for field in _CONTRACT_OWNER_FIELDS
            ):
                result.add(template_id)
        return result
    if normalized_type == "contractfolder":
        result = set(direct_ids.get("contractfolder", set()))
        for folder_id, source in _contract_index_sources(request, "contractfolder"):
            path = _contract_folder_path(source)
            if (
                str(source.get("organization_id") or "").strip() in workspace_orgs
                or any(
                    _contract_owner_matches(member, source.get(field))
                    for member in workspace_members
                    for field in _CONTRACT_OWNER_FIELDS
                )
                or any(
                    _contract_path_is_descendant(path, root)
                    for root, _permission in folder_roots
                )
            ):
                result.add(folder_id)
        return result
    if normalized_type == "contract":
        result = set(direct_ids.get("contract", set()))
        for contract_id, source in _contract_index_sources(request, "contract"):
            path = _contract_source_folder_path(source)
            if (
                str(source.get("organization_id") or "").strip() in workspace_orgs
                or any(
                    _contract_owner_matches(member, source.get(field))
                    for member in workspace_members
                    for field in _CONTRACT_OWNER_FIELDS
                )
                or any(
                    _contract_path_is_descendant(path, root)
                    for root, _permission in folder_roots
                )
            ):
                result.add(contract_id)
        return result
    if normalized_type in {"contract_version", "contractreview"}:
        parent_contract_ids = _contract_shared_resource_ids(request, "contract")
        result = set(direct_ids.get(normalized_type, set()))
        for item_id, source in _contract_index_sources(request, normalized_type):
            if str(source.get("contract_id") or "").strip() in parent_contract_ids:
                result.add(item_id)
        return result
    return set()


def _with_contract_access_filter(
    request: Request, entity_type: str, query: Dict[str, Any]
) -> Dict[str, Any]:
    if str(entity_type or "").strip().lower() not in _PRIVATE_CONTRACT_ENTITIES:
        return query
    owner_filter = _contract_owner_filter(request)
    shared_ids = _contract_shared_resource_ids(request, entity_type)
    access_should: list[Dict[str, Any]] = [owner_filter]
    if shared_ids:
        access_should.append({"terms": {"_id": sorted(shared_ids)}})
        access_should.append({"terms": {"id.keyword": sorted(shared_ids)}})
    access_filter = {"bool": {"should": access_should, "minimum_should_match": 1}}
    if query.get("match_all") == {}:
        return access_filter
    return {"bool": {"must": [query, access_filter]}}


def _resource_share_owner_matches(request: Request, source: Dict[str, Any]) -> bool:
    user, _ = _get_authenticated_user_context(request)
    organization_id = str((user or {}).get("organization_id") or "").strip()
    if organization_id and str(source.get("organization_id") or "").strip() not in {
        "",
        organization_id,
    }:
        return False
    owner_email = _contract_owner_email(request)
    return _contract_owner_matches(
        owner_email, source.get("owner_email")
    ) or _contract_owner_matches(owner_email, source.get("created_by"))


def _resource_share_recipient_matches(request: Request, source: Dict[str, Any]) -> bool:
    user, _ = _get_authenticated_user_context(request)
    organization_id = str((user or {}).get("organization_id") or "").strip()
    if organization_id and str(source.get("organization_id") or "").strip() not in {
        "",
        organization_id,
    }:
        return False
    email = _contract_owner_email(request)
    return any(
        isinstance(recipient, dict)
        and _normalize_email(recipient.get("user_email") or recipient.get("email"))
        == email
        for recipient in _contract_share_value_list(source.get("shared_with"))
    )


async def _prepare_resource_share_document(
    request: Request,
    document: Dict[str, Any],
    existing: Dict[str, Any] | None = None,
    membership_cache: Dict[tuple[str, str], Dict[str, Any] | None] | None = None,
    user_context: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Validate and canonicalize a contract/folder share before indexing."""
    resource_type = _normalize_entity_type(document.get("resource_type"))
    if resource_type == "contract_template":
        resource_type = "contracttemplate"
    if resource_type not in _CONTRACT_SHAREABLE_TYPES:
        raise HTTPException(
            400, "Only contracts, folders, and templates can be shared here"
        )
    resource_id = str(document.get("resource_id") or "").strip()
    if not resource_id:
        raise HTTPException(400, "resource_id is required")
    owner_email = _contract_owner_email(request)
    if existing and not _resource_share_owner_matches(request, existing):
        raise HTTPException(404, "Share record not found")
    user = user_context
    if user is None:
        user, _expires_at = await get_current_user_from_request(request)
    organization_id = str(
        (user or {}).get("organization_id") or document.get("organization_id") or ""
    ).strip()
    if not organization_id:
        raise HTTPException(400, "Organization could not be identified")
    target_source: Dict[str, Any] = {}
    if resource_type == "contract_workspace":
        if resource_id != organization_id:
            raise HTTPException(403, "Workspace share must target your organization")
    else:
        try:
            target = request.app.state.db.client.get(
                index=resource_type, id=resource_id
            )
        except NotFoundError as exc:
            raise HTTPException(404, "Shared resource not found") from exc
        target_source = target.get("_source", {}) or {}
        if not _contract_document_belongs_to_owner(request, target_source):
            raise HTTPException(403, "Only the resource owner can manage sharing")
    shared_with = _contract_share_value_list(document.get("shared_with"))
    canonical_recipients = []
    for recipient in shared_with:
        if not isinstance(recipient, dict):
            continue
        recipient_email = _normalize_email(
            recipient.get("user_email") or recipient.get("email")
        )
        if not recipient_email or recipient_email == owner_email:
            continue
        membership_key = (organization_id, recipient_email)
        if membership_cache is not None and membership_key in membership_cache:
            membership = membership_cache[membership_key]
        else:
            membership = _get_existing_organization_user_source(
                request, organization_id, recipient_email
            )
            if membership_cache is not None:
                membership_cache[membership_key] = membership
        if not membership or str(membership.get("status") or "active").lower() not in {
            "active",
            "",
        }:
            raise HTTPException(
                400,
                f"Share recipient is not an active organization member: {recipient_email}",
            )
        canonical_recipients.append(
            {
                "user_email": recipient_email,
                "permission_level": _contract_share_permission(
                    recipient.get("permission_level") or recipient.get("access_level")
                ),
                "shared_at": recipient.get("shared_at")
                or datetime.utcnow().isoformat(),
                "shared_by": owner_email,
            }
        )
    now = datetime.utcnow().isoformat()
    return {
        **(existing or {}),
        **document,
        "id": str((existing or {}).get("id") or document.get("id") or uuid.uuid4()),
        "resource_type": resource_type,
        "resource_id": resource_id,
        "resource_name": document.get("resource_name")
        or (
            "All contracts"
            if resource_type == "contract_workspace"
            else target_source.get("name") or target_source.get("title") or resource_id
        ),
        "owner_email": owner_email,
        "created_by": owner_email,
        "organization_id": organization_id,
        "visibility": "shared" if canonical_recipients else "private",
        "shared_with": canonical_recipients,
        "share_settings": document.get("share_settings")
        or (existing or {}).get("share_settings")
        or {
            "allow_reshare": False,
            "allow_download": True,
            "allow_copy": False,
            "expires_at": None,
        },
        "updated_date": now,
        "created_date": (existing or {}).get("created_date") or now,
    }


@router.post("/contract-sharing/bulk")
async def bulk_upsert_contract_shares(
    request: Request, request_data: Dict[str, Any] = Body(...)
):
    """Validate and save sharing access for multiple contract resources."""
    await _ensure_entity_write_permission(request, _CONTRACT_SHARE_ENTITY, "create")
    shares = request_data.get("shares") if isinstance(request_data, dict) else None
    if not isinstance(shares, list) or not shares:
        raise HTTPException(400, "At least one resource share is required")
    if len(shares) > 500:
        raise HTTPException(400, "A maximum of 500 resources can be shared at once")

    membership_cache: Dict[tuple[str, str], Dict[str, Any] | None] = {}
    user_context, _expires_at = await get_current_user_from_request(request)
    organization_id = str((user_context or {}).get("organization_id") or "").strip()
    prepared_records: list[tuple[str, str, Dict[str, Any]]] = []
    for share in shares:
        if not isinstance(share, dict):
            raise HTTPException(400, "Each resource share must be an object")
        normalized_type = _normalize_entity_type(share.get("resource_type"))
        if normalized_type == "contract_template":
            normalized_type = "contracttemplate"
        resource_id = str(share.get("resource_id") or "").strip()
        if normalized_type not in _CONTRACT_SHAREABLE_TYPES or not resource_id:
            raise HTTPException(400, "Invalid contract sharing target")
        target_index = (
            "organization"
            if normalized_type == "contract_workspace"
            else normalized_type
        )
        if normalized_type == "contract_workspace" and resource_id != organization_id:
            raise HTTPException(403, "Workspace share must target your organization")
        try:
            target = request.app.state.db.client.get(index=target_index, id=resource_id)
        except NotFoundError as exc:
            raise HTTPException(404, "Shared resource not found") from exc
        target_source = target.get("_source", {}) or {}
        if (
            normalized_type != "contract_workspace"
            and not _contract_document_belongs_to_owner(request, target_source)
        ):
            raise HTTPException(403, "Only the resource owner can manage sharing")

        shared_field = (
            "contract_workspace_shared_with"
            if normalized_type == "contract_workspace"
            else "shared_with"
        )
        recipients = {
            _normalize_email(value)
            for value in _contract_share_value_list(target_source.get(shared_field))
            if _normalize_email(value)
        }
        for recipient in _contract_share_value_list(share.get("shared_with")):
            if isinstance(recipient, dict):
                email = _normalize_email(
                    recipient.get("user_email") or recipient.get("email")
                )
            else:
                email = _normalize_email(recipient)
            if not email or email == _contract_owner_email(request):
                continue
            cache_key = (organization_id, email)
            if cache_key not in membership_cache:
                membership_cache[cache_key] = _get_existing_organization_user_source(
                    request, organization_id, email
                )
            membership = membership_cache[cache_key]
            if not membership or str(
                membership.get("status") or "active"
            ).lower() not in {
                "active",
                "",
            }:
                raise HTTPException(
                    400,
                    f"Share recipient is not an active organization member: {email}",
                )
            recipients.add(email)
        updated_source = {
            **target_source,
            shared_field: sorted(recipients),
            (
                "contract_workspace_sharing_enabled"
                if normalized_type == "contract_workspace"
                else "sharing_enabled"
            ): bool(recipients),
            "updated_date": datetime.utcnow().isoformat(),
        }
        prepared_records.append((target_index, resource_id, updated_source))

    results = []
    for index, (target_index, document_id, document) in enumerate(prepared_records):
        await request.app.state.db.async_index_document(
            target_index,
            document_id,
            document,
            refresh=index == len(prepared_records) - 1,
        )
        results.append(
            {
                "id": document_id,
                "resource_type": (
                    "contract_workspace"
                    if target_index == "organization"
                    else target_index
                ),
                "resource_id": document_id,
                "shared_with_count": len(
                    document.get("contract_workspace_shared_with")
                    or document.get("shared_with")
                    or []
                ),
            }
        )
    return {"updated": len(results), "items": results}


@router.get("/contract-sharing/list")
async def list_contract_shares(request: Request):
    sources = _contract_share_sources(request)
    return {
        "items": [
            source
            for source in sources
            if _resource_share_owner_matches(request, source)
            or _resource_share_recipient_matches(request, source)
        ]
    }


@router.post("/contract-sharing/revoke")
async def revoke_contract_share_access(
    request: Request, request_data: Dict[str, Any] = Body(...)
):
    """Remove one recipient from every matching share record for a resource."""
    await _ensure_entity_write_permission(request, _CONTRACT_SHARE_ENTITY, "update")
    resource_type = _normalize_entity_type(request_data.get("resource_type"))
    if resource_type == "contract_template":
        resource_type = "contracttemplate"
    resource_id = str(request_data.get("resource_id") or "").strip()
    recipient_email = _normalize_email(request_data.get("user_email"))
    if (
        resource_type not in _CONTRACT_SHAREABLE_TYPES
        or not resource_id
        or not recipient_email
    ):
        raise HTTPException(
            400, "resource_type, resource_id, and user_email are required"
        )

    updated = 0
    target_index = (
        "organization" if resource_type == "contract_workspace" else resource_type
    )
    try:
        target = request.app.state.db.client.get(index=target_index, id=resource_id)
    except NotFoundError as exc:
        raise HTTPException(404, "Shared resource not found") from exc
    target_source = target.get("_source", {}) or {}
    if resource_type == "contract_workspace":
        user, _expires_at = await get_current_user_from_request(request)
        if resource_id != str((user or {}).get("organization_id") or "").strip():
            raise HTTPException(403, "Workspace share must target your organization")
        shared_field = "contract_workspace_shared_with"
        enabled_field = "contract_workspace_sharing_enabled"
    else:
        if not _contract_document_belongs_to_owner(request, target_source):
            raise HTTPException(403, "Only the resource owner can manage sharing")
        shared_field = "shared_with"
        enabled_field = "sharing_enabled"
    remaining_direct = sorted(
        {
            email
            for value in _contract_share_value_list(target_source.get(shared_field))
            if (email := _normalize_email(value)) and email != recipient_email
        }
    )
    if len(remaining_direct) != len(
        _contract_share_value_list(target_source.get(shared_field))
    ):
        await request.app.state.db.async_index_document(
            target_index,
            resource_id,
            {
                **target_source,
                shared_field: remaining_direct,
                enabled_field: bool(remaining_direct),
                "updated_date": datetime.utcnow().isoformat(),
            },
            refresh=True,
        )
        updated += 1

    # Also revoke matching legacy grants so migration fallback cannot retain access.
    for document_id, source in _contract_index_sources(request, _CONTRACT_SHARE_ENTITY):
        if (
            _normalize_entity_type(source.get("resource_type")) != resource_type
            or str(source.get("resource_id") or "").strip() != resource_id
            or not _resource_share_owner_matches(request, source)
        ):
            continue
        remaining = [
            recipient
            for recipient in _contract_share_value_list(source.get("shared_with"))
            if not isinstance(recipient, dict)
            or _normalize_email(recipient.get("user_email") or recipient.get("email"))
            != recipient_email
        ]
        if len(remaining) == len(_contract_share_value_list(source.get("shared_with"))):
            continue
        prepared = await _prepare_resource_share_document(
            request,
            {**source, "shared_with": remaining},
            source,
        )
        await request.app.state.db.async_index_document(
            _CONTRACT_SHARE_ENTITY,
            document_id,
            prepared,
            refresh=True,
        )
        updated += 1
    return {
        "updated": updated,
        "resource_type": resource_type,
        "resource_id": resource_id,
    }


def _ensure_contract_owner_access(
    request: Request, entity_type: str, source: Dict[str, Any]
) -> None:
    if str(entity_type or "").strip().lower() not in _PRIVATE_CONTRACT_ENTITIES:
        return
    if not _contract_document_belongs_to_owner(request, source):
        raise HTTPException(404, "Document not found")


def _with_contract_owner_filter(
    request: Request, entity_type: str, query: Dict[str, Any]
) -> Dict[str, Any]:
    if str(entity_type or "").strip().lower() not in _PRIVATE_CONTRACT_ENTITIES:
        return query
    owner_filter = _contract_owner_filter(request)
    if query.get("match_all") == {}:
        return owner_filter
    return {"bool": {"must": [query, owner_filter]}}


def _normalize_finance_owner_key(value: Any) -> str:
    return remove_special_characters(str(value or "").strip().lower())


def _get_finance_customer_owner_key(request: Request, document: Dict[str, Any]) -> str:
    shared_context = getattr(request.state, "finance_shared_context", None) or {}
    delegated_owner_key = _normalize_finance_owner_key(shared_context.get("owner_key"))
    if delegated_owner_key:
        return delegated_owner_key
    for key in (
        "created_by",
        "created_by_email",
        "broker_email",
        "userEmail",
        "user_email",
        "email",
        "username",
    ):
        owner_key = _normalize_finance_owner_key(document.get(key))
        if owner_key:
            return owner_key

    return _normalize_finance_owner_key(_get_authenticated_user_email(request))


def _finance_customer_owner_values(
    request: Request | None = None,
    document: Dict[str, Any] | None = None,
    owner_key: str | None = None,
) -> list[str]:
    values: list[str] = []

    def add(value: Any) -> None:
        raw = str(value or "").strip().lower()
        normalized = _normalize_finance_owner_key(raw)
        for candidate in (raw, normalized):
            if candidate and candidate not in values:
                values.append(candidate)

    if owner_key:
        add(owner_key)
    for key in (
        "broker_owner_key",
        "created_by",
        "created_by_email",
        "broker_email",
        "userEmail",
        "user_email",
        "email",
        "username",
    ):
        if document:
            add(document.get(key))
    if request is not None:
        shared_context = getattr(request.state, "finance_shared_context", None) or {}
        delegated_owner = shared_context.get("owner_email") or shared_context.get(
            "owner_key"
        )
        add(delegated_owner or _get_authenticated_user_email(request))
    return values


_FINANCE_SHARED_READ_ACTIONS = {
    "edit",
    "upload",
    "request_documents",
    "email_communications",
    "validate",
    "ai_analysis",
    "transfer",
    "calculator",
    "archive",
    "delete",
    "feedback",
}


def _ensure_shared_entity_batch(
    entity_type: str,
    context: Dict[str, Any] | None,
    *,
    doc_id: str = "",
    document: Dict[str, Any] | None = None,
    existing_source: Dict[str, Any] | None = None,
) -> None:
    if not context:
        return
    expected_batch_id = str(context.get("batch_id") or "").strip()
    entity = str(entity_type or "").strip().lower()
    if entity == "customerdocumentbatch":
        target_batch_id = str(doc_id or (document or {}).get("id") or "").strip()
    else:
        target_batch_id = str(
            (existing_source or {}).get("batch_id")
            or (document or {}).get("batch_id")
            or ""
        ).strip()
    if target_batch_id and target_batch_id != expected_batch_id:
        raise HTTPException(403, "Shared action targets a different customer")


def _finance_document_belongs_to_owner(source: Dict[str, Any], owner_key: str) -> bool:
    if not owner_key:
        return False

    owner_values = _finance_customer_owner_values(owner_key=owner_key)
    for key in (
        "broker_owner_key",
        "created_by",
        "created_by_email",
        "broker_email",
        "userEmail",
        "user_email",
        "email",
        "username",
    ):
        source_values = _finance_customer_owner_values(document={key: source.get(key)})
        if any(value in owner_values for value in source_values):
            return True
    return False


def _finance_owner_filter(
    owner_key: str = "",
    owner_values: list[str] | None = None,
) -> Dict[str, Any] | None:
    values = []
    for value in [
        *(owner_values or []),
        *_finance_customer_owner_values(owner_key=owner_key),
    ]:
        if value and value not in values:
            values.append(value)
    if not values:
        return None

    should: list[Dict[str, Any]] = []
    for field in (
        "broker_owner_key",
        "created_by",
        "created_by_email",
        "broker_email",
        "userEmail",
        "user_email",
        "email",
        "username",
    ):
        should.extend(
            [
                {"terms": {field: values}},
                {"terms": {f"{field}.keyword": values}},
            ]
        )
    return {"bool": {"should": should, "minimum_should_match": 1}}


def _with_finance_owner_filter(query: Dict[str, Any], owner_key: str) -> Dict[str, Any]:
    owner_filter = _finance_owner_filter(owner_key)
    if not owner_filter:
        return {"match_none": {}}
    return {"bool": {"must": [query, owner_filter]}}


def _finance_valid_customer_id_filter() -> Dict[str, Any]:
    return {
        "bool": {
            "should": [
                {"prefix": {"customer_id": "CUST"}},
                {"prefix": {"customer_id.keyword": "CUST"}},
                {"prefix": {"id": "CUST"}},
                {"prefix": {"id.keyword": "CUST"}},
            ],
            "minimum_should_match": 1,
        }
    }


def _ensure_finance_customer_owner_access(
    request: Request,
    entity_type: str,
    source: Dict[str, Any],
) -> None:
    if str(entity_type or "").strip().lower() not in _FINANCE_CUSTOMER_ENTITIES:
        return
    owner_key = _get_finance_customer_owner_key(request, {})
    if not owner_key or not _finance_document_belongs_to_owner(source, owner_key):
        raise HTTPException(404, "Document not found")


def _prepare_finance_customer_document_identity(
    request: Request,
    entity_type: str,
    document: Dict[str, Any],
    doc_id: str,
) -> str:
    """Keep shared finance customer indexes account-safe.

    The customer panel stores all brokers in global customerdocument* indexes.
    Some clients generate deterministic ids from customer details; the same
    customer uploaded from two broker accounts can otherwise overwrite the first
    row, which makes account-scoped customer lists look empty or inconsistent.
    """
    if str(entity_type or "").strip().lower() not in _FINANCE_CUSTOMER_ENTITIES:
        return doc_id

    owner_key = _get_finance_customer_owner_key(request, document)
    if owner_key:
        document["broker_owner_key"] = owner_key
        if not str(document.get("created_by") or "").strip():
            document["created_by"] = owner_key
        if not str(document.get("created_by_id") or "").strip():
            document["created_by_id"] = owner_key
        if str(entity_type).lower() == "customerdocumentbatch":
            if not str(document.get("broker_email") or "").strip():
                document["broker_email"] = owner_key
        elif str(entity_type).lower() == "customerdocument":
            batch_id = str(document.get("batch_id") or "").strip()
            namespaced_batch_id = f"{owner_key}-{batch_id}" if batch_id else ""
            if batch_id and namespaced_batch_id:
                try:
                    batch_doc = request.app.state.db.client.get(
                        index="customerdocumentbatch",
                        id=batch_id,
                    )
                    batch_source = (
                        batch_doc.get("_source", {})
                        if isinstance(batch_doc, dict)
                        else {}
                    )
                    if not _finance_document_belongs_to_owner(
                        batch_source,
                        owner_key,
                    ):
                        request.app.state.db.client.get(
                            index="customerdocumentbatch",
                            id=namespaced_batch_id,
                        )
                        document["batch_id"] = namespaced_batch_id
                except NotFoundError:
                    pass
                except Exception as exc:
                    logger.warning(
                        "Unable to reconcile finance customer document batch_id=%s owner=%s: %s",
                        batch_id,
                        owner_key,
                        exc,
                    )

    resolved_doc_id = str(doc_id or "").strip() or str(uuid.uuid4())
    if not owner_key:
        return resolved_doc_id

    try:
        existing = request.app.state.db.client.get(
            index=entity_type,
            id=resolved_doc_id,
        )
        existing_source = (
            existing.get("_source", {}) if isinstance(existing, dict) else {}
        )
    except NotFoundError:
        return resolved_doc_id
    except Exception as exc:
        logger.warning(
            "Unable to check finance customer id collision entity=%s doc_id=%s: %s",
            entity_type,
            resolved_doc_id,
            exc,
        )
        return resolved_doc_id

    if _finance_document_belongs_to_owner(existing_source, owner_key):
        return resolved_doc_id

    namespaced_doc_id = f"{owner_key}-{resolved_doc_id}"
    document.setdefault("external_id", resolved_doc_id)
    logger.info(
        "Namespaced finance customer document id entity=%s original_id=%s owner=%s",
        entity_type,
        resolved_doc_id,
        owner_key,
    )
    return namespaced_doc_id


def _should_skip_customer_upload_document(
    entity_type: str, document: Dict[str, Any]
) -> tuple[bool, str]:
    entity = str(entity_type or "").strip().lower()

    if entity == "customerdocument":
        file_size_raw = document.get("file_size")
        file_size = _parse_int(file_size_raw) if file_size_raw is not None else None
        if file_size is not None and file_size <= 0:
            return True, "file_size <= 0"
        if _has_failed_status(document.get("status")):
            return True, "failed/broken document status"

    return False, ""


def _extract_total_hits(total: Any) -> int:
    if isinstance(total, dict):
        try:
            return int(total.get("value", 0))
        except Exception:
            return 0
    try:
        return int(total or 0)
    except Exception:
        return 0


def _extract_agg_value(aggs: Dict[str, Any], key: str) -> int:
    try:
        value = (aggs.get(key) or {}).get("value")
        if value is None:
            return 0
        return int(value)
    except Exception:
        return 0


def _normalize_username_for_usage(username: str) -> str:
    return "".join(ch for ch in username.strip().lower() if ch.isalnum())


def _normalize_domain_for_usage(username: str) -> str:
    parts = str(username or "").strip().lower().split("@", 1)
    if len(parts) != 2:
        return ""
    return "".join(ch for ch in parts[1] if ch.isalnum())


def _allowed_usage_identifiers(emails: set[str]) -> set[str]:
    identifiers: set[str] = set()
    for email in emails:
        raw_email = str(email or "").strip().lower()
        normalized_email = _normalize_username_for_usage(raw_email)
        if raw_email:
            identifiers.add(raw_email)
        if normalized_email:
            identifiers.add(normalized_email)
    return identifiers


def _usage_username_should_clauses(username: str) -> list[Dict[str, Any]]:
    raw_username = str(username or "").strip().lower()
    normalized_username = _normalize_username_for_usage(raw_username)
    clauses: list[Dict[str, Any]] = []
    if normalized_username:
        clauses.append({"term": {"username": normalized_username}})
    if raw_username and raw_username != normalized_username:
        clauses.append({"term": {"username": raw_username}})
    return clauses


def _usage_domain_should_clauses(username: str) -> list[Dict[str, Any]]:
    raw_username = str(username or "").strip().lower()
    normalized_domain = _normalize_domain_for_usage(raw_username)
    raw_domain = raw_username.split("@", 1)[1] if "@" in raw_username else ""
    clauses: list[Dict[str, Any]] = []
    if normalized_domain:
        clauses.append({"wildcard": {"username": f"*{normalized_domain}"}})
    if raw_domain and raw_domain != normalized_domain:
        clauses.append({"wildcard": {"username": f"*{raw_domain}"}})
    return clauses


async def _get_org_member_emails(request: Request, organization_id: str) -> list[str]:
    org_id = str(organization_id or "").strip()
    if not org_id:
        return []

    client = request.app.state.db.client
    if not client.indices.exists(index="organizationuser"):
        return []

    query = {
        "size": 1000,
        "_source": ["user_email", "status"],
        "query": {
            "bool": {
                "must": [
                    {
                        "bool": {
                            "should": [
                                {"term": {"organization_id": org_id}},
                                {"term": {"organization_id.keyword": org_id}},
                                {"match_phrase": {"organization_id": org_id}},
                            ],
                            "minimum_should_match": 1,
                        }
                    }
                ]
            }
        },
    }

    response = request.app.state.db._run_search("organizationuser", query)
    hits = response.get("hits", []) if isinstance(response, dict) else []
    emails: list[str] = []
    for hit in hits:
        source = hit.get("_source", {}) if isinstance(hit, dict) else {}
        if not isinstance(source, dict):
            continue
        email = str(source.get("user_email") or "").strip().lower()
        status = str(source.get("status") or "").strip().lower()
        if email and status != "disabled" and email not in emails:
            emails.append(email)
    return emails


def _classify_usage_provider(
    model_name: str, framework: str | None = None
) -> tuple[str, str]:
    value = str(model_name or "").strip().lower()
    runtime = str(framework or "").strip().lower()

    if runtime in {"openai", "azure_openai"}:
        return "OpenAI", "OpenAI"
    if runtime in {"gemini", "google"}:
        return "Gemini", "Gemini"
    if runtime in {"anthropic", "claude"}:
        return "Claude", "Claude"
    if runtime == "ollama":
        return "Ollama", "OpenAI"
    if runtime == "sglang":
        return "SGLang", "OpenAI"
    if runtime == "nvidia":
        return "Nvidia", "OpenAI"

    if (
        value.startswith("openai/")
        or value.startswith("gpt")
        or value.startswith("o1")
        or value.startswith("o3")
        or value.startswith("o4")
        or value.startswith("codex")
    ):
        return "OpenAI", "OpenAI"
    if value.startswith("gemini") or value.startswith("google/") or "gemini" in value:
        return "Gemini", "Gemini"
    if (
        value.startswith("claude")
        or value.startswith("anthropic/")
        or "claude" in value
    ):
        return "Claude", "Claude"
    if (
        value.startswith("nvidia/")
        or value.startswith("ollama/")
        or value.startswith("sglang/")
    ):
        return value.split("/", 1)[0].capitalize(), "OpenAI"

    if "/" in value:
        prefix = value.split("/", 1)[0]
        if prefix == "openai":
            return "OpenAI", "OpenAI"
        if prefix in {"google", "gemini"}:
            return "Gemini", "Gemini"
        if prefix in {"anthropic", "claude"}:
            return "Claude", "Claude"
        if prefix in {"nvidia", "ollama", "sglang"}:
            return prefix.capitalize(), "OpenAI"

    return "OpenAI", "OpenAI"


_PROVIDER_DEFAULT_PRICING = {
    "OpenAI": {"input": 2.50, "cached_input": 1.25, "output": 10.00},
    "Gemini": {"input": 1.25, "cached_input": 0.125, "output": 10.00},
    "Claude": {"input": 3.00, "cached_input": 3.00, "output": 15.00},
}

_MODEL_PRICING = {
    "openai/gpt-4o": {"input": 2.50, "cached_input": 1.25, "output": 10.00},
    "openai/gpt-4.1": {"input": 2.00, "cached_input": 0.50, "output": 8.00},
    "openai/gpt-4o-mini": {"input": 0.15, "cached_input": 0.075, "output": 0.60},
    "openai/gpt-4.1-mini": {"input": 0.40, "cached_input": 0.10, "output": 1.60},
    "gemini-2.5-pro": {"input": 1.25, "cached_input": 0.125, "output": 10.00},
    "gemini-2.5-flash": {"input": 0.30, "cached_input": 0.075, "output": 2.50},
    "gemini-2.5-flash-lite": {"input": 0.10, "cached_input": 0.025, "output": 0.40},
    "claude-sonnet-4": {"input": 3.00, "cached_input": 3.00, "output": 15.00},
    "claude-opus-4": {"input": 15.00, "cached_input": 15.00, "output": 75.00},
    "claude-3-7-sonnet": {"input": 3.00, "cached_input": 3.00, "output": 15.00},
}


def _get_model_pricing(
    model_name: str, framework: str | None = None
) -> tuple[str, str, Dict[str, float]]:
    actual_provider, pricing_provider = _classify_usage_provider(model_name, framework)
    normalized = str(model_name or "").strip().lower()

    for key, pricing in _MODEL_PRICING.items():
        if normalized == key or normalized.startswith(f"{key}-"):
            return actual_provider, pricing_provider, pricing

    return (
        actual_provider,
        pricing_provider,
        _PROVIDER_DEFAULT_PRICING[pricing_provider],
    )


def _estimate_usage_cost_usd(
    *,
    model_name: str,
    framework: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    prompt_cached_tokens: int,
    prompt_audio_tokens: int,
    completion_audio_tokens: int,
) -> float:
    _actual_provider, _pricing_provider, pricing = _get_model_pricing(
        model_name, framework
    )

    cached_input_tokens = max(int(prompt_cached_tokens or 0), 0)
    audio_input_tokens = max(int(prompt_audio_tokens or 0), 0)
    audio_output_tokens = max(int(completion_audio_tokens or 0), 0)
    total_input_tokens = max(int(prompt_tokens or 0), 0)
    total_output_tokens = max(int(completion_tokens or 0), 0)

    billable_input_tokens = max(
        total_input_tokens - cached_input_tokens - audio_input_tokens, 0
    )
    billable_output_tokens = max(total_output_tokens - audio_output_tokens, 0)

    estimated = 0.0
    estimated += (billable_input_tokens / 1_000_000) * pricing["input"]
    estimated += (cached_input_tokens / 1_000_000) * pricing["cached_input"]
    estimated += (audio_input_tokens / 1_000_000) * pricing["input"]
    estimated += (billable_output_tokens / 1_000_000) * pricing["output"]
    estimated += (audio_output_tokens / 1_000_000) * pricing["output"]
    return round(estimated, 6)


@router.get("/billing/token-usage-summary")
async def get_billing_token_usage_summary(
    request: Request,
    username: str = Query(..., min_length=1),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
):
    index_name = "llm_usage_monitoring"
    client = request.app.state.db.client
    current_user, _expires_at = await get_current_user_from_request(request)
    requested_email = str(username or "").strip().lower()
    current_email = str((current_user or {}).get("email") or "").strip().lower()
    current_org_id = str((current_user or {}).get("organization_id") or "").strip()
    current_org_user = await _get_current_org_user(request)
    is_owner_request = _normalize_org_user_role(
        (current_org_user or {}).get("role")
    ) == ("owner")

    allowed_emails = {current_email} if current_email else set()
    if is_owner_request and current_org_id:
        allowed_emails.update(await _get_org_member_emails(request, current_org_id))

    allowed_usage_identifiers = _allowed_usage_identifiers(allowed_emails)
    if requested_email not in allowed_usage_identifiers:
        raise HTTPException(
            status_code=403,
            detail="Permission denied: you can only view billing usage for yourself or members of your organization.",
        )

    # Token usage is now written with a sanitized username key, so billing
    # aggregation should query the same canonical form.
    normalized_username = _normalize_username_for_usage(username)
    normalized_domain = _normalize_domain_for_usage(username)

    try:
        if not client.indices.exists(index=index_name):
            return {
                "username": username,
                "normalized_username": normalized_username,
                "period": {"start_date": start_date, "end_date": end_date},
                "totals": {
                    "total_tokens": 0,
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "prompt_cached_tokens": 0,
                    "completion_reasoning_tokens": 0,
                    "prompt_audio_tokens": 0,
                    "completion_audio_tokens": 0,
                    "requests": 0,
                },
                "provider_summary": [],
                "domain_summary": {
                    "domain": _normalize_domain_for_usage(username),
                    "total_tokens": 0,
                    "requests": 0,
                    "user_token_share_percentage": 0.0,
                },
                "top_models": [],
            }

        username_clauses = _usage_username_should_clauses(username)
        filters: list[Dict[str, Any]] = []
        if username_clauses:
            filters.append(
                {
                    "bool": {
                        "should": username_clauses,
                        "minimum_should_match": 1,
                    }
                }
            )
        if start_date or end_date:
            range_filter: Dict[str, Any] = {}
            if start_date:
                range_filter["gte"] = start_date
            if end_date:
                # Treat the selected end date as inclusive by querying strictly
                # before the next day instead of only up to midnight.
                end_of_range = (
                    datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
                ).strftime("%Y-%m-%d")
                range_filter["lt"] = end_of_range
            filters.append({"range": {"timestamp": range_filter}})

        query = {
            "size": 0,
            "query": {"bool": {"filter": filters}},
            "aggs": {
                "total_tokens": {"sum": {"field": "total_tokens"}},
                "prompt_tokens": {"sum": {"field": "prompt_tokens"}},
                "completion_tokens": {"sum": {"field": "completion_tokens"}},
                "prompt_cached_tokens": {"sum": {"field": "prompt_cached_tokens"}},
                "completion_reasoning_tokens": {
                    "sum": {"field": "completion_reasoning_tokens"}
                },
                "prompt_audio_tokens": {"sum": {"field": "prompt_audio_tokens"}},
                "completion_audio_tokens": {
                    "sum": {"field": "completion_audio_tokens"}
                },
                "models": {
                    "terms": {
                        "field": "model",
                        "size": 100,
                        "order": {"_count": "desc"},
                    },
                    "aggs": {
                        "total_tokens": {"sum": {"field": "total_tokens"}},
                        "prompt_tokens": {"sum": {"field": "prompt_tokens"}},
                        "completion_tokens": {"sum": {"field": "completion_tokens"}},
                        "prompt_cached_tokens": {
                            "sum": {"field": "prompt_cached_tokens"}
                        },
                        "prompt_audio_tokens": {
                            "sum": {"field": "prompt_audio_tokens"}
                        },
                        "completion_audio_tokens": {
                            "sum": {"field": "completion_audio_tokens"}
                        },
                        # Older llm_usage_monitoring indices may have framework
                        # mapped as text instead of keyword. Read one sample
                        # source document per model bucket instead of aggregating
                        # on framework so mixed historical mappings still work.
                        "framework_sample": {
                            "top_hits": {
                                "size": 1,
                                "_source": {"includes": ["framework"]},
                            }
                        },
                    },
                },
            },
        }

        domain_summary = {
            "domain": normalized_domain,
            "total_tokens": 0,
            "requests": 0,
            "user_token_share_percentage": 0.0,
        }
        domain_clauses = _usage_domain_should_clauses(username)
        if domain_clauses:
            domain_filters = list(filters)
            if domain_filters:
                domain_filters[0] = {
                    "bool": {
                        "should": domain_clauses,
                        "minimum_should_match": 1,
                    }
                }
            else:
                domain_filters.append(
                    {
                        "bool": {
                            "should": domain_clauses,
                            "minimum_should_match": 1,
                        }
                    }
                )
            domain_query = {
                "size": 0,
                "query": {"bool": {"filter": domain_filters}},
                "aggs": {
                    "total_tokens": {"sum": {"field": "total_tokens"}},
                },
            }
            domain_response = client.search(index=index_name, body=domain_query)
            domain_total_tokens = _extract_agg_value(
                domain_response.get("aggregations", {}), "total_tokens"
            )
            domain_requests = _extract_total_hits(
                domain_response.get("hits", {}).get("total")
            )
            domain_summary = {
                "domain": normalized_domain,
                "total_tokens": domain_total_tokens,
                "requests": domain_requests,
                "user_token_share_percentage": 0.0,
            }

        response = client.search(index=index_name, body=query)
        aggs = response.get("aggregations", {})
        totals = {
            "total_tokens": _extract_agg_value(aggs, "total_tokens"),
            "prompt_tokens": _extract_agg_value(aggs, "prompt_tokens"),
            "completion_tokens": _extract_agg_value(aggs, "completion_tokens"),
            "prompt_cached_tokens": _extract_agg_value(aggs, "prompt_cached_tokens"),
            "completion_reasoning_tokens": _extract_agg_value(
                aggs, "completion_reasoning_tokens"
            ),
            "prompt_audio_tokens": _extract_agg_value(aggs, "prompt_audio_tokens"),
            "completion_audio_tokens": _extract_agg_value(
                aggs, "completion_audio_tokens"
            ),
            "requests": _extract_total_hits(response.get("hits", {}).get("total")),
        }
        logger.info(
            "Billing usage summary requested=%s normalized=%s owner=%s org=%s totals=%s range=%s..%s",
            requested_email,
            normalized_username,
            is_owner_request,
            current_org_id,
            totals,
            start_date,
            end_date,
        )

        provider_rollup = {
            "OpenAI": {
                "platform": "OpenAI",
                "pricing_basis": "OpenAI",
                "requests": 0,
                "total_tokens": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "approx_cost_usd": 0.0,
                "source_platforms": set(),
                "models": [],
            },
            "Gemini": {
                "platform": "Gemini",
                "pricing_basis": "Gemini",
                "requests": 0,
                "total_tokens": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "approx_cost_usd": 0.0,
                "source_platforms": set(),
                "models": [],
            },
            "Claude": {
                "platform": "Claude",
                "pricing_basis": "Claude",
                "requests": 0,
                "total_tokens": 0,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "approx_cost_usd": 0.0,
                "source_platforms": set(),
                "models": [],
            },
        }
        top_models = []

        for bucket in (aggs.get("models") or {}).get("buckets", []):
            model_name = bucket.get("key")
            requests_count = int(bucket.get("doc_count") or 0)
            total_tokens = _extract_agg_value(bucket, "total_tokens")
            prompt_tokens = _extract_agg_value(bucket, "prompt_tokens")
            completion_tokens = _extract_agg_value(bucket, "completion_tokens")
            prompt_cached_tokens = _extract_agg_value(bucket, "prompt_cached_tokens")
            prompt_audio_tokens = _extract_agg_value(bucket, "prompt_audio_tokens")
            completion_audio_tokens = _extract_agg_value(
                bucket, "completion_audio_tokens"
            )
            framework_hits = (
                (bucket.get("framework_sample") or {}).get("hits") or {}
            ).get("hits") or []
            framework = None
            if framework_hits:
                framework = ((framework_hits[0] or {}).get("_source") or {}).get(
                    "framework"
                )
            actual_provider, pricing_provider, _pricing = _get_model_pricing(
                model_name, framework
            )
            approx_cost = _estimate_usage_cost_usd(
                model_name=model_name,
                framework=framework,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                prompt_cached_tokens=prompt_cached_tokens,
                prompt_audio_tokens=prompt_audio_tokens,
                completion_audio_tokens=completion_audio_tokens,
            )

            top_models.append(
                {
                    "model": model_name,
                    "requests": requests_count,
                    "total_tokens": total_tokens,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "framework": framework,
                    "actual_platform": actual_provider,
                    "pricing_platform": pricing_provider,
                    "approx_cost_usd": approx_cost,
                }
            )

            provider_entry = provider_rollup[pricing_provider]
            provider_entry["requests"] += requests_count
            provider_entry["total_tokens"] += total_tokens
            provider_entry["prompt_tokens"] += prompt_tokens
            provider_entry["completion_tokens"] += completion_tokens
            provider_entry["approx_cost_usd"] += approx_cost
            provider_entry["source_platforms"].add(actual_provider)
            provider_entry["models"].append(model_name)

        total_estimated_cost = round(
            sum(item["approx_cost_usd"] for item in provider_rollup.values()), 6
        )
        if domain_summary["total_tokens"]:
            domain_summary["user_token_share_percentage"] = round(
                (totals["total_tokens"] / domain_summary["total_tokens"] * 100), 2
            )
        provider_summary = []
        for platform_name in ("OpenAI", "Gemini", "Claude"):
            item = provider_rollup[platform_name]
            provider_summary.append(
                {
                    "platform": item["platform"],
                    "pricing_basis": item["pricing_basis"],
                    "requests": item["requests"],
                    "total_tokens": item["total_tokens"],
                    "prompt_tokens": item["prompt_tokens"],
                    "completion_tokens": item["completion_tokens"],
                    "token_percentage": round(
                        (
                            (item["total_tokens"] / totals["total_tokens"] * 100)
                            if totals["total_tokens"]
                            else 0.0
                        ),
                        2,
                    ),
                    "cost_percentage": round(
                        (
                            (
                                item["total_tokens"]
                                / domain_summary["total_tokens"]
                                * 100
                            )
                            if domain_summary["total_tokens"]
                            else 0.0
                        ),
                        2,
                    ),
                    "approx_cost_usd": round(item["approx_cost_usd"], 6),
                    "source_platforms": sorted(item["source_platforms"]),
                    "models": item["models"][:10],
                }
            )

        top_models = sorted(
            top_models, key=lambda item: item["total_tokens"], reverse=True
        )[:10]

        return {
            "username": username,
            "normalized_username": normalized_username,
            "period": {"start_date": start_date, "end_date": end_date},
            "totals": {
                **totals,
                "approx_cost_usd": total_estimated_cost,
            },
            "provider_summary": provider_summary,
            "domain_summary": domain_summary,
            "top_models": top_models,
        }
    except Exception as exc:
        logger.exception("Failed to build billing token usage summary for %s", username)
        raise HTTPException(
            status_code=500, detail=f"Failed to load token usage summary: {exc}"
        )


def _normalize_workflow_document_for_mapping(
    request: Request, entity_type: str, document_body: Dict[str, Any]
) -> None:
    if entity_type.lower() not in ("workflow", "workflowtemplate"):
        return

    # Frontend may send nested/list fields as JSON strings. Parse them first so
    # newer object-friendly mappings receive structured data when possible.
    for key in (
        "agent_steps",
        "event_triggers",
        "placeholders",
        "tags",
        "schedule_config",
    ):
        value = document_body.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("[") or stripped.startswith("{"):
                try:
                    document_body[key] = json.loads(stripped)
                except Exception:
                    pass

    # Validate per-step processing scripts (syntax, run() signature, pin
    # format) at save time so broken scripts never reach a running workflow.
    steps = document_body.get("agent_steps")
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict) or not step.get(PROCESSING_SCRIPTS_KEY):
                continue
            try:
                normalize_scripts(step[PROCESSING_SCRIPTS_KEY])
            except ValueError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"Step {step.get('id') or step.get('agent_name')}: {exc}",
                ) from None
            raw_scripts = step[PROCESSING_SCRIPTS_KEY]
            if isinstance(raw_scripts, str):
                step[PROCESSING_SCRIPTS_KEY] = json.loads(raw_scripts)

    if entity_type.lower() == "workflow":
        raw_schedule = document_body.get("schedule")
        schedule_value = (
            str(raw_schedule).strip().lower() if raw_schedule is not None else None
        )
        config = document_body.get("schedule_config")
        has_schedule_config = isinstance(config, dict)
        has_cron = (
            bool(str(config.get("cron_expression") or "").strip())
            if has_schedule_config
            else False
        )

        if schedule_value in _WORKFLOW_OFF_SCHEDULE_VALUES:
            document_body["schedule"] = "off"
            if has_schedule_config:
                document_body["schedule_config"] = {**config, "enabled": False}
            else:
                document_body["schedule_config"] = {"enabled": False}
        elif has_schedule_config and not _workflow_config_enabled(
            config.get("enabled"), default=True
        ):
            document_body["schedule"] = "off"
        elif has_schedule_config and has_cron:
            document_body["schedule_config"] = {**config, "enabled": True}
            if not schedule_value:
                document_body["schedule"] = "auto"
        elif schedule_value == "auto":
            document_body["schedule"] = "off"
            if has_schedule_config:
                document_body["schedule_config"] = {**config, "enabled": False}
            else:
                document_body["schedule_config"] = {"enabled": False}
        elif (
            "schedule" not in document_body
            and "schedule_config" not in document_body
            and "trigger_type" in document_body
        ):
            document_body["schedule"] = "off"
            document_body["schedule_config"] = {"enabled": False}

    # Some environments still have older mappings where workflow fields were
    # created as keyword/text. In that case stringify only the affected fields
    # so workflow saves keep working without forcing an immediate reindex.
    try:
        mapping = request.app.state.db.client.indices.get_mapping(
            index=entity_type.lower()
        )
        props = (
            mapping.get(entity_type.lower(), {})
            .get("mappings", {})
            .get("properties", {})
        )

        for key, value in list(document_body.items()):
            if isinstance(value, (dict, list)):
                field_type = (props.get(key) or {}).get("type")
                if field_type in ("text", "keyword"):
                    document_body[key] = json.dumps(value)

        step_props = (props.get("agent_steps") or {}).get("properties") or {}
        connections_type = (step_props.get("connections") or {}).get("type")
        if connections_type in ("text", "keyword"):
            steps = document_body.get("agent_steps")
            if isinstance(steps, list):
                for step in steps:
                    if not isinstance(step, dict):
                        continue
                    connections = step.get("connections")
                    if isinstance(connections, (dict, list)):
                        step["connections"] = json.dumps(connections)
    except Exception:
        # Best effort only; don't block workflow saves on mapping lookup issues.
        pass


def _sync_batch_total_documents(
    request: Request, batch_id: str | None, owner_key: str | None = None
) -> None:
    resolved_batch_id = str(batch_id or "").strip()
    if not resolved_batch_id:
        return

    client = request.app.state.db.client
    normalized_owner_key = str(owner_key or "")
    batch_ids = [resolved_batch_id]
    namespaced_batch_id = (
        f"{normalized_owner_key}-{resolved_batch_id}" if normalized_owner_key else ""
    )
    if namespaced_batch_id and namespaced_batch_id not in batch_ids:
        batch_ids.append(namespaced_batch_id)
    batch_filter = {
        "bool": {
            "should": [
                {"terms": {"batch_id": batch_ids}},
                {"terms": {"batch_id.keyword": batch_ids}},
            ],
            "minimum_should_match": 1,
        }
    }
    owner_filter = _finance_owner_filter(normalized_owner_key)
    count_query = {
        "size": 0,
        "query": (
            {"bool": {"must": [batch_filter, owner_filter]}}
            if owner_filter
            else batch_filter
        ),
    }

    try:
        resp = client.search(index="customerdocument", body=count_query)
        total_docs = _extract_total_hits(resp.get("hits", {}).get("total"))
    except Exception as exc:
        logger.warning(
            "Failed to count customerdocument rows for batch_id=%s: %s",
            resolved_batch_id,
            exc,
        )
        return

    updated_at = datetime.utcnow().isoformat()
    update_body = {
        "doc": {"total_documents": total_docs, "updated_date": updated_at},
        "doc_as_upsert": False,
    }
    if not owner_filter:
        try:
            client.update(
                index="customerdocumentbatch",
                id=resolved_batch_id,
                body=update_body,
                refresh=True,
            )
            return
        except Exception:
            pass

    batch_update_must: list[Dict[str, Any]] = [
        {
            "bool": {
                "should": [
                    {"terms": {"id": batch_ids}},
                    {"terms": {"id.keyword": batch_ids}},
                    {"terms": {"external_id": batch_ids}},
                    {"terms": {"external_id.keyword": batch_ids}},
                ],
                "minimum_should_match": 1,
            }
        }
    ]
    if owner_filter:
        batch_update_must.append(owner_filter)

    try:
        client.update_by_query(
            index="customerdocumentbatch",
            body={
                "script": {
                    "source": "ctx._source.total_documents = params.total; ctx._source.updated_date = params.updated_date;",
                    "lang": "painless",
                    "params": {"total": total_docs, "updated_date": updated_at},
                },
                "query": {"bool": {"must": batch_update_must}},
            },
            refresh=True,
            conflicts="proceed",
        )
    except Exception as exc:
        logger.warning(
            "Failed to sync total_documents for batch_id=%s: %s",
            resolved_batch_id,
            exc,
        )


def _get_request_user_email(request: Request, payload: Dict[str, Any]) -> str | None:
    for key in ("userEmail", "user_email", "email", "created_by", "username"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()

    api_token_email = getattr(request.state, "api_token_authenticated_user_email", None)
    if isinstance(api_token_email, str) and api_token_email.strip():
        return api_token_email.strip()

    token = request.cookies.get("auth_token")
    if not token:
        return None
    try:
        decoded = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = decoded.get("email")
        if isinstance(email, str) and email.strip():
            return email.strip()
    except Exception:
        return None
    return None


def _get_authenticated_user_email(request: Request) -> str | None:
    api_token_email = getattr(request.state, "api_token_authenticated_user_email", None)
    if isinstance(api_token_email, str) and api_token_email.strip():
        return api_token_email.strip()

    token = request.cookies.get("auth_token")
    if not token:
        return None
    try:
        decoded = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = decoded.get("email")
        if isinstance(email, str) and email.strip():
            return email.strip()
    except Exception:
        return None
    return None


def _get_authenticated_user_context(
    request: Request,
) -> tuple[Dict[str, Any], str | None]:
    """Decode the session once for synchronous access-control helpers."""
    session_user = getattr(request.state, "authenticated_session_user", None)
    if isinstance(session_user, dict) and session_user:
        return dict(session_user), None
    api_token_payload = getattr(request.state, "api_token_payload", None)
    if isinstance(api_token_payload, dict) and api_token_payload:
        return {
            "email": getattr(request.state, "api_token_authenticated_user_email", ""),
            "organization_id": api_token_payload.get("organization_id"),
        }, None
    token = request.cookies.get("auth_token")
    if not token:
        return {}, None
    try:
        decoded = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return (decoded if isinstance(decoded, dict) else {}), None
    except Exception:
        return {}, None


def _tenant_organization_id(request: Request) -> str:
    context, _error = _get_authenticated_user_context(request)
    organization_id = str((context or {}).get("organization_id") or "").strip()
    if not organization_id:
        raise HTTPException(403, "Tenant context is required")
    return organization_id


def _index_uses_tenant_scope(request: Request, index_name: str) -> bool:
    """SECURITY: Detect tenant-aware mappings and fail closed on lookup errors."""
    try:
        mapping = request.app.state.db.client.indices.get_mapping(index=index_name)
    except NotFoundError:
        raise HTTPException(404, "Index not found")
    except Exception as exc:
        raise HTTPException(503, "Unable to verify tenant scope") from exc
    index_mapping = (mapping or {}).get(index_name) or next(
        iter((mapping or {}).values()), {}
    )
    properties = (index_mapping.get("mappings") or {}).get("properties") or {}
    return "organization_id" in properties


def _with_tenant_scope(
    request: Request, index_name: str, query: Dict[str, Any]
) -> Dict[str, Any]:
    """SECURITY: Inject the authenticated organization into generic searches."""
    if not _index_uses_tenant_scope(request, index_name):
        return query
    return {
        "bool": {
            "must": [query],
            "filter": [{"term": {"organization_id": _tenant_organization_id(request)}}],
        }
    }


def _ensure_document_tenant_scope(
    request: Request, index_name: str, source: Dict[str, Any]
) -> None:
    """SECURITY: Hide cross-tenant documents as not found."""
    if not _index_uses_tenant_scope(request, index_name):
        return
    if str(source.get("organization_id") or "").strip() != _tenant_organization_id(
        request
    ):
        raise HTTPException(404, "Document not found")


def _normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _coerce_feedback_rating(value: Any) -> int:
    try:
        if value is None or value == "":
            rating = 0
        else:
            rating = int(float(value))
    except Exception:
        rating = 0
    return max(0, min(5, rating))


def _safe_feedback_id(value: Any) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return f"feedback_{uuid.uuid4().hex}"
    safe = re.sub(r"[^A-Za-z0-9_.:-]+", "_", normalized).strip("_")
    return safe[:512] or f"feedback_{uuid.uuid4().hex}"


def _smart_doc_feedback_review_document(
    source: Dict[str, Any],
    doc_id: str,
    feedback_status: str,
    reviewer_email: str,
    review_comment: str,
    reviewed_at: str,
) -> Dict[str, Any]:
    document = {**source}
    document["id"] = str(document.get("id") or doc_id)
    document["question_id"] = str(document.get("question_id") or doc_id)
    document["feedback_status"] = feedback_status
    document["feedback_reviewed_by"] = reviewer_email
    document["feedback_review_comment"] = (
        review_comment if feedback_status == "rejected" else ""
    )
    document["feedback_approved_at"] = reviewed_at
    document["updated_at"] = reviewed_at
    document["updated_date"] = reviewed_at
    document["source_type"] = str(document.get("source_type") or "smart_doc")
    return document


async def _smart_doc_feedback_index_exists(request: Request, index_name: str) -> bool:
    return await asyncio.to_thread(
        request.app.state.db.client.indices.exists,
        index=index_name,
    )


async def _ensure_smart_doc_feedback_index(request: Request, index_name: str) -> None:
    if await _smart_doc_feedback_index_exists(request, index_name):
        return
    await asyncio.to_thread(request.app.state.db.create_index, index_name)


async def _existing_smart_doc_feedback_indexes(
    request: Request,
    candidates: tuple[str, ...],
) -> list[str]:
    existing = []
    for index_name in candidates:
        if await _smart_doc_feedback_index_exists(request, index_name):
            existing.append(index_name)
    return existing


async def _get_smart_doc_feedback_from_candidates(
    request: Request,
    candidates: tuple[str, ...],
    doc_id: str,
) -> tuple[str, Dict[str, Any]]:
    for index_name in candidates:
        try:
            source_doc = await asyncio.to_thread(
                request.app.state.db.client.get,
                index=index_name,
                id=doc_id,
            )
            return index_name, source_doc
        except NotFoundError:
            continue
    raise HTTPException(status_code=404, detail="Smart Doc feedback not found")


async def _delete_smart_doc_feedback_if_exists(
    request: Request,
    index_name: str,
    doc_id: str,
) -> None:
    try:
        await asyncio.to_thread(
            request.app.state.db.client.delete,
            index=index_name,
            id=doc_id,
            refresh=True,
        )
    except NotFoundError:
        return


async def _review_smart_doc_feedback_action(
    request: Request,
    feedback_id: str,
    feedback_status: str,
    reviewer_email: str | None,
    review_comment: str | None,
) -> Dict[str, Any]:
    await _ensure_entity_write_permission(
        request,
        _SMART_DOC_FEEDBACK_PENDING_INDEX,
        "review",
    )

    normalized_feedback_id = str(feedback_id or "").strip()
    if not normalized_feedback_id:
        raise HTTPException(status_code=400, detail="Feedback id is required")

    source_index, source_doc = await _get_smart_doc_feedback_from_candidates(
        request,
        REVIEW_FEEDBACK_PENDING_READ_INDEXES,
        normalized_feedback_id,
    )

    if feedback_status not in {"approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Invalid feedback review status")

    source = source_doc.get("_source", {}) if isinstance(source_doc, dict) else {}
    reviewed_at = datetime.utcnow().isoformat()
    reviewer = _normalize_email(
        reviewer_email or _get_authenticated_user_email(request)
    )
    comment = str(review_comment or "").strip()
    target_index = (
        _SMART_DOC_FEEDBACK_APPROVED_INDEX
        if feedback_status == "approved"
        else _SMART_DOC_FEEDBACK_REJECTED_INDEX
    )
    reviewed_document = _smart_doc_feedback_review_document(
        source,
        normalized_feedback_id,
        feedback_status,
        reviewer,
        comment,
        reviewed_at,
    )

    await _ensure_smart_doc_feedback_index(request, target_index)
    await asyncio.to_thread(
        request.app.state.db.client.index,
        index=target_index,
        id=normalized_feedback_id,
        body=reviewed_document,
        refresh=True,
    )

    opposite_indexes = (
        REVIEW_FEEDBACK_REJECTED_READ_INDEXES
        if feedback_status == "approved"
        else REVIEW_FEEDBACK_APPROVED_READ_INDEXES
    )
    for opposite_index in opposite_indexes:
        await _delete_smart_doc_feedback_if_exists(
            request,
            opposite_index,
            normalized_feedback_id,
        )

    await asyncio.to_thread(
        request.app.state.db.client.update,
        index=source_index,
        id=normalized_feedback_id,
        body={
            "doc": {
                "feedback_status": feedback_status,
                "feedback_reviewed_by": reviewer,
                "feedback_review_comment": (
                    comment if feedback_status == "rejected" else ""
                ),
                "feedback_approved_at": reviewed_at,
                "updated_at": reviewed_at,
                "updated_date": reviewed_at,
            }
        },
        refresh=True,
    )

    logger.info(
        "Feedback review migrated id=%s source_index=%s target_index=%s status=%s",
        normalized_feedback_id,
        source_index,
        target_index,
        feedback_status,
    )

    return {
        "id": normalized_feedback_id,
        "status": feedback_status,
        "reviewed_at": reviewed_at,
        "reviewed_by": reviewer,
        "review_comment": comment,
        "target_index": target_index,
        "source_index": source_index,
        "feedback": reviewed_document,
    }


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "on"}
    return bool(value)


def _sync_api_keys_to_chatui_config(request: Request, document: Dict[str, Any]) -> None:
    category = document.get("category")
    if category != "api_keys":
        return

    key_name = str(document.get("key", "")).strip().upper()
    key_value = decrypt_secret_if_encrypted(document.get("value", ""))
    if not key_name or not key_value:
        return

    key_map = {
        "OPENAI_API_KEY": "openai_key",
        "AZURE_AI_FOUNDRY_API_KEY": "openai_key",
        "NVIDIA_API_KEY": "nvidia_key",
        "GOOGLE_AI_API_KEY": "gemini_key",
        "SGLANG_API_KEY": "sglang_key",
        "HUGGINGFACE_API_KEY": "huggingface_key",
        "HUGGINGFACE_API_TOKEN": "huggingface_key",
        "HF_TOKEN": "huggingface_key",
    }
    chatui_field = key_map.get(key_name)
    if not chatui_field:
        return

    user_email = _get_request_user_email(request, document)
    if not user_email:
        return

    user_id = remove_special_characters(user_email).lower().strip()
    payload = {
        "doc_id": user_id,
        "created_by": user_id,
        chatui_field: encrypt_secret(key_value),
    }
    request.app.state.db.add_digihuman_chatui_config_data([payload])


def _decrypt_sensitive_response_document(
    entity_type: str, document: Dict[str, Any]
) -> Dict[str, Any]:
    if not isinstance(document, dict):
        return document

    normalized_entity_type = str(entity_type or "").strip().lower()
    response_document = deepcopy(document)

    if normalized_entity_type == "tool":
        return decrypt_sensitive_tool_parameters(response_document)

    if normalized_entity_type == "datasource":
        config = response_document.get("config")
        if isinstance(config, dict) and config.get("zetaris_api_key"):
            config["zetaris_api_key"] = "***MASKED***"
        return response_document

    if normalized_entity_type in {"systemconfig", "system_config"}:
        response_document["value"] = decrypt_sensitive_system_config_value(
            response_document
        )
        return response_document

    if normalized_entity_type in {
        "gitbackupconfig",
        "git_backup_config",
        "gitbackupschedule",
        "git_backup_schedule",
    }:
        # The GitHub credential is only needed by the version-control service.
        # Never expose persisted ciphertext (or plaintext) to the UI.
        for field in ("github_token", "api_token"):
            if field in response_document:
                response_document[field] = "***MASKED***"
        return response_document

    return response_document


def _source_for_response(entity_type: str, source: Dict[str, Any]) -> Dict[str, Any]:
    response = _decrypt_sensitive_response_document(entity_type, source)
    # Clause Library embeddings belong to the OpenSearch datasource, but are
    # internal retrieval data—not payload for the editor/library UI.
    if str(entity_type or "").strip().lower() == "clause":
        response.pop("vector_field", None)
        response.pop("vector_fingerprint", None)
        response.pop("clause_vector_fingerprint", None)
    return response


def _attach_datasource_names_to_indexes(db, items: list[Dict[str, Any]]) -> None:
    """Expose only the parent datasource name for grouping index metadata."""
    datasource_ids = list(
        dict.fromkeys(
            str(item.get("datasource_id") or "").strip()
            for item in items
            if str(item.get("datasource_id") or "").strip()
            and not str(item.get("datasource_name") or "").strip()
        )
    )
    if not datasource_ids:
        return

    try:
        hits = db._run_search(
            "datasource",
            {
                "size": max(100, len(datasource_ids)),
                "_source": ["id", "name"],
                "query": {
                    "bool": {
                        "should": [
                            {"terms": {"_id": datasource_ids}},
                            {"terms": {"id.keyword": datasource_ids}},
                            {"terms": {"id": datasource_ids}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            },
        ).get("hits", [])
    except Exception:
        return

    datasource_names = {}
    for hit in hits:
        source = hit.get("_source", {}) or {}
        datasource_name = str(source.get("name") or "").strip()
        if not datasource_name:
            continue
        for datasource_id in [hit.get("_id"), source.get("id")]:
            normalized_id = str(datasource_id or "").strip()
            if normalized_id:
                datasource_names[normalized_id] = datasource_name
    for item in items:
        datasource_name = datasource_names.get(
            str(item.get("datasource_id") or "").strip()
        )
        if datasource_name:
            item["datasource_name"] = datasource_name


def _attach_live_document_counts_to_indexes(db, items: list[Dict[str, Any]]) -> None:
    """Attach live OpenSearch document counts without issuing one call per index."""
    if not items:
        return
    try:
        index_stats = db.client.cat.indices(
            format="json",
            h="index,docs.count",
        )
    except Exception:
        return

    live_counts = {}
    for row in index_stats or []:
        index_name = str(row.get("index") or "").strip()
        if not index_name:
            continue
        try:
            live_counts[index_name] = int(row.get("docs.count") or 0)
        except (TypeError, ValueError):
            continue

    for item in items:
        logical_name = str(item.get("index_name") or "").strip()
        physical_name = str(item.get("physical_index_name") or "").strip()
        created_by = (
            remove_special_characters(str(item.get("created_by") or "")).lower().strip()
        )
        generated_name = (
            f"{created_by}_{logical_name}" if created_by and logical_name else ""
        )
        for candidate in [physical_name, generated_name, logical_name]:
            if candidate and candidate in live_counts:
                item["document_count"] = live_counts[candidate]
                break


def _queue_api_console_initial_refresh(
    request: Request, document: Dict[str, Any]
) -> None:
    datasource_id = str(document.get("id") or "").strip()
    if (
        str(document.get("type") or "").strip().lower() != "rest_oauth_api"
        or not datasource_id
    ):
        return

    async def _run_initial_refresh():
        try:
            await execute_datasource_sync(
                db=request.app.state.db,
                datasource_id=datasource_id,
                source=document,
                api_config=document.get("api_config", {}),
                force_run=True,
            )
            logger.info(
                "API Console datasource initial refresh completed datasource_id=%s",
                datasource_id,
            )
        except Exception:
            logger.exception(
                "API Console datasource initial refresh failed datasource_id=%s",
                datasource_id,
            )

    asyncio.create_task(_run_initial_refresh())
    logger.info(
        "API Console datasource initial refresh queued datasource_id=%s",
        datasource_id,
    )


@router.get("/op_health")
async def health_check(request: Request):
    return request.app.state.db.health_check()


@router.post("/custom_op_health")
async def health_check_temp(
    host: str = Body(...),
    port: int = Body(9200),
    username: str = Body(...),
    password: str = Body(...),
    use_ssl: bool = Body(True),
):

    port = int(os.getenv("OPENSEARCH_PORT", "9200"))
    db_temp = OpenSearchDB(host, port, username, password, use_ssl)
    try:
        result = db_temp.health_check()
        return result
    finally:
        db_temp.client.close()


@router.post("/finance-broker/validation-feedback")
async def save_finance_broker_validation_feedback(
    request: Request,
    payload: Dict[str, Any] = Body(...),
):
    """Persist finance broker validation feedback in OpenSearch."""
    current_user_email = _normalize_email(_get_authenticated_user_email(request))
    if not current_user_email:
        raise HTTPException(status_code=401, detail="Authentication required")
    shared_context = await resolve_finance_shared_headers(
        request,
        expected_actions={"feedback"},
    )

    raw_feedback_key = str(payload.get("feedback_key") or "").strip()
    validation_fingerprint = str(
        payload.get("validation_fingerprint") or payload.get("fingerprint") or ""
    ).strip()
    batch_id = str(payload.get("batch_id") or "").strip()
    if shared_context:
        if batch_id != shared_context["batch_id"]:
            raise HTTPException(403, "Shared feedback targets a different customer")
    customer_id = str(payload.get("customer_id") or "").strip()
    customer_name = str(payload.get("customer_name") or "").strip()
    broker_email = _normalize_email(
        shared_context["owner_email"]
        if shared_context
        else payload.get("broker_email") or current_user_email
    )
    rating = _coerce_feedback_rating(payload.get("rating"))
    comment = str(payload.get("comment") or "").strip()

    if rating <= 0 or not comment:
        raise HTTPException(
            status_code=400,
            detail="A rating and comment are required",
        )

    feedback_key = raw_feedback_key or ":".join(
        part
        for part in (
            broker_email,
            customer_id,
            batch_id,
            validation_fingerprint,
        )
        if part
    )
    doc_id = _safe_feedback_id(
        f"{feedback_key}:{current_user_email}:{datetime.utcnow().isoformat()}:{uuid.uuid4().hex}"
    )
    now = datetime.utcnow().isoformat()

    document = {
        "id": doc_id,
        "question_id": doc_id,
        "feedback_key": feedback_key,
        "feedback_scope": "finance_broker_validation",
        "rating": rating,
        "stars": rating,
        "comment": comment,
        "feedbackGiven": comment,
        "validation_fingerprint": validation_fingerprint,
        "customer_id": customer_id,
        "customer_name": customer_name,
        "batch_id": batch_id,
        "broker_email": broker_email,
        "gmailLoggedUser": broker_email,
        "created_by": current_user_email,
        "updated_by": current_user_email,
        "created_at": now,
        "updated_at": now,
        "currentTimestamp": now,
        "created_date": now,
        "updated_date": now,
        "feedback_status": "pending",
        "feedback_reviewed_by": "",
        "feedback_review_comment": "",
        "feedback_approved_at": None,
        "source": "finance_broker_documents",
        "source_type": "smart_doc",
    }
    validation_result = payload.get("validation_result")
    if isinstance(validation_result, dict):
        document["validation_result"] = validation_result
    summary = payload.get("summary")
    if isinstance(summary, dict):
        document["summary"] = summary
    extra_context = payload.get("context")
    if isinstance(extra_context, dict):
        document["context"] = extra_context

    success = await asyncio.to_thread(
        request.app.state.db.index_document,
        _SMART_DOC_FEEDBACK_PENDING_INDEX,
        doc_id,
        document,
    )
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save feedback")

    return {
        "id": doc_id,
        "index": _SMART_DOC_FEEDBACK_PENDING_INDEX,
        "feedback": document,
    }


@router.get("/finance-broker/validation-feedback")
async def list_finance_broker_validation_feedback(
    request: Request,
    customer_id: str = Query(default=""),
    customer_name: str = Query(default=""),
    batch_id: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
):
    """Return feedback history for the logged-in user and customer."""
    current_user_email = _normalize_email(_get_authenticated_user_email(request))
    if not current_user_email:
        raise HTTPException(status_code=401, detail="Authentication required")
    shared_context = await resolve_finance_shared_headers(
        request,
        expected_actions={"feedback"},
    )
    normalized_batch_id = str(batch_id or "").strip()
    if shared_context and normalized_batch_id != shared_context["batch_id"]:
        raise HTTPException(403, "Shared feedback targets a different customer")
    feedback_owner_email = (
        shared_context["owner_email"] if shared_context else current_user_email
    )

    index_name = _SMART_DOC_FEEDBACK_PENDING_INDEX
    try:
        if not await request.app.state.db.async_check_index_exists(index_name):
            return {"items": [], "total": 0}
    except Exception:
        logger.exception("Failed checking smart doc feedback index")
        return {"items": [], "total": 0}

    normalized_customer_id = str(customer_id or "").strip()
    normalized_customer_name = str(customer_name or "").strip()
    must: list[dict[str, Any]] = [
        {
            "bool": {
                "should": [
                    {"term": {"feedback_scope.keyword": "finance_broker_validation"}},
                    {"term": {"feedback_scope": "finance_broker_validation"}},
                    {"match_phrase": {"feedback_scope": "finance_broker_validation"}},
                ],
                "minimum_should_match": 1,
            }
        },
        {
            "bool": {
                "should": [
                    {"term": {"broker_email.keyword": feedback_owner_email}},
                    {"term": {"broker_email": feedback_owner_email}},
                    {"match_phrase": {"broker_email": feedback_owner_email}},
                    {"term": {"created_by.keyword": feedback_owner_email}},
                    {"term": {"created_by": feedback_owner_email}},
                    {"match_phrase": {"created_by": feedback_owner_email}},
                ],
                "minimum_should_match": 1,
            }
        },
    ]
    should: list[dict[str, Any]] = []
    if normalized_batch_id:
        must.append(
            {
                "bool": {
                    "should": [
                        {"term": {"batch_id.keyword": normalized_batch_id}},
                        {"term": {"batch_id": normalized_batch_id}},
                        {"match_phrase": {"batch_id": normalized_batch_id}},
                    ],
                    "minimum_should_match": 1,
                }
            }
        )
    if normalized_customer_id:
        should.extend(
            [
                {"term": {"customer_id.keyword": normalized_customer_id}},
                {"term": {"customer_id": normalized_customer_id}},
                {"match_phrase": {"customer_id": normalized_customer_id}},
            ]
        )
    if normalized_customer_name:
        should.extend(
            [
                {"term": {"customer_name.keyword": normalized_customer_name}},
                {"term": {"customer_name": normalized_customer_name}},
                {"match_phrase": {"customer_name": normalized_customer_name}},
            ]
        )

    bool_query: dict[str, Any] = {"must": must}
    if should:
        bool_query["should"] = should
        bool_query["minimum_should_match"] = 1

    try:
        response = await request.app.state.db.async_search(
            index=index_name,
            body={
                "size": limit,
                "query": {"bool": bool_query},
                "sort": [{"created_at": {"order": "desc"}}],
            },
        )
    except Exception:
        logger.exception("Failed searching smart doc feedback")
        raise HTTPException(status_code=500, detail="Failed to load feedback")

    hits = response.get("hits", {}).get("hits", [])
    items = [
        {**(hit.get("_source") or {}), "_id": hit.get("_id")}
        for hit in hits
        if isinstance(hit, dict)
    ]
    total = response.get("hits", {}).get("total", 0)
    total_value = total.get("value", 0) if isinstance(total, dict) else total
    return {"items": items, "total": total_value}


@router.get("/smart-doc/feedback/pending")
async def list_smart_doc_feedback_approvals(
    request: Request,
    limit: int = Query(default=500, ge=1, le=1000),
):
    """Return Smart Doc feedback items for the Feedback Approvals page."""
    await _ensure_entity_write_permission(
        request,
        _SMART_DOC_FEEDBACK_PENDING_INDEX,
        "view",
    )

    pending_indexes = await _existing_smart_doc_feedback_indexes(
        request,
        REVIEW_FEEDBACK_PENDING_READ_INDEXES,
    )
    if not pending_indexes:
        return {"items": [], "total": 0}

    try:
        response = await asyncio.to_thread(
            request.app.state.db.client.search,
            index=",".join(pending_indexes),
            body={
                "size": limit,
                "query": {
                    "bool": {
                        "should": [
                            {"term": {"source_type.keyword": "smart_doc"}},
                            {"term": {"source_type": "smart_doc"}},
                            {"term": {"source_type.keyword": "contract_management"}},
                            {"term": {"source_type": "contract_management"}},
                            {
                                "term": {
                                    "feedback_scope.keyword": "finance_broker_validation"
                                }
                            },
                            {"term": {"feedback_scope": "finance_broker_validation"}},
                            {
                                "match_phrase": {
                                    "feedback_scope": "finance_broker_validation"
                                }
                            },
                            {"term": {"feedback_scope.keyword": "contract_management"}},
                            {"term": {"feedback_scope": "contract_management"}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
                "sort": [{"created_at": {"order": "desc", "unmapped_type": "date"}}],
            },
        )
    except Exception:
        logger.exception("Failed searching Smart Doc feedback approvals")
        raise HTTPException(status_code=500, detail="Failed to load feedback approvals")

    hits = response.get("hits", {}).get("hits", [])
    items_by_id = {}
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        feedback_id = str(hit.get("_id") or "")
        if feedback_id in items_by_id:
            continue
        items_by_id[feedback_id] = {
            **(hit.get("_source") or {}),
            "_id": feedback_id,
            "_index": hit.get("_index"),
        }
    items = list(items_by_id.values())
    logger.info(
        "Feedback migration read indexes=%s raw_hits=%s unique_hits=%s duplicates=%s",
        pending_indexes,
        len(hits),
        len(items),
        len(hits) - len(items),
    )
    return {"items": items, "total": len(items)}


@router.post("/smart-doc/feedback/{feedback_id}/approve")
async def approve_smart_doc_feedback(
    feedback_id: str,
    request: Request,
    payload: Dict[str, Any] | None = Body(default=None),
):
    payload = payload or {}
    return await _review_smart_doc_feedback_action(
        request,
        feedback_id,
        "approved",
        payload.get("reviewer_email"),
        payload.get("review_comment"),
    )


@router.post("/smart-doc/feedback/{feedback_id}/reject")
async def reject_smart_doc_feedback(
    feedback_id: str,
    request: Request,
    payload: Dict[str, Any] | None = Body(default=None),
):
    payload = payload or {}
    return await _review_smart_doc_feedback_action(
        request,
        feedback_id,
        "rejected",
        payload.get("reviewer_email"),
        payload.get("review_comment"),
    )


@router.post("/smart-doc/feedback/{feedback_id}/review")
async def review_smart_doc_feedback(
    feedback_id: str,
    request: Request,
    payload: Dict[str, Any] | None = Body(default=None),
):
    payload = payload or {}
    return await _review_smart_doc_feedback_action(
        request,
        feedback_id,
        str(payload.get("status") or "").strip().lower(),
        payload.get("reviewer_email"),
        payload.get("review_comment"),
    )


@router.delete("/smart-doc/feedback/{feedback_id}")
async def delete_smart_doc_feedback(feedback_id: str, request: Request):
    await _ensure_entity_write_permission(
        request,
        _SMART_DOC_FEEDBACK_PENDING_INDEX,
        "delete",
    )

    normalized_feedback_id = str(feedback_id or "").strip()
    if not normalized_feedback_id:
        raise HTTPException(status_code=400, detail="Feedback id is required")

    deleted = False
    for index_name in ALL_REVIEW_FEEDBACK_INDEXES:
        try:
            await asyncio.to_thread(
                request.app.state.db.client.delete,
                index=index_name,
                id=normalized_feedback_id,
                refresh=True,
            )
            deleted = True
        except NotFoundError:
            continue

    if not deleted:
        raise HTTPException(status_code=404, detail="Smart Doc feedback not found")

    return {"id": normalized_feedback_id, "deleted": True}


# @router.post("/documents/{entity_type}")
# async def create_document(entity_type: str, request: Dict[str, Any] = Body(...)):
#     # Extract actual document from "data" if present
#     document = request.get("data", request)

#     if entity_type not in ENTITY_TYPES:
#         raise HTTPException(404, "Invalid entity_type")

#     doc_id = document.get("id") or str(uuid.uuid4())
#     document["id"] = doc_id

#     success = request.app.state.db.index_document(entity_type, doc_id, document)
#     if not success:
#         raise HTTPException(500, "Failed to index document")

#     return {"id": doc_id, "indexed": success}


@router.post("/documents/{entity_type}")
async def create_document(
    request: Request, entity_type: str, request_data: Dict[str, Any] = Body(...)
):

    logger.info(
        "Received request to create document in %s with fields=%s",
        entity_type,
        sorted(request_data.keys()),
    )
    entity_type = _normalize_entity_type(entity_type)

    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")

    # Accept both {data: {...}} and plain {...}
    payload = request_data.get("data", request_data)

    # ←←←← THE FIX: Always extract the actual document ←←←←
    document = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(document, dict):
        raise HTTPException(400, "Invalid document payload")
    await _ensure_entity_write_permission(request, entity_type, "create", document)
    if entity_type == _CONTRACT_SHARE_ENTITY:
        document = await _prepare_resource_share_document(request, document)
    if entity_type in _PRIVATE_CONTRACT_ENTITIES:
        owner_email = _contract_owner_email(request)
        # Ownership is assigned from the session, never trusted from the client.
        document["owner_email"] = owner_email
        document["created_by"] = owner_email
        document["created_by_email"] = owner_email
        try:
            current_user, _expires_at = await get_current_user_from_request(request)
            if current_user.get("organization_id"):
                document["organization_id"] = current_user["organization_id"]
        except Exception:
            pass
        if entity_type in {"contract_version", "contractreview"}:
            parent_contract_id = str(document.get("contract_id") or "").strip()
            if parent_contract_id:
                try:
                    parent_doc = request.app.state.db.client.get(
                        index="contract", id=parent_contract_id
                    )
                except NotFoundError as exc:
                    raise HTTPException(404, "Parent contract not found") from exc
                parent_source = {
                    **(parent_doc.get("_source", {}) or {}),
                    "_id": parent_contract_id,
                }
                _ensure_contract_access(request, "contract", parent_source, "edit")
                if not _contract_document_belongs_to_owner(request, parent_source):
                    inherited_owner = next(
                        (
                            parent_source.get(field)
                            for field in _CONTRACT_OWNER_FIELDS
                            if parent_source.get(field)
                        ),
                        None,
                    )
                    if inherited_owner:
                        document["owner_email"] = inherited_owner
                        document["created_by"] = inherited_owner
                        document["created_by_email"] = inherited_owner
    shared_context = None
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions={"upload"},
        )
        _ensure_shared_entity_batch(
            entity_type,
            shared_context,
            document=document,
        )
        if shared_context and entity_type == "customerdocumentbatch":
            raise HTTPException(403, "Shared uploads must use the existing customer")

    # Clean reserved fields
    doc_id = document.pop("id", None) or str(uuid.uuid4())
    document.pop("_id", None)
    document.pop("indexed_at", None)
    is_new_organization_user = False
    if entity_type == "organizationuser":
        existing_document = _get_existing_organization_user_source(
            request,
            document.get("organization_id"),
            document.get("user_email"),
        )
        is_new_organization_user = existing_document is None
        document = _merge_organization_user_document(existing_document, document)
        await _ensure_owner_role_assignment_allowed(
            request,
            document,
            existing_document,
        )
        doc_id = _prepare_organization_user_identity(
            request,
            document,
            str(doc_id),
        )
    if entity_type == "evaluation":
        doc_id = _prepare_evaluation_identity(
            request,
            document,
            str(doc_id),
        )
    doc_id = _prepare_finance_customer_document_identity(
        request,
        entity_type,
        document,
        str(doc_id),
    )
    datasource_new_files: list[dict[str, Any]] = []
    if entity_type == "datasource":
        if _coerce_bool(document.get("shared")) and not document.get("shared_users"):
            raise HTTPException(
                400,
                "Select at least one user before sharing a datasource.",
            )

        # A new local-folder datasource creates a shell before its first file
        # upload. Saving that same datasource later uses this create endpoint
        # again, so retain event state written by the upload path instead of
        # replacing it with the client form state.
        try:
            existing_datasource_doc = request.app.state.db.client.get(
                index="datasource", id=doc_id
            )
            existing_datasource_source = (
                existing_datasource_doc.get("_source", {})
                if isinstance(existing_datasource_doc, dict)
                else {}
            )
        except NotFoundError:
            existing_datasource_source = {}
        except Exception as exc:
            raise HTTPException(
                500, f"Failed to load datasource document: {exc}"
            ) from exc

        incoming_config = document.get("config")
        datasource_type = str(document.get("type") or "").strip().lower()
        if isinstance(incoming_config, dict):
            (
                document["config"],
                datasource_new_files,
                _,
            ) = prepare_datasource_event_state(
                existing_datasource_source,
                incoming_config,
                datasource_type,
            )
            incoming_config = document["config"]
            if datasource_type == "zetaris" and _coerce_bool(
                incoming_config.get("use_api_credentials")
            ):
                current_user, _ = await get_current_user_from_request(request)
                email = str(current_user.get("email") or "").strip()
                saved_credentials = get_user_zetaris_api_credentials(
                    request.app.state.db, email
                )
                api_key = incoming_config.get("zetaris_api_key")
                if api_key in (None, "", "***MASKED***") and saved_credentials:
                    api_key = saved_credentials["zetaris_api_key"]
                org_id = str(incoming_config.get("zetaris_orgid") or "").strip()
                if not org_id and saved_credentials:
                    org_id = saved_credentials["zetaris_orgid"]
                if not api_key or not org_id:
                    raise HTTPException(
                        400,
                        "Zetaris API key and organization ID are required",
                    )
                incoming_config["zetaris_api_key"] = api_key
                incoming_config["zetaris_orgid"] = org_id
                save_user_zetaris_api_credentials(
                    request.app.state.db, email, api_key, org_id
                )

    if entity_type in {"agent", "tool"}:
        timestamp = datetime.utcnow().isoformat()
        document.setdefault("created_at", timestamp)
        document.setdefault("created_date", timestamp)
        document.setdefault("updated_at", timestamp)
        document.setdefault("updated_date", timestamp)

    should_skip, skip_reason = _should_skip_customer_upload_document(
        entity_type, document
    )
    if should_skip:
        if str(entity_type).lower() == "customerdocument":
            _sync_batch_total_documents(
                request,
                document.get("batch_id"),
                _get_finance_customer_owner_key(request, document),
            )
        logger.info(
            "Skipping index for %s doc_id=%s due to batch-upload guard: %s",
            entity_type,
            doc_id,
            skip_reason,
        )
        return {
            "id": doc_id,
            "indexed": False,
            "skipped": True,
            "reason": skip_reason,
        }

    document["id"] = doc_id
    if isinstance(document, dict):
        encrypt_sensitive_opensearch_document(entity_type, document)
    _normalize_workflow_document_for_mapping(request, entity_type, document)
    _clear_other_digihuman_drivers(request, entity_type, document, str(doc_id))

    success = request.app.state.db.index_document(entity_type, doc_id, document)
    if not success:
        logger.error(f"INDEXING FAILED FOR: {document}")
        raise HTTPException(500, "Failed to index document")

    if entity_type == "organizationuser" and is_new_organization_user:
        organization_id = str(document.get("organization_id") or "").strip()
        try:
            organization_record = request.app.state.db.client.get(
                index="organization",
                id=organization_id,
            )
            organization = (organization_record or {}).get("_source", {})
        except Exception as exc:
            logger.warning(
                "Unable to resolve organization owner for model inheritance org=%s: %s",
                organization_id,
                exc,
            )
            organization = {}
        inherit_owner_model_preferences(
            str(organization.get("owner_email") or ""),
            str(document.get("user_email") or ""),
            request.app.state.db,
        )

    if (
        entity_type == FINANCE_BROKER_VALIDATE_PROMPTS_ENTITY
        and str(doc_id) == FINANCE_BROKER_VALIDATE_PROMPTS_CONTAINER_ID
    ):
        sync_finance_broker_validate_prompt_container(
            request.app.state.db,
            index_name=entity_type,
            container_doc_id=str(doc_id),
            container_doc=document,
        )

    if str(entity_type).lower() == "customerdocument":
        _sync_batch_total_documents(
            request,
            document.get("batch_id"),
            _get_finance_customer_owner_key(request, document),
        )

    if entity_type in ("systemconfig", "system_config"):
        _sync_api_keys_to_chatui_config(request, document)

    # If datasource, add to scheduler
    if entity_type == "datasource":
        retention_service = IndexRetentionService(request.app.state.db)
        # Register datasource-owned index metadata immediately so a newly
        # created datasource can be deleted cleanly before its first sync.
        try:
            registration_result = (
                retention_service.ensure_datasource_index_registration(document)
            )
            logger.info(
                "Datasource index registration applied on create datasource_id=%s result=%s",
                doc_id,
                registration_result.get("status"),
            )
        except Exception as exc:
            logger.warning(
                "Failed datasource index registration on create datasource_id=%s: %s",
                doc_id,
                exc,
            )
        try:
            shared_sync_result = sync_opensearchindex_shared_state(
                request.app.state.db, document
            )
            logger.info(
                "Datasource shared state synced on create datasource_id=%s result=%s count=%s",
                doc_id,
                shared_sync_result.get("status"),
                shared_sync_result.get("updated_count"),
            )
        except Exception as exc:
            logger.warning(
                "Failed datasource shared sync on create datasource_id=%s: %s",
                doc_id,
                exc,
            )
        try:
            retention_result = retention_service.apply_retention_for_datasource(
                document
            )
            logger.info(
                "Datasource retention applied on create datasource_id=%s result=%s",
                doc_id,
                retention_result.get("status"),
            )
        except Exception as exc:
            logger.warning(
                "Failed to apply retention on datasource create datasource_id=%s: %s",
                doc_id,
                exc,
            )
        schedule_datasource(
            request.app.state.scheduler,
            request.app.state.db,
            request.app.state.datasource_event_producer,
            document,
        )
        _queue_api_console_initial_refresh(request, document)
        if datasource_new_files:
            await emit_datasource_new_file_event(
                request.app.state.datasource_event_producer,
                str(doc_id),
                datasource_new_files,
                document,
            )
    if entity_type == "workflow":
        schedule_workflow(
            request.app.state.scheduler,
            request.app.state.db,
            document,
            request.app.state.registry,
            request.app.state.producer,
        )
    return {"id": doc_id, "indexed": True}


@router.post(
    "/api/simulated-datasources/vacant-consumption/install",
    include_in_schema=False,
)
@router.post("/simulated-datasources/vacant-consumption/install")
async def install_origin_vc_simulation(
    request: Request, request_data: Dict[str, Any] | None = Body(default=None)
):
    """Install isolated synthetic retrieval indexes for the vacant-consumption blueprint."""

    await _ensure_entity_write_permission(request, "datasource", "create", {})
    owner_email = _normalize_email(_get_authenticated_user_email(request))
    if not owner_email:
        raise HTTPException(401, "Authentication is required")

    payload = request_data or {}
    name_prefix = str(payload.get("name_prefix") or "Vacant Consumption").strip()
    if len(name_prefix) > 80:
        raise HTTPException(400, "name_prefix must be 80 characters or fewer")

    try:
        return install_origin_vc_simulated_datasources(
            request.app.state.db,
            owner_email=owner_email,
            name_prefix=name_prefix,
        )
    except Exception as exc:
        logger.exception("Failed to install vacant-consumption simulated datasources")
        raise HTTPException(
            500, f"Failed to install vacant-consumption simulated datasources: {exc}"
        ) from exc


@router.post("/compliance-rule")
async def create_compliance_rule(
    request: Request, request_data: Dict[str, Any] = Body(...)
):
    logger.info(
        "Received request to create document in compliancerule: %s", request_data
    )

    payload = request_data.get("data", request_data)
    document = payload.get("data", payload) if isinstance(payload, dict) else payload

    doc_id = document.pop("id", None) or str(uuid.uuid4())
    document.pop("_id", None)
    document.pop("indexed_at", None)
    document["id"] = doc_id

    try:
        await request.app.state.db.async_index_document(
            "compliancerule",
            doc_id,
            document,
            refresh=True,
        )
    except Exception:
        logger.error("INDEXING FAILED FOR: %s", document)
        raise HTTPException(500, "Failed to index document")

    await sync_compliance_rule_csv(document)
    return {"id": doc_id, "indexed": True}


@router.delete("/documents/{entity_type}/{doc_id}")
async def delete_document(request: Request, entity_type: str, doc_id: str):
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    if entity_type not in _PRIVATE_CONTRACT_ENTITIES:
        await _ensure_entity_write_permission(request, entity_type, "delete")
    if entity_type == _CONTRACT_SHARE_ENTITY:
        try:
            existing_share = request.app.state.db.client.get(
                index=entity_type, id=doc_id
            )
        except NotFoundError as exc:
            raise HTTPException(404, "Share record not found") from exc
        if not _resource_share_owner_matches(
            request, existing_share.get("_source", {}) or {}
        ):
            raise HTTPException(404, "Share record not found")
    if entity_type in _PRIVATE_CONTRACT_ENTITIES:
        try:
            if entity_type == "contract":
                existing_contract_doc = await request.app.state.db.async_get_by_id(
                    entity_type, doc_id
                )
            else:
                existing_contract_doc = request.app.state.db.client.get(
                    index=entity_type, id=doc_id
                )
        except NotFoundError as exc:
            raise HTTPException(404, "Document not found") from exc
        except Exception as exc:
            raise HTTPException(
                500, f"Failed to load contract document: {exc}"
            ) from exc
        _ensure_contract_access(
            request,
            entity_type,
            {**(existing_contract_doc.get("_source", {}) or {}), "_id": doc_id},
            "admin",
        )
    shared_context = None
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        allowed_actions = (
            {"delete"}
            if entity_type == "customerdocumentbatch"
            else {
                "delete",
                "upload",
            }
        )
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions=allowed_actions,
        )
        existing_source = {}
        try:
            existing = request.app.state.db.client.get(index=entity_type, id=doc_id)
            existing_source = existing.get("_source", {}) or {}
        except NotFoundError:
            existing_source = {}
        _ensure_shared_entity_batch(
            entity_type,
            shared_context,
            doc_id=doc_id,
            existing_source=existing_source,
        )
    if entity_type in {"systemconfig", "system_config"}:
        try:
            existing_doc = request.app.state.db.client.get(index=entity_type, id=doc_id)
            existing_source = existing_doc.get("_source", {}) or {}
        except NotFoundError:
            existing_source = {}
        except Exception as exc:
            raise HTTPException(500, f"Failed to load system config document: {exc}")
        await _ensure_admin_owner_access_for_system_config(request, existing_source)

    if entity_type == "opensearchindex":
        client = request.app.state.db.client

        resolved_doc_id: str | None = None
        metadata: Dict[str, Any] | None = None
        try:
            resp = client.get(index="opensearchindex", id=doc_id)
            resolved_doc_id = doc_id
            metadata = resp.get("_source", {}) if isinstance(resp, dict) else {}
        except NotFoundError:
            try:
                search_resp = client.search(
                    index="opensearchindex",
                    body={
                        "_source": True,
                        "size": 1,
                        "query": {
                            "bool": {
                                "should": [
                                    {"term": {"id": doc_id}},
                                    {"term": {"id.keyword": doc_id}},
                                ],
                                "minimum_should_match": 1,
                            }
                        },
                    },
                )
                hits = (search_resp or {}).get("hits", {}).get("hits", [])
                if hits and isinstance(hits[0], dict):
                    resolved_doc_id = hits[0].get("_id")
                    metadata = hits[0].get("_source", {}) or {}
            except Exception:
                resolved_doc_id = None
                metadata = None
        except Exception as exc:
            raise HTTPException(500, f"Failed to load opensearchindex document: {exc}")

        if not resolved_doc_id or not isinstance(metadata, dict):
            raise HTTPException(404, "OpenSearch index metadata not found")

        index_name = str(metadata.get("index_name") or "").strip()
        owner_email = str(
            metadata.get("created_by")
            or metadata.get("owner_email")
            or metadata.get("user_email")
            or ""
        ).strip()
        index_deleted = False
        index_delete_skipped = False
        retention_cleanup = None

        if not index_name:
            logger.warning(
                "opensearchindex doc_id=%s missing index_name; deleting metadata only",
                resolved_doc_id,
            )
        elif index_name.startswith("."):
            index_delete_skipped = True
            logger.warning(
                "Refusing to delete system index '%s' for opensearchindex doc_id=%s; deleting metadata only",
                index_name,
                resolved_doc_id,
            )
        elif index_name in _PROTECTED_OPENSEARCH_INDEX_NAMES:
            index_delete_skipped = True
            logger.warning(
                "Refusing to delete protected index '%s' for opensearchindex doc_id=%s; deleting metadata only",
                index_name,
                resolved_doc_id,
            )
        else:
            try:
                retention_cleanup = IndexRetentionService(
                    request.app.state.db
                ).cleanup_registered_index_family(index_name, owner_email)
                index_deleted = bool(retention_cleanup.get("deleted_indices"))
            except Exception as exc:
                raise HTTPException(
                    500,
                    f"Failed to delete OpenSearch index family '{index_name}': {exc}",
                )

        if not request.app.state.db.delete_document("opensearchindex", resolved_doc_id):
            raise HTTPException(500, "Delete failed")

        return {
            "message": "Deleted",
            "id": doc_id,
            "metadata_doc_id": resolved_doc_id,
            "index_name": index_name or None,
            "index_deleted": index_deleted,
            "index_delete_skipped": index_delete_skipped,
            "retention_cleanup": retention_cleanup,
        }

    datasource_cleanup = None

    # Datasource requires cleanup in the scheduler.
    if entity_type == "datasource":
        client = request.app.state.db.client
        datasource_source = None
        try:
            resp = client.get(index="datasource", id=doc_id)
            datasource_source = (
                resp.get("_source", {}) if isinstance(resp, dict) else {}
            )
        except NotFoundError:
            raise HTTPException(404, "Datasource not found")
        except Exception as exc:
            raise HTTPException(500, f"Failed to load datasource document: {exc}")

        current_user_email = _get_authenticated_user_email(request)
        owner_email = _normalize_email(datasource_source.get("created_by"))
        if not current_user_email or owner_email != _normalize_email(
            current_user_email
        ):
            raise HTTPException(
                403, "Only the creator of this datasource can delete it."
            )

        # Best-effort removal; CustomScheduler handles missing jobs.
        unschedule_datasource(request.app.state.scheduler, doc_id)

        if isinstance(datasource_source, dict) and datasource_source:
            retention_service = IndexRetentionService(request.app.state.db)
            # Datasource deletion is driven by ownership metadata in
            # opensearchindex; delete every associated index family first.
            owner_email = str(
                datasource_source.get("created_by")
                or datasource_source.get("created_by_email")
                or datasource_source.get("user_email")
                or datasource_source.get("owner_email")
                or ""
            ).strip()
            ds_type = str(datasource_source.get("type") or "").strip().lower()
            config = (
                datasource_source.get("config")
                if isinstance(datasource_source.get("config"), dict)
                else {}
            )

            opensearchindex_hits = []
            try:
                search_resp = client.search(
                    index="opensearchindex",
                    body={
                        "_source": True,
                        "size": 100,
                        "query": {
                            "bool": {
                                "should": [
                                    {"term": {"datasource_id.keyword": doc_id}},
                                    {"term": {"datasource_id": doc_id}},
                                ],
                                "minimum_should_match": 1,
                            }
                        },
                    },
                )
                opensearchindex_hits = (
                    (search_resp or {}).get("hits", {}).get("hits", [])
                )
            except Exception:
                opensearchindex_hits = []

            if not opensearchindex_hits:
                fallback_index_name = (
                    retention_service.resolve_datasource_registered_index_name(
                        datasource_source
                    )
                )
                if fallback_index_name:
                    try:
                        search_resp = client.search(
                            index="opensearchindex",
                            body={
                                "_source": True,
                                "size": 100,
                                "query": {
                                    "bool": {
                                        "must": [
                                            {
                                                "bool": {
                                                    "should": [
                                                        {
                                                            "term": {
                                                                "index_name.keyword": fallback_index_name
                                                            }
                                                        },
                                                        {
                                                            "term": {
                                                                "index_name": fallback_index_name
                                                            }
                                                        },
                                                    ],
                                                    "minimum_should_match": 1,
                                                }
                                            },
                                            {
                                                "bool": {
                                                    "should": [
                                                        {
                                                            "term": {
                                                                "created_by.keyword": owner_email
                                                            }
                                                        },
                                                        {
                                                            "term": {
                                                                "created_by": owner_email
                                                            }
                                                        },
                                                    ],
                                                    "minimum_should_match": 1,
                                                }
                                            },
                                        ]
                                    }
                                },
                            },
                        )
                        opensearchindex_hits = (
                            (search_resp or {}).get("hits", {}).get("hits", [])
                        )
                    except Exception:
                        opensearchindex_hits = []

            cleanup_results = []
            for hit in opensearchindex_hits:
                metadata_doc_id = hit.get("_id")
                metadata = hit.get("_source", {}) or {}
                index_name = str(metadata.get("index_name") or "").strip()
                physical_index_name = str(
                    metadata.get("physical_index_name") or ""
                ).strip()
                metadata_owner = str(
                    metadata.get("created_by")
                    or metadata.get("owner_email")
                    or metadata.get("user_email")
                    or owner_email
                ).strip()

                if not metadata_doc_id or not index_name:
                    continue
                if (
                    index_name.startswith(".")
                    or index_name in _PROTECTED_OPENSEARCH_INDEX_NAMES
                ):
                    continue

                # Older local-folder metadata rows may only have the shortened
                # registered name. Reconstruct the exact physical file index from
                # uploaded_files so cleanup does not miss extensions like .pdf.
                if ds_type == "local_folder" and not physical_index_name:
                    uploaded_files = (
                        config.get("uploaded_files")
                        if isinstance(config.get("uploaded_files"), list)
                        else []
                    )
                    normalized_index_name = remove_special_characters(index_name)
                    for uploaded_file in uploaded_files:
                        if not isinstance(uploaded_file, dict):
                            continue
                        file_name = str(uploaded_file.get("file_name") or "").strip()
                        candidate_physical_name = compute_document_index_name(
                            metadata_owner or owner_email, file_name
                        )
                        if not candidate_physical_name:
                            continue
                        candidate_registered_name = candidate_physical_name
                        safe_owner = remove_special_characters(
                            str(metadata_owner or owner_email)
                        )
                        if safe_owner and candidate_registered_name.startswith(
                            f"{safe_owner}_"
                        ):
                            candidate_registered_name = candidate_registered_name[
                                len(safe_owner) + 1 :
                            ]
                        if (
                            candidate_registered_name == index_name
                            or remove_special_characters(candidate_registered_name)
                            == normalized_index_name
                        ):
                            physical_index_name = candidate_physical_name
                            break

                cleanup = (
                    retention_service.cleanup_physical_index_family(physical_index_name)
                    if physical_index_name
                    else retention_service.cleanup_registered_index_family(
                        index_name, metadata_owner
                    )
                )
                if not request.app.state.db.delete_document(
                    "opensearchindex", metadata_doc_id
                ):
                    raise HTTPException(
                        500,
                        f"Failed to delete associated opensearchindex metadata {metadata_doc_id}",
                    )
                cleanup_results.append(
                    {
                        "metadata_doc_id": metadata_doc_id,
                        "index_name": index_name,
                        "cleanup": cleanup,
                    }
                )

            if not cleanup_results and ds_type == "zetaris":
                datamart_name = str(config.get("datamart_name") or "").strip().lower()
                table_name = str(config.get("data_object_name") or "").strip().lower()
                if datamart_name and table_name and owner_email:
                    fallback_index_name = f"{datamart_name}-{table_name}"
                    direct_full_name = retention_service.resolve_registered_full_name(
                        fallback_index_name, owner_email
                    )
                    direct_cleanup = retention_service.cleanup_physical_index_family(
                        direct_full_name
                    )
                    cleanup_results.append(
                        {
                            "metadata_doc_id": None,
                            "index_name": fallback_index_name,
                            "cleanup": direct_cleanup,
                            "direct_cleanup": True,
                        }
                    )

            # Always sweep the exact file-backed indices from uploaded_files.
            # This runs even after metadata cleanup so local-folder deletes do
            # not depend on whether the shortened registered name matched.
            if ds_type == "local_folder":
                uploaded_files = (
                    config.get("uploaded_files")
                    if isinstance(config.get("uploaded_files"), list)
                    else []
                )
                cleaned_physical_names = {
                    str(item.get("physical_index_name") or "").strip()
                    for item in cleanup_results
                    if isinstance(item, dict)
                }
                for uploaded_file in uploaded_files:
                    if not isinstance(uploaded_file, dict):
                        continue
                    file_name = str(uploaded_file.get("file_name") or "").strip()
                    direct_index_name = compute_document_index_name(
                        owner_email, file_name
                    )
                    if (
                        not direct_index_name
                        or direct_index_name in cleaned_physical_names
                    ):
                        continue
                    direct_cleanup = retention_service.cleanup_physical_index_family(
                        direct_index_name
                    )
                    cleanup_results.append(
                        {
                            "metadata_doc_id": None,
                            "index_name": file_name,
                            "cleanup": direct_cleanup,
                            "physical_index_name": direct_index_name,
                            "direct_cleanup": True,
                        }
                    )
                    cleaned_physical_names.add(direct_index_name)

            datasource_cleanup = {
                "associated_index_count": len(cleanup_results),
                "associated_indices": cleanup_results,
            }
    if entity_type == "workflow":
        unschedule_workflow(request.app.state.scheduler, doc_id)
    if entity_type == "evaluation":
        unschedule_evaluation(request.app.state.scheduler, doc_id)

    # Finance customer panel deletes CustomerDocument by batch_id, but other parts of
    # the app may delete by document id. To support both without changing the API
    # format, we:
    # 1) try normal delete-by-id
    # 2) for customerdocument: if not found, delete all docs where batch_id == doc_id
    # 3) for customerdocumentbatch: if not found, try delete_by_query on id/batch_id
    entity = entity_type.lower()
    if entity in ("customerdocument", "customerdocumentbatch"):
        client = request.app.state.db.client
        owner_key = _get_finance_customer_owner_key(request, {})
        owner_filter = _finance_owner_filter(
            owner_key,
            _finance_customer_owner_values(request=request, owner_key=owner_key),
        )
        if not owner_filter:
            raise HTTPException(404, "Document not found")

        def _scoped_query(inner_query: Dict[str, Any]) -> Dict[str, Any]:
            return {"query": {"bool": {"must": [inner_query, owner_filter]}}}

        def _batch_id_filter(batch_id: str) -> Dict[str, Any]:
            batch_ids = [batch_id]
            namespaced_batch_id = f"{owner_key}-{batch_id}" if owner_key else ""
            if namespaced_batch_id and namespaced_batch_id not in batch_ids:
                batch_ids.append(namespaced_batch_id)
            return {
                "bool": {
                    "should": [
                        {"terms": {"batch_id": batch_ids}},
                        {"terms": {"batch_id.keyword": batch_ids}},
                        *[
                            {"match_phrase": {"batch_id": candidate}}
                            for candidate in batch_ids
                        ],
                    ],
                    "minimum_should_match": 1,
                }
            }

        def _summary_batch_query(batch_id: str) -> Dict[str, Any]:
            batch_ids = [batch_id]
            namespaced_batch_id = f"{owner_key}-{batch_id}" if owner_key else ""
            if namespaced_batch_id and namespaced_batch_id not in batch_ids:
                batch_ids.append(namespaced_batch_id)
            return {
                "query": {
                    "bool": {
                        "must": [
                            {
                                "bool": {
                                    "should": [
                                        {"terms": {"batch_id": batch_ids}},
                                        {"terms": {"batch_id.keyword": batch_ids}},
                                    ],
                                    "minimum_should_match": 1,
                                }
                            },
                            {"term": {"username": owner_key}},
                        ]
                    }
                }
            }

        def _cascade_batch_delete(batch_id: str) -> Dict[str, Any]:
            cascade_deleted: Dict[str, Any] = {}
            try:
                docs_resp = client.delete_by_query(
                    index="customerdocument",
                    body=_scoped_query(_batch_id_filter(batch_id)),
                    refresh=True,
                    conflicts="proceed",
                )
                cascade_deleted["customerdocument"] = docs_resp.get("deleted", 0)
            except Exception as exc:
                logger.warning(
                    "Failed cascading customerdocument delete for batch_id=%s: %s",
                    batch_id,
                    exc,
                )
            try:
                if client.indices.exists(index="validate_summary"):
                    summary_resp = client.delete_by_query(
                        index="validate_summary",
                        body=_summary_batch_query(batch_id),
                        refresh=True,
                        conflicts="proceed",
                    )
                    cascade_deleted["validate_summary"] = summary_resp.get("deleted", 0)
            except Exception as exc:
                logger.warning(
                    "Failed cascading validate_summary delete for batch_id=%s: %s",
                    batch_id,
                    exc,
                )
            return cascade_deleted

        try:
            existing_doc = client.get(index=entity_type, id=doc_id)
            existing_source = (
                existing_doc.get("_source", {})
                if isinstance(existing_doc, dict)
                else {}
            )
            if _finance_document_belongs_to_owner(existing_source, owner_key):
                client.delete(index=entity_type, id=doc_id, refresh=True)
                response = {"message": "Deleted", "id": doc_id}
                if entity == "customerdocumentbatch":
                    response["cascade_deleted"] = _cascade_batch_delete(doc_id)
                return response
        except NotFoundError:
            pass
        except Exception as exc:
            logger.warning(
                "Failed checking finance customer direct delete entity=%s id=%s: %s",
                entity,
                doc_id,
                exc,
            )

        def _batch_exists(batch_id: str) -> bool:
            try:
                resp = client.search(
                    index="customerdocumentbatch",
                    body={
                        "_source": False,
                        "size": 1,
                        "query": _with_finance_owner_filter(
                            {
                                "bool": {
                                    "should": [
                                        {"term": {"id": batch_id}},
                                        {"term": {"id.keyword": batch_id}},
                                        {"term": {"external_id": batch_id}},
                                        {"term": {"external_id.keyword": batch_id}},
                                    ],
                                    "minimum_should_match": 1,
                                }
                            },
                            owner_key,
                        ),
                    },
                )
                return resp.get("hits", {}).get("total", {}).get("value", 0) > 0
            except Exception:
                return False

        if entity == "customerdocument":
            # Guardrail: only treat doc_id as a batch_id if that batch exists.
            # This prevents accidental "delete by query" when callers intended to
            # delete a single document id but provided a missing/incorrect id.
            if not _batch_exists(doc_id):
                raise HTTPException(500, "Delete failed")
            query = _scoped_query(_batch_id_filter(doc_id))
        else:
            query = _scoped_query(
                {
                    "bool": {
                        "should": [
                            {"term": {"id": doc_id}},
                            {"term": {"id.keyword": doc_id}},
                            {"term": {"external_id": doc_id}},
                            {"term": {"external_id.keyword": doc_id}},
                            {"term": {"batch_id": doc_id}},
                            {"term": {"batch_id.keyword": doc_id}},
                        ],
                        "minimum_should_match": 1,
                    }
                }
            )

        try:
            resp = client.delete_by_query(
                index=entity,
                body=query,
                refresh=True,
                conflicts="proceed",
            )
            deleted = resp.get("deleted", 0)
            cascade_deleted = {}
            if entity == "customerdocumentbatch":
                cascade_deleted = _cascade_batch_delete(doc_id)
            return {
                "message": "Deleted",
                "id": doc_id,
                "deleted": deleted,
                "already_deleted": entity == "customerdocumentbatch" and deleted == 0,
                "delete_mode": (
                    "batch_id" if entity == "customerdocument" else "fallback"
                ),
                "cascade_deleted": cascade_deleted,
            }
        except Exception as e:
            raise HTTPException(500, f"Delete failed: {str(e)}")

    # Actual deletion for all entity types (bugfix: previously only deleted "datasource").
    if entity_type == "contract":
        # The exact document was loaded and authorised above. Use non-blocking
        # I/O and do not run the generic ID-search retry on a failed delete.
        # refresh=True keeps the following list reload consistent: the loading
        # dialog stays open until deletion and refreshed list both complete.
        try:
            deleted = await request.app.state.db.async_delete_document(
                entity_type, doc_id, refresh=True
            )
        except Exception as exc:
            raise HTTPException(500, "Contract deletion failed") from exc
        if not deleted:
            raise HTTPException(404, "Contract not found")
        return {"message": "Deleted", "id": doc_id}

    if not request.app.state.db.delete_document(entity_type, doc_id):
        raise HTTPException(500, "Delete failed")

    response = {"message": "Deleted", "id": doc_id}
    if entity_type == "datasource":
        response["datasource_cleanup"] = datasource_cleanup
    return response


@router.delete("/compliance-rule/{doc_id}")
async def delete_compliance_rule(request: Request, doc_id: str):
    if not await request.app.state.db.async_delete_document(
        "compliancerule",
        doc_id,
        refresh=True,
    ):
        raise HTTPException(500, "Delete failed")

    await delete_compliance_rule_csv(doc_id)
    return {"message": "Deleted", "id": doc_id}


@router.get("/execution-monitor")
async def execution_monitor(
    request: Request,
    skip: int = Query(0, ge=0),
    limit: int = Query(5, ge=1, le=100),
    search: str = Query("", max_length=200),
    status: str = "all",
    ids_only: bool = False,
    monthly_count_only: bool = False,
    older_than_days: int | None = Query(None, ge=1),
    month_start: datetime | None = None,
    month_end: datetime | None = None,
    time_zone: str = "UTC",
):
    """Page execution summaries using the WorkflowExecutionStore schema."""
    if monthly_count_only and ids_only:
        raise HTTPException(400, "Monthly count cannot be combined with IDs only")
    if skip + limit > 10000:
        raise HTTPException(
            400, "Execution pagination exceeds the 10,000 result window"
        )
    if status not in {"all", "running", "paused", "completed", "failed", "active"}:
        raise HTTPException(400, "Invalid execution status")
    user, _expires_at = await get_current_user_from_request(request)
    email = str(user.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(401, "An authenticated email is required")

    # The runner also writes sanitized usernames; retain the monitor's owner match.
    owner = re.sub(r"[^a-z0-9]", "", email)
    own_executions = (
        {
            "regexp": {
                "created_by.keyword": {
                    "value": "[^a-zA-Z0-9]*"
                    + "[^a-zA-Z0-9]*".join(owner)
                    + "[^a-zA-Z0-9]*",
                    "case_insensitive": True,
                }
            }
        }
        if owner
        else {"match_none": {}}
    )
    if monthly_count_only:
        try:
            browser_zone = ZoneInfo(time_zone)
        except (ValueError, ZoneInfoNotFoundError):
            raise HTTPException(400, "Invalid time zone")
        now = datetime.now(browser_zone)
        start = month_start or now.replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        end = month_end or (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        if end <= start:
            raise HTTPException(400, "Invalid month interval")

        # Designer merges the optional profile before the authenticated user.
        user_id = user.get("id")
        if not user_id:
            try:
                profiles = await request.app.state.db.async_search(
                    index="user",
                    body={
                        "size": 5000,
                        "query": _with_tenant_scope(request, "user", {"match_all": {}}),
                        "_source": ["email", "id"],
                    },
                )
                profile = next(
                    (
                        hit
                        for hit in profiles.get("hits", {}).get("hits", [])
                        if str(hit.get("_source", {}).get("email") or "")
                        .strip()
                        .lower()
                        == email
                    ),
                    {},
                )
                user_id = (
                    profile.get("_source", {}).get("id")
                    or user.get("_id")
                    or profile.get("_id")
                )
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                user_id = user.get("_id")
        identity_keys = set()
        for value in (email, user_id):
            raw = str(value or "").strip().lower()
            if raw:
                identity_keys.update((raw, re.sub(r"[^a-z0-9]", "", raw)))
        identity_keys.discard("")
        owner_fields = (
            "created_by",
            "created_by_email",
            "user_email",
            "owner_email",
            "owner_id",
            "user_id",
            "created_by_user_id",
            "updated_by",
        )
        date_fields = ("started_at", "created_date", "created_at", "updated_date")
        try:
            count_scope = _with_tenant_scope(
                request, "workflowexecution", {"match_all": {}}
            )
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            return {"monthly_owned_count": 0}
        client = request.app.state.db.get_async_client()
        scroll_id = None
        monthly_count = 0
        try:
            page = await client.search(
                index="workflowexecution",
                scroll="1m",
                body={
                    "size": 1000,
                    "sort": ["_doc"],
                    "query": count_scope,
                    "_source": [*owner_fields, *date_fields],
                },
            )
            while True:
                scroll_id = page.get("_scroll_id") or scroll_id
                hits = page.get("hits", {}).get("hits", [])
                if not hits:
                    break
                for hit in hits:
                    source = hit.get("_source") or {}
                    owners = {
                        str(source.get(field) or "").strip().lower()
                        for field in owner_fields
                    }
                    if not any(
                        raw
                        and (
                            raw in identity_keys
                            or re.sub(r"[^a-z0-9]", "", raw) in identity_keys
                        )
                        for raw in owners
                    ):
                        continue
                    raw_date = next(
                        (
                            source.get(field)
                            for field in date_fields
                            if source.get(field)
                        ),
                        None,
                    )
                    if raw_date is None:
                        continue
                    try:
                        if isinstance(raw_date, (int, float)):
                            execution_date = datetime.fromtimestamp(
                                raw_date / 1000, timezone.utc
                            )
                        else:
                            try:
                                execution_date = datetime.fromisoformat(
                                    str(raw_date).strip().replace("Z", "+00:00")
                                )
                            except ValueError:
                                execution_date = parse_datetime(
                                    str(raw_date), default=datetime(2001, 1, 1)
                                )
                            if execution_date.tzinfo is None:
                                # JavaScript treats ISO date-only values as UTC, but local datetimes as browser time.
                                execution_date = execution_date.replace(
                                    tzinfo=(
                                        timezone.utc
                                        if re.fullmatch(
                                            r"\d{4}-\d{2}-\d{2}", str(raw_date).strip()
                                        )
                                        else browser_zone
                                    )
                                )
                        if start <= execution_date < end:
                            monthly_count += 1
                    except (ValueError, TypeError, OverflowError, OSError):
                        # An invalid first non-empty date does not fall through to a later field.
                        continue
                if not scroll_id:
                    break
                page = await client.scroll(scroll_id=scroll_id, scroll="1m")
        finally:
            if scroll_id:
                await client.clear_scroll(scroll_id=scroll_id)
        return {"monthly_owned_count": monthly_count}

    org_user = (
        await _get_current_org_user(request) if user.get("organization_id") else None
    )
    privileged = str(
        user.get("role") or ""
    ).lower() == "admin" or _is_admin_or_owner_org_user(org_user)
    try:
        scope = _with_tenant_scope(
            request,
            "workflowexecution",
            {"match_all": {}} if privileged else own_executions,
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return {
            "items": [],
            "total": 0,
            "skip": skip,
            "limit": limit,
            "all_count": 0,
            "active_count": 0,
            "monthly_owned_count": 0,
        }

    filters = []
    if search:
        escaped = (
            search.lower().replace("\\", "\\\\").replace("*", "\\*").replace("?", "\\?")
        )
        filters.append(
            {
                "wildcard": {
                    "workflow_name.keyword": {
                        "value": f"*{escaped}*",
                        "case_insensitive": True,
                    }
                }
            }
        )
    if status != "all":
        filters.append(
            {
                "terms": {
                    "status.keyword": (
                        ["running", "paused"] if status == "active" else [status]
                    )
                }
            }
        )
    if older_than_days is not None:
        filters.append(
            {
                "range": {
                    "started_at": {
                        "lt": (
                            datetime.utcnow() - timedelta(days=older_than_days)
                        ).isoformat(),
                    }
                }
            }
        )
    now = datetime.now(timezone.utc)
    start = month_start or now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = month_end or (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    if end <= start:
        raise HTTPException(400, "Invalid month interval")

    body = {
        "from": skip,
        "size": limit,
        "track_total_hits": True,
        "query": scope,
        "post_filter": {"bool": {"filter": filters}} if filters else {"match_all": {}},
        "sort": [
            {"started_at": {"order": "desc", "unmapped_type": "date"}},
            {"id.keyword": {"order": "asc", "unmapped_type": "keyword"}},
        ],
        "_source": (
            False
            if ids_only
            else [
                "id",
                "workflow_id",
                "workflow_name",
                "status",
                "started_at",
                "completed_at",
                "created_date",
                "updated_date",
                "current_step",
                "parent_execution_id",
                "can_restart",
                "step_logs.status",
            ]
        ),
    }
    if not ids_only:
        body["aggs"] = {
            "all_count": {"filter": {"match_all": {}}},
            "active_count": {
                "filter": {"terms": {"status.keyword": ["running", "paused"]}}
            },
            "monthly_owned_count": {
                "filter": {
                    "bool": {
                        "filter": [
                            own_executions,
                            {
                                "range": {
                                    "started_at": {
                                        "gte": start.isoformat(),
                                        "lt": end.isoformat(),
                                    }
                                }
                            },
                        ]
                    }
                }
            },
        }
    result = await asyncio.to_thread(
        request.app.state.db.client.search, index="workflowexecution", body=body
    )
    items = []
    for hit in result["hits"]["hits"]:
        source = hit.get("_source") or {}
        if not ids_only:
            logs = source.pop("step_logs", [])
            source["total_steps"] = len(logs)
            source["completed_steps"] = sum(
                log.get("status") == "completed" for log in logs
            )
        items.append({**source, "id": hit["_id"], "_id": hit["_id"]})
    return {
        "items": items,
        "total": result["hits"]["total"]["value"],
        "skip": skip,
        "limit": limit,
        **{
            name: value["doc_count"]
            for name, value in result.get("aggregations", {}).items()
        },
    }


@router.get("/search/{entity_type}/simple")
async def simple_search(
    request: Request,
    entity_type: str,
    q: str,
    skip: int = 0,
    limit: int = 5000,
    summary_only: bool = False,
):
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    if entity_type == _CONTRACT_SHARE_ENTITY:
        sources = [
            (str(source.get("id") or "").strip(), source)
            for source in _contract_share_sources(request)
            if _resource_share_owner_matches(request, source)
            or _resource_share_recipient_matches(request, source)
        ]
        normalized_query = str(q or "").strip().lower()
        if normalized_query and normalized_query != "*":
            sources = [
                (doc_id, source)
                for doc_id, source in sources
                if normalized_query in json.dumps(source, default=str).lower()
            ]
        page = sources[skip : skip + limit]
        return {
            "total": len(sources),
            "items": [
                {**_source_for_response(entity_type, source), "_id": doc_id}
                for doc_id, source in page
            ],
            "skip": skip,
            "limit": limit,
        }
    if entity_type in _PRIVATE_CONTRACT_ENTITIES:
        if not request.app.state.db.client.indices.exists(index=entity_type):
            return {"total": 0, "items": [], "skip": skip, "limit": limit}
        normalized_query = str(q or "").strip()
        access_query = {"match_all": {}}
        if normalized_query and normalized_query != "*":
            access_query = {
                "query_string": {"query": normalized_query, "default_operator": "OR"}
            }
        try:
            response = request.app.state.db.client.search(
                index=entity_type,
                body={
                    "from": skip,
                    "size": limit,
                    "query": _with_contract_access_filter(
                        request, entity_type, access_query
                    ),
                },
            )
        except Exception as exc:
            raise HTTPException(500, f"Contract search failed: {exc}") from exc
        hits = response.get("hits", {}).get("hits", [])
        total = response.get("hits", {}).get("total", 0)
        total_value = total.get("value", 0) if isinstance(total, dict) else total
        return {
            "total": total_value,
            "items": [
                {
                    **_source_for_response(entity_type, hit.get("_source", {}) or {}),
                    "_id": hit.get("_id"),
                }
                for hit in hits
            ],
            "skip": skip,
            "limit": limit,
        }
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        # Finance customer lists are paged by the UI. Keep each response bounded
        # so a legacy caller cannot make this async route materialize 10,000 rows.
        limit = min(limit, 500)
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions=_FINANCE_SHARED_READ_ACTIONS,
        )
        owner_key = _get_finance_customer_owner_key(request, {})
        owner_filter = _finance_owner_filter(
            owner_key,
            _finance_customer_owner_values(request=request, owner_key=owner_key),
        )
        if not owner_filter:
            return {"total": 0, "items": [], "skip": skip, "limit": limit}

        normalized_query = str(q or "").strip()
        must_clauses: list[Dict[str, Any]] = [owner_filter]
        if shared_context:
            shared_batch_id = str(shared_context.get("batch_id") or "").strip()
            if entity_type == "customerdocumentbatch":
                must_clauses.append(
                    {
                        "bool": {
                            "should": [
                                {"term": {"_id": shared_batch_id}},
                                {"term": {"id": shared_batch_id}},
                                {"term": {"id.keyword": shared_batch_id}},
                            ],
                            "minimum_should_match": 1,
                        }
                    }
                )
            else:
                must_clauses.append(
                    {
                        "bool": {
                            "should": [
                                {"term": {"batch_id": shared_batch_id}},
                                {"term": {"batch_id.keyword": shared_batch_id}},
                            ],
                            "minimum_should_match": 1,
                        }
                    }
                )
        if entity_type == "customerdocumentbatch":
            must_clauses.append(_finance_valid_customer_id_filter())
        if normalized_query and normalized_query != "*":
            must_clauses.append(
                {
                    "query_string": {
                        "query": normalized_query,
                        "default_operator": "OR",
                    }
                }
            )

        search_body = {
            "from": skip,
            "size": limit,
            "query": {"bool": {"must": must_clauses}},
        }
        if entity_type == "customerdocument" and summary_only:
            search_body["_source"] = {
                "excludes": [
                    "page_content",
                    "content",
                    "document_content",
                    "extracted_text",
                    "raw_content",
                    "vector_field",
                    "embedding",
                    "embeddings",
                    "chunks",
                ]
            }
        try:
            response = await request.app.state.db.async_search(
                index=entity_type, body=search_body
            )
        except Exception as exc:
            raise HTTPException(500, f"Finance customer search failed: {exc}")

        hits = response.get("hits", {}).get("hits", [])
        total = response.get("hits", {}).get("total", 0)
        total_value = total.get("value", 0) if isinstance(total, dict) else total
        items = [
            {
                **_source_for_response(entity_type, hit.get("_source", {}) or {}),
                "_id": hit.get("_id"),
            }
            for hit in hits
        ]
        return {"total": total_value, "items": items, "skip": skip, "limit": limit}

    if entity_type == "datasource":
        current_user_email = _get_authenticated_user_email(request)
        if not current_user_email:
            return {"total": 0, "items": [], "skip": skip, "limit": limit}

        normalized_query = str(q or "").strip()
        bool_query = {
            "should": _datasource_access_should_clauses(current_user_email),
            "minimum_should_match": 1,
        }
        if normalized_query and normalized_query != "*":
            bool_query["must"] = [
                {
                    "query_string": {
                        "query": normalized_query,
                        "default_operator": "OR",
                    }
                }
            ]

        search_body = {
            "from": skip,
            "size": limit,
            "query": {"bool": bool_query},
        }
        try:
            response = request.app.state.db.client.search(
                index="datasource", body=search_body
            )
        except Exception as exc:
            raise HTTPException(500, f"Datasource search failed: {exc}")

        hits = response.get("hits", {}).get("hits", [])
        total = response.get("hits", {}).get("total", 0)
        total_value = total.get("value", 0) if isinstance(total, dict) else total
        items = [
            {
                **_source_for_response(entity_type, hit.get("_source", {}) or {}),
                "_id": hit.get("_id"),
            }
            for hit in hits
        ]
        return {"total": total_value, "items": items, "skip": skip, "limit": limit}

    normalized_query = str(q or "").strip() or "*"
    scoped_response = request.app.state.db.client.search(
        index=entity_type,
        body={
            "from": skip,
            "size": limit,
            "query": _with_tenant_scope(
                request,
                entity_type,
                {
                    "query_string": {
                        "query": normalized_query,
                        "default_operator": "OR",
                    }
                },
            ),
        },
    )
    scoped_hits = (scoped_response or {}).get("hits") or {}
    raw_hits = scoped_hits.get("hits") or []
    total = scoped_hits.get("total") or 0
    total_value = total.get("value", 0) if isinstance(total, dict) else int(total or 0)
    items = [
        {
            **_source_for_response(entity_type, hit.get("_source", {}) or {}),
            "_id": hit["_id"],
        }
        for hit in raw_hits
    ]
    if entity_type == "opensearchindex":
        _attach_datasource_names_to_indexes(request.app.state.db, items)
        _attach_live_document_counts_to_indexes(request.app.state.db, items)
    if entity_type in {"systemconfig", "system_config"}:
        org_user = await _get_current_org_user(request)
        if not _is_admin_or_owner_org_user(org_user):
            items = [item for item in items if not _is_admin_owner_system_config(item)]
            return {"total": len(items), "items": items, "skip": skip, "limit": limit}
    return {"total": total_value, "items": items, "skip": skip, "limit": limit}


@router.get("/search/{entity_type}/{doc_id}")
async def get_document_by_id_via_search_path(
    request: Request, entity_type: str, doc_id: str
):
    """Fetch a single document by id.

    Compatibility endpoint for UIs that use the /search/{entity_type}/{doc_id}
    path pattern.
    """
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    shared_context = None
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions=_FINANCE_SHARED_READ_ACTIONS,
        )
    try:
        response = await request.app.state.db.async_get_by_id(entity_type, doc_id)
    except NotFoundError:
        raise HTTPException(404, "Document not found")
    except Exception as exc:
        raise HTTPException(500, f"Fetch failed: {exc}")
    source = (response or {}).get("_source", {}) or {}
    _ensure_document_tenant_scope(request, entity_type, source)
    source.setdefault("_id", (response or {}).get("_id", doc_id))
    if entity_type == _CONTRACT_SHARE_ENTITY and not (
        _resource_share_owner_matches(request, source)
        or _resource_share_recipient_matches(request, source)
    ):
        raise HTTPException(404, "Document not found")
    if entity_type == "datasource":
        await _ensure_datasource_read_access(request, source)
    _ensure_contract_access(request, entity_type, source, "view")
    _ensure_shared_entity_batch(
        entity_type,
        shared_context,
        doc_id=doc_id,
        existing_source=source,
    )
    await _ensure_admin_owner_access_for_system_config(request, source)
    _ensure_finance_customer_owner_access(request, entity_type, source)
    return {
        **_source_for_response(entity_type, source),
        "_id": (response or {}).get("_id", doc_id),
    }


@router.get("/documents/{entity_type}/{doc_id}")
async def get_document_by_id(request: Request, entity_type: str, doc_id: str):
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    shared_context = None
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions=_FINANCE_SHARED_READ_ACTIONS,
        )
    try:
        response = await request.app.state.db.async_get_by_id(entity_type, doc_id)
    except NotFoundError:
        raise HTTPException(404, "Document not found")
    except Exception as exc:
        raise HTTPException(500, f"Fetch failed: {exc}")
    source = (response or {}).get("_source", {}) or {}
    _ensure_document_tenant_scope(request, entity_type, source)
    source.setdefault("_id", (response or {}).get("_id", doc_id))
    if entity_type == _CONTRACT_SHARE_ENTITY and not (
        _resource_share_owner_matches(request, source)
        or _resource_share_recipient_matches(request, source)
    ):
        raise HTTPException(404, "Document not found")
    if entity_type == "datasource":
        await _ensure_datasource_read_access(request, source)
    _ensure_contract_access(request, entity_type, source, "view")
    _ensure_shared_entity_batch(
        entity_type,
        shared_context,
        doc_id=doc_id,
        existing_source=source,
    )
    await _ensure_admin_owner_access_for_system_config(request, source)
    _ensure_finance_customer_owner_access(request, entity_type, source)
    return {
        **_source_for_response(entity_type, source),
        "_id": (response or {}).get("_id", doc_id),
    }


@router.patch("/documents/agent/{doc_id}/ai-assistant")
async def update_agent_ai_assistant_availability(
    request: Request,
    doc_id: str,
    request_data: Dict[str, Any] = Body(...),
):
    """Update only the signed-in user's AI Assistant preference for an agent."""
    user_email = _get_authenticated_user_email(request)
    if not user_email:
        raise HTTPException(401, "Sign in before updating AI Assistant availability")

    enabled = request_data.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(400, "enabled must be true or false")

    try:
        existing = request.app.state.db.client.get(index="agent", id=doc_id)
    except NotFoundError:
        raise HTTPException(404, "Agent not found")
    except Exception as exc:
        raise HTTPException(500, f"Failed to load agent: {exc}")

    source = existing.get("_source", {}) if isinstance(existing, dict) else {}
    current_preferences = source.get("chat_pinned_by") or {}
    if not isinstance(current_preferences, dict):
        current_preferences = {}

    user_key = re.sub(r"[^a-z0-9]", "", user_email.strip().lower())
    current_preferences[user_key] = enabled

    try:
        request.app.state.db.client.update(
            index="agent",
            id=doc_id,
            body={
                "doc": {
                    "chat_pinned_by": current_preferences,
                }
            },
            refresh=True,
        )
    except Exception as exc:
        raise HTTPException(500, f"Failed to update AI Assistant availability: {exc}")

    return {
        "id": doc_id,
        "enabled": enabled,
        "chat_pinned_by": current_preferences,
    }


@router.patch("/documents/{entity_type}/{doc_id}")
async def update_document(
    request: Request,
    entity_type: str,
    doc_id: str,
    request_data: Dict[str, Any] = Body(...),
):

    entity_type = _normalize_entity_type(entity_type)
    payload_for_log = request_data.get("data", request_data)
    document_for_log = (
        payload_for_log.get("data", payload_for_log)
        if isinstance(payload_for_log, dict)
        else {}
    )
    if not isinstance(document_for_log, dict):
        document_for_log = {}
    migration_run_for_log = {}
    if isinstance(document_for_log.get("migration_agent_last_run"), dict):
        migration_run_for_log = document_for_log.get("migration_agent_last_run") or {}
    model_used = str(
        document_for_log.get("scan_model")
        or document_for_log.get("selected_model")
        or document_for_log.get("model")
        or migration_run_for_log.get("use_model")
        or ""
    ).strip()
    framework_used = str(
        document_for_log.get("scan_framework")
        or document_for_log.get("selected_framework")
        or document_for_log.get("framework")
        or migration_run_for_log.get("framework")
        or ""
    ).strip()
    if (
        not framework_used or not model_used
    ) and entity_type.lower() == "dataswashingjob":
        try:
            existing = request.app.state.db.client.get(
                index=entity_type.lower(), id=doc_id
            )
            existing_src = (
                existing.get("_source", {}) if isinstance(existing, dict) else {}
            )
            existing_migration_run = (
                existing_src.get("migration_agent_last_run")
                if isinstance(existing_src.get("migration_agent_last_run"), dict)
                else {}
            )
            if not framework_used:
                framework_used = str(
                    existing_src.get("scan_framework")
                    or existing_src.get("selected_framework")
                    or existing_src.get("framework")
                    or existing_migration_run.get("framework")
                    or ""
                ).strip()
            if not model_used:
                model_used = str(
                    existing_src.get("scan_model")
                    or existing_src.get("selected_model")
                    or existing_src.get("model")
                    or existing_migration_run.get("use_model")
                    or ""
                ).strip()
        except Exception:
            pass
    logger.info(
        "Received document update entity=%s doc_id=%s fields=%s framework=%s model=%s",
        entity_type,
        doc_id,
        sorted(list(document_for_log.keys())),
        framework_used or "unknown",
        model_used or "unknown",
    )

    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    if entity_type not in _PRIVATE_CONTRACT_ENTITIES:
        await _ensure_entity_write_permission(request, entity_type, "update")

    # Accept both {data: {...}} and nested {data: {data: {...}}}, same as create.
    payload = request_data.get("data", request_data)
    document = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(document, dict):
        raise HTTPException(400, "Invalid update payload")

    # Extract only the update fields
    document_body = document.copy()
    document_body.pop("id", None)
    document_body.pop("_id", None)
    datasource_new_files: list[dict[str, Any]] = []
    if entity_type == _CONTRACT_SHARE_ENTITY:
        try:
            existing_share = request.app.state.db.client.get(
                index=entity_type, id=doc_id
            )
        except NotFoundError as exc:
            raise HTTPException(404, "Share record not found") from exc
        document = await _prepare_resource_share_document(
            request,
            document,
            existing_share.get("_source", {}) or {},
        )
        document_body = {
            key: value for key, value in document.items() if key not in {"id", "_id"}
        }
    private_contract_source: Dict[str, Any] = {}
    if entity_type in _PRIVATE_CONTRACT_ENTITIES:
        try:
            existing_contract_doc = request.app.state.db.client.get(
                index=entity_type, id=doc_id
            )
        except NotFoundError as exc:
            raise HTTPException(404, "Document not found") from exc
        except Exception as exc:
            raise HTTPException(
                500, f"Failed to load contract document: {exc}"
            ) from exc
        private_contract_source = existing_contract_doc.get("_source", {}) or {}
        private_contract_source.setdefault("_id", doc_id)
        _ensure_contract_access(request, entity_type, private_contract_source, "edit")
        is_owner = _contract_document_belongs_to_owner(request, private_contract_source)
        for owner_field in ("owner_email", "created_by", "created_by_email"):
            document_body.pop(owner_field, None)
        if is_owner:
            owner_email = _contract_owner_email(request)
            document_body["owner_email"] = owner_email
            document_body["created_by"] = owner_email
            document_body["created_by_email"] = owner_email
        else:
            for owner_field in ("owner_email", "created_by", "created_by_email"):
                if private_contract_source.get(owner_field):
                    document_body[owner_field] = private_contract_source[owner_field]
        if entity_type in {"contract_version", "contractreview"}:
            # A version/review remains attached to its original contract.
            if private_contract_source.get("contract_id"):
                document_body["contract_id"] = private_contract_source["contract_id"]
    original_datasource_source = {}
    if entity_type == "datasource":
        try:
            original_datasource_doc = request.app.state.db.client.get(
                index="datasource", id=doc_id
            )
            original_datasource_source = (
                original_datasource_doc.get("_source", {})
                if isinstance(original_datasource_doc, dict)
                else {}
            )
            original_datasource_source["id"] = doc_id
        except NotFoundError:
            raise HTTPException(404, "Datasource not found")
        except Exception as exc:
            raise HTTPException(500, f"Failed to load datasource document: {exc}")

        incoming_config = document_body.get("config")
        datasource_type = (
            str(document.get("type") or original_datasource_source.get("type") or "")
            .strip()
            .lower()
        )
        if isinstance(incoming_config, dict):
            existing_config = original_datasource_source.get("config") or {}
            if incoming_config.get("zetaris_api_key") == "***MASKED***":
                incoming_config["zetaris_api_key"] = existing_config.get(
                    "zetaris_api_key", ""
                )
            (
                document_body["config"],
                datasource_new_files,
                _,
            ) = prepare_datasource_event_state(
                original_datasource_source,
                incoming_config,
                datasource_type,
            )
            incoming_config = document_body["config"]
            if datasource_type == "zetaris" and _coerce_bool(
                incoming_config.get("use_api_credentials")
            ):
                current_user, _ = await get_current_user_from_request(request)
                email = str(current_user.get("email") or "").strip()
                saved_credentials = get_user_zetaris_api_credentials(
                    request.app.state.db, email
                )
                api_key = incoming_config.get("zetaris_api_key")
                if api_key in (None, "", "***MASKED***") and saved_credentials:
                    api_key = saved_credentials["zetaris_api_key"]
                org_id = str(incoming_config.get("zetaris_orgid") or "").strip()
                if not org_id and saved_credentials:
                    org_id = saved_credentials["zetaris_orgid"]
                if not api_key or not org_id:
                    raise HTTPException(
                        400,
                        "Zetaris API key and organization ID are required",
                    )
                incoming_config["zetaris_api_key"] = api_key
                incoming_config["zetaris_orgid"] = org_id
                save_user_zetaris_api_credentials(
                    request.app.state.db, email, api_key, org_id
                )
    if entity_type in {"agent", "tool"}:
        timestamp = datetime.utcnow().isoformat()
        document_body["updated_at"] = timestamp
        document_body["updated_date"] = timestamp
    shared_context = None
    if entity_type in _FINANCE_CUSTOMER_ENTITIES:
        allowed_actions = (
            {"upload"}
            if entity_type == "customerdocument"
            else {
                "edit",
                "upload",
                "request_documents",
                "email_communications",
                "validate",
                "transfer",
                "calculator",
                "archive",
                "feedback",
            }
        )
        shared_context = await resolve_finance_shared_headers(
            request,
            expected_actions=allowed_actions,
        )
    if entity_type in {"systemconfig", "system_config"}:
        guard_document = dict(document_body)
        if not guard_document.get("key"):
            try:
                existing_doc = request.app.state.db.client.get(
                    index=entity_type, id=doc_id
                )
                existing_source = existing_doc.get("_source", {}) or {}
            except NotFoundError:
                existing_source = {}
            except Exception as exc:
                raise HTTPException(
                    500, f"Failed to load system config document: {exc}"
                )
            guard_document = {**existing_source, **guard_document}
        await _ensure_admin_owner_access_for_system_config(request, guard_document)

    finance_update_requires_existing = entity_type in _FINANCE_CUSTOMER_ENTITIES
    if finance_update_requires_existing:
        try:
            existing_doc = request.app.state.db.client.get(
                index=entity_type.lower(),
                id=doc_id,
            )
            existing_source = (
                existing_doc.get("_source", {})
                if isinstance(existing_doc, dict)
                else {}
            )
            _ensure_shared_entity_batch(
                entity_type,
                shared_context,
                doc_id=doc_id,
                document=document_body,
                existing_source=existing_source,
            )
            _ensure_finance_customer_owner_access(request, entity_type, existing_source)
        except NotFoundError:
            raise HTTPException(404, "Document not found")
        owner_key = _get_finance_customer_owner_key(request, existing_source)
        if owner_key:
            document_body["broker_owner_key"] = owner_key
            document_body["created_by"] = owner_key
            document_body.setdefault("created_by_id", owner_key)
            if entity_type == "customerdocumentbatch":
                document_body.setdefault("broker_email", owner_key)

    datasource_sharing_fields = {"shared", "shared_users"}
    if entity_type == "datasource" and datasource_sharing_fields.intersection(
        document_body
    ):
        try:
            existing_doc = request.app.state.db.client.get(
                index="datasource", id=doc_id
            )
            existing_source = (
                existing_doc.get("_source", {})
                if isinstance(existing_doc, dict)
                else {}
            )
        except NotFoundError:
            raise HTTPException(404, "Datasource not found")
        except Exception as exc:
            raise HTTPException(500, f"Failed to load datasource document: {exc}")

        effective_shared = document_body.get("shared", existing_source.get("shared"))
        effective_users = document_body.get(
            "shared_users", existing_source.get("shared_users") or []
        )
        if _coerce_bool(effective_shared) and not effective_users:
            raise HTTPException(
                400,
                "Select at least one user before sharing a datasource.",
            )

        sharing_changed = any(
            document_body.get(field) != existing_source.get(field)
            for field in datasource_sharing_fields
            if field in document_body
        )
        if sharing_changed:
            current_user_email = _get_authenticated_user_email(request)
            owner_email = _normalize_email(existing_source.get("created_by"))
            if not current_user_email or owner_email != _normalize_email(
                current_user_email
            ):
                raise HTTPException(
                    403,
                    "Only the creator of this datasource can change sharing settings.",
                )

    if entity_type == "organizationuser":
        try:
            existing_doc = request.app.state.db.client.get(
                index="organizationuser",
                id=doc_id,
            )
            existing_source = (
                existing_doc.get("_source", {})
                if isinstance(existing_doc, dict)
                else {}
            )
        except NotFoundError:
            existing_source = {}
        except Exception as exc:
            raise HTTPException(
                500, f"Failed to load organization user document: {exc}"
            )

        guard_document = (
            {**existing_source, **document_body}
            if isinstance(existing_source, dict)
            else dict(document_body)
        )
        await _ensure_owner_role_assignment_allowed(
            request,
            guard_document,
            existing_source if isinstance(existing_source, dict) else None,
        )

    def _coerce_similarity_scores_to_float(value: Any):
        if isinstance(value, dict):
            if "similarity_score" in value:
                raw = value.get("similarity_score")
                if raw is None or raw == "":
                    value["similarity_score"] = 0.0
                else:
                    try:
                        value["similarity_score"] = float(raw)
                    except Exception:
                        value["similarity_score"] = 0.0
            for nested in value.values():
                _coerce_similarity_scores_to_float(nested)
        elif isinstance(value, list):
            for item in value:
                _coerce_similarity_scores_to_float(item)

    if entity_type.lower() in ("workflow", "workflowtemplate"):
        _normalize_workflow_document_for_mapping(request, entity_type, document_body)
    elif entity_type.lower() in ("datadictionary", "data_dictionary"):
        if "description" in document_body and document_body["description"] is not None:
            document_body["description"] = str(document_body["description"])
    elif entity_type.lower() == "dataswashingjob":
        _coerce_similarity_scores_to_float(document_body)
        if isinstance(document_body.get("sensitivity_results"), list):
            for result in document_body.get("sensitivity_results", []):
                if not isinstance(result, dict):
                    continue
                file_name = str(result.get("file_name") or "").strip() or "unknown"
                model_matches = [
                    m
                    for m in (result.get("taxonomy_matches") or [])
                    if isinstance(m, dict)
                    and str(m.get("match_type") or "").strip().lower()
                    == "semantic_model"
                ]
                if not model_matches:
                    continue
                tags = sorted(
                    {
                        str(m.get("prefixed_tag") or m.get("tag") or "").strip()
                        for m in model_matches
                        if str(m.get("prefixed_tag") or m.get("tag") or "").strip()
                    }
                )
                logger.info(
                    "Model scan output entity=%s doc_id=%s file=%s framework=%s model=%s semantic_model_matches=%s tags=%s",
                    entity_type,
                    doc_id,
                    file_name,
                    framework_used or "unknown",
                    model_used or "unknown",
                    len(model_matches),
                    tags,
                )

    try:
        mapping = request.app.state.db.client.indices.get_mapping(
            index=entity_type.lower()
        )
        props = (
            mapping.get(entity_type.lower(), {})
            .get("mappings", {})
            .get("properties", {})
        )
        for key, value in list(document_body.items()):
            field_mapping = props.get(key) or {}
            document_body[key] = normalize_empty_date_strings_for_mapping(
                value, field_mapping
            )
            value = document_body[key]
            field_type = field_mapping.get("type")
            if (
                entity_type.lower() == "contracttemplate"
                and key == "description"
                and field_type
                in ("integer", "long", "short", "byte", "float", "double")
            ):
                document_body["description_text"] = str(value)
                document_body.pop("description", None)
                continue
            if isinstance(value, (dict, list)):
                if field_type in ("text", "keyword"):
                    if (entity_type, key) in {
                        ("datasource", "shared_users"),
                        ("contract", "folder_path"),
                        ("contractfolder", "parent_path"),
                        ("clause", "keywords"),
                        ("clause", "tags"),
                        ("clause", "contract_types"),
                    }:
                        # OpenSearch text/keyword fields natively accept arrays of
                        # strings. Keep application list fields structured so the
                        # UI receives the same shape it submitted.
                        document_body[key] = value
                    else:
                        document_body[key] = json.dumps(value, ensure_ascii=False)
    except Exception:
        # Best effort only; don't block updates on mapping lookup issues.
        pass

    try:
        index_name = entity_type.lower()
        document_body["id"] = doc_id
        if index_name == "clause":
            # Clause vectors are maintained when the library record changes,
            # never while a contract is being searched.
            existing_clause = request.app.state.db.client.get(
                index=index_name, id=doc_id
            ).get("_source", {})
            document_body.update(
                request.app.state.db.prepare_structured_vector_fields(
                    index_name,
                    {**existing_clause, **document_body},
                )
            )
        if isinstance(document_body, dict):
            encrypt_sensitive_opensearch_document(entity_type, document_body)
        _clear_other_digihuman_drivers(request, entity_type, document_body, str(doc_id))
        request.app.state.db.client.update(
            index=index_name,
            id=doc_id,
            body={
                "doc": document_body,
                "doc_as_upsert": not finance_update_requires_existing,
            },
            refresh=True,
        )

        if (
            entity_type == FINANCE_BROKER_VALIDATE_PROMPTS_ENTITY
            and str(doc_id) == FINANCE_BROKER_VALIDATE_PROMPTS_CONTAINER_ID
        ):
            sync_finance_broker_validate_prompt_container(
                request.app.state.db,
                index_name=index_name,
                container_doc_id=str(doc_id),
                container_doc=document_body,
            )

        if entity_type in ("systemconfig", "system_config"):
            _sync_api_keys_to_chatui_config(request, document_body)

        if entity_type == "datasource":
            updated_doc = request.app.state.db.get_by_id("datasource", doc_id)
            updated_source = updated_doc.get("_source", {}) if updated_doc else {}
            updated_source["id"] = doc_id
            retention_service = IndexRetentionService(request.app.state.db)
            rename_cleanup = retention_service.cleanup_renamed_datasource_index(
                original_datasource_source, updated_source
            )
            logger.info(
                "Datasource rename cleanup datasource_id=%s result=%s",
                doc_id,
                rename_cleanup.get("status"),
            )
            try:
                registration_result = (
                    retention_service.ensure_datasource_index_registration(
                        updated_source
                    )
                )
                logger.info(
                    "Datasource index registration applied on update datasource_id=%s result=%s",
                    doc_id,
                    registration_result.get("status"),
                )
            except Exception as exc:
                logger.warning(
                    "Failed datasource index registration on update datasource_id=%s: %s",
                    doc_id,
                    exc,
                )
            try:
                shared_sync_result = sync_opensearchindex_shared_state(
                    request.app.state.db, updated_source
                )
                logger.info(
                    "Datasource shared state synced on update datasource_id=%s result=%s count=%s",
                    doc_id,
                    shared_sync_result.get("status"),
                    shared_sync_result.get("updated_count"),
                )
            except Exception as exc:
                logger.warning(
                    "Failed datasource shared sync on update datasource_id=%s: %s",
                    doc_id,
                    exc,
                )
            try:
                retention_result = retention_service.apply_retention_for_datasource(
                    updated_source
                )
                logger.info(
                    "Datasource retention applied on update datasource_id=%s result=%s",
                    doc_id,
                    retention_result.get("status"),
                )
            except Exception as exc:
                logger.warning(
                    "Failed to apply retention on datasource update datasource_id=%s: %s",
                    doc_id,
                    exc,
                )
            resync_datasource(
                request.app.state.scheduler,
                request.app.state.db,
                request.app.state.datasource_event_producer,
                updated_source,
            )
            if datasource_new_files:
                await emit_datasource_new_file_event(
                    request.app.state.datasource_event_producer,
                    str(doc_id),
                    datasource_new_files,
                    updated_source,
                )
        if entity_type == "workflow":
            updated_doc = request.app.state.db.get_by_id("workflow", doc_id)
            updated_source = updated_doc.get("_source", {}) if updated_doc else {}
            updated_source["id"] = doc_id
            schedule_workflow(
                request.app.state.scheduler,
                request.app.state.db,
                updated_source,
                request.app.state.registry,
                request.app.state.producer,
            )
        if entity_type == "evaluation":
            updated_doc = request.app.state.db.get_by_id("evaluation", doc_id)
            updated_source = updated_doc.get("_source", {}) if updated_doc else {}
            updated_source["id"] = doc_id
            schedule_evaluation(
                request.app.state.scheduler,
                request.app.state.db,
                updated_source,
            )
        return {"id": doc_id, "updated": True}
    except Exception as e:
        logger.error("ERROR updating: %s", e)
        raise HTTPException(500, "Failed to update document")


@router.patch("/compliance-rule/{doc_id}")
async def update_compliance_rule(
    request: Request,
    doc_id: str,
    request_data: Dict[str, Any] = Body(...),
):
    logger.info(
        "Received request to update document %s in compliancerule: %s",
        doc_id,
        request_data,
    )

    document = request_data.get("data", request_data)
    document_body = document.copy()
    document_body.pop("id", None)
    document_body.pop("_id", None)

    try:
        index_name = "compliancerule"
        document_body["id"] = doc_id
        await request.app.state.db.async_update_raw(
            index_name=index_name,
            doc_id=doc_id,
            body={"doc": document_body, "doc_as_upsert": True},
            refresh=True,
        )

        try:
            stored = await request.app.state.db.async_get_by_id(index_name, doc_id)
            stored_source = stored.get("_source", {}) if stored else {}
        except Exception:
            stored_source = {}
        payload = stored_source or {**document_body, "id": doc_id}
        await sync_compliance_rule_csv(payload)

        return {"id": doc_id, "updated": True}
    except Exception as e:
        logger.error("ERROR updating compliancerule: %s", e)
        raise HTTPException(500, "Failed to update document")


@router.get("/compliance-rule")
async def list_compliance_rules(
    request: Request,
    q: str = "*",
    skip: int = 0,
    limit: int = 100,
):
    try:
        response = await request.app.state.db.async_search(
            index="compliancerule",
            body={
                "from": skip,
                "size": limit,
                "query": {
                    "query_string": {
                        "query": str(q or "").strip(),
                        "default_operator": "OR",
                    }
                },
            },
        )
        hits = response.get("hits", {})
        total = hits.get("total", 0)
        result = {
            "total": total.get("value", 0) if isinstance(total, dict) else total,
            "raw_hits": hits.get("hits", []),
        }
    except Exception:
        logger.exception("Failed searching compliance rules")
        result = {"total": 0, "raw_hits": []}

    items = [
        {**hit["_source"], "_id": hit["_id"]} for hit in result.get("raw_hits", [])
    ]
    return {"total": result["total"], "items": items, "skip": skip, "limit": limit}


@router.patch("/documents/{entity_type}")
async def create_or_update_entity(entity_type: str, request: Request):
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")
    await _ensure_entity_write_permission(request, entity_type, "update")

    try:
        index_name = entity_type.lower()
        if not request.app.state.db.client.indices.exists(index=index_name):
            request.app.state.db.create_index(entity_type)

        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(400, "Invalid document payload")

        # If no document body is provided, this endpoint only creates the index.
        if not payload:
            return {"status": "index_created"}

        # Otherwise, treat as document update/create
        document = payload.get("data", payload)
        if not isinstance(document, dict):
            raise HTTPException(400, "Invalid document payload")
        doc_id = document.get("id") or str(uuid.uuid4())
        if entity_type == _CONTRACT_SHARE_ENTITY:
            existing_share_source = {}
            if document.get("id"):
                try:
                    existing_share = request.app.state.db.client.get(
                        index=entity_type, id=str(document["id"])
                    )
                    existing_share_source = existing_share.get("_source", {}) or {}
                except NotFoundError:
                    raise HTTPException(404, "Share record not found")
            document = await _prepare_resource_share_document(
                request, document, existing_share_source or None
            )
            doc_id = str(document.get("id") or doc_id)
        if entity_type == "organizationuser":
            doc_id = _prepare_organization_user_identity(
                request,
                document,
                str(doc_id),
            )
        if entity_type in _PRIVATE_CONTRACT_ENTITIES:
            existing_source: Dict[str, Any] = {}
            if document.get("id"):
                try:
                    existing = request.app.state.db.client.get(
                        index=index_name, id=str(document["id"])
                    )
                    existing_source = existing.get("_source", {}) or {}
                except NotFoundError:
                    existing_source = {}
            if existing_source:
                _ensure_contract_access(request, entity_type, existing_source, "edit")
            if not existing_source or _contract_document_belongs_to_owner(
                request, existing_source
            ):
                owner_email = _contract_owner_email(request)
                document["owner_email"] = owner_email
                document["created_by"] = owner_email
                document["created_by_email"] = owner_email
                if existing_source.get("organization_id"):
                    document["organization_id"] = existing_source["organization_id"]
                else:
                    try:
                        current_user, _expires_at = await get_current_user_from_request(
                            request
                        )
                        if current_user.get("organization_id"):
                            document["organization_id"] = current_user[
                                "organization_id"
                            ]
                    except Exception:
                        pass
            else:
                for owner_field in ("owner_email", "created_by", "created_by_email"):
                    document[owner_field] = existing_source.get(owner_field)
            if entity_type in {"contract_version", "contractreview"}:
                parent_contract_id = str(document.get("contract_id") or "").strip()
                if parent_contract_id:
                    try:
                        parent_contract = request.app.state.db.client.get(
                            index="contract", id=parent_contract_id
                        )
                    except NotFoundError as exc:
                        raise HTTPException(404, "Parent contract not found") from exc
                    _ensure_contract_access(
                        request,
                        "contract",
                        parent_contract.get("_source", {}) or {},
                        "edit",
                    )
                    parent_source = parent_contract.get("_source", {}) or {}
                    if not _contract_document_belongs_to_owner(request, parent_source):
                        inherited_owner = next(
                            (
                                parent_source.get(field)
                                for field in _CONTRACT_OWNER_FIELDS
                                if parent_source.get(field)
                            ),
                            None,
                        )
                        if inherited_owner:
                            document["owner_email"] = inherited_owner
                            document["created_by"] = inherited_owner
                            document["created_by_email"] = inherited_owner
        document["id"] = doc_id

        _clear_other_digihuman_drivers(request, entity_type, document, str(doc_id))

        success = request.app.state.db.index_document(entity_type, doc_id, document)
        if not success:
            raise HTTPException(500, "Failed to index document")

        return {"id": doc_id, "indexed": success}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in create_or_update_entity: {e}")
        raise HTTPException(500, str(e))


@router.patch("/documents/modeltraining")
async def create_modeltraining_index(request: Request):
    if "modeltraining" not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")

    success = request.app.state.db.create_index("modeltraining")
    if not success:
        raise HTTPException(500, "Failed to create modeltraining index")

    return {"status": "created", "index": "modeltraining"}


@router.get("/datasources/schedule/jobs")
async def view_scheduled_jobs(request: Request):
    """
    View all scheduled datasource sync jobs.
    """
    jobs = request.app.state.scheduler.view_jobs()
    job_list = [
        {
            "id": job.id,
            "next_run_time": (
                job.next_run_time.isoformat() if job.next_run_time else None
            ),
            "trigger": str(job.trigger),
        }
        for job in jobs
    ]
    return {"jobs": job_list}


@router.get("/datasource/{datasource_id}/api-console-result")
async def get_api_console_datasource_result(request: Request, datasource_id: str):
    try:
        ds_doc = request.app.state.db.get_by_id("datasource", datasource_id)
    except Exception as exc:
        raise HTTPException(404, f"Datasource not found: {exc}")

    source = ds_doc.get("_source", {}) if ds_doc else {}
    ds_type = str(source.get("type", "")).strip().lower()
    if ds_type != "rest_oauth_api":
        raise HTTPException(
            status_code=400,
            detail=f"API Console results are only available for rest_oauth_api datasource types, got '{ds_type}'",
        )

    index_name = resolve_api_console_result_index_name(source)

    try:
        result_doc = request.app.state.db.get_by_id(index_name, datasource_id)
    except Exception as exc:
        raise HTTPException(404, f"API Console result not found: {exc}")

    return {
        "datasource_id": datasource_id,
        "result_index": index_name,
        "result": result_doc.get("_source", {}) if result_doc else {},
    }


@router.post("/datasource/{datasource_id}/sync-now")
async def sync_datasource_now(request: Request, datasource_id: str):
    try:
        ds_doc = request.app.state.db.get_by_id("datasource", datasource_id)
    except Exception as exc:
        raise HTTPException(404, f"Datasource not found: {exc}")

    source = ds_doc.get("_source", {}) if ds_doc else {}

    jobs = getattr(request.app.state, "datasource_sync_jobs", None)
    if jobs is None:
        jobs = {}
        request.app.state.datasource_sync_jobs = jobs

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "job_id": job_id,
        "datasource_id": datasource_id,
        "status": "queued",
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
        "result": None,
        "error": None,
    }

    async def _run_sync_job():
        jobs[job_id]["status"] = "running"
        jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()
        try:
            # Datasource sync paths can invoke blocking network I/O in downstream
            # integrations; run in a worker thread so Kafka heartbeats on the
            # main event loop are not starved.
            result = await execute_datasource_sync_and_emit(
                db=request.app.state.db,
                datasource_id=datasource_id,
                source=source,
                event_publisher=request.app.state.datasource_event_producer,
                api_config=source.get("api_config", {}),
                force_run=True,
            )
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["result"] = result
            jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()
        except Exception as exc:
            logger.exception(
                "Datasource sync failed for datasource_id=%s job_id=%s",
                datasource_id,
                job_id,
            )
            jobs[job_id]["status"] = "failed"
            jobs[job_id]["error"] = str(exc)
            jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()

    asyncio.create_task(_run_sync_job())
    return {"job_id": job_id, "datasource_id": datasource_id, "status": "queued"}


@router.get("/datasource/sync-status/{job_id}")
async def datasource_sync_status(request: Request, job_id: str):
    jobs = getattr(request.app.state, "datasource_sync_jobs", {}) or {}
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Invalid job_id")
    return job


@router.post("/opensearchconnections/fetch_indexes/{connection_id}")
async def fetch_opensearch_indexes_by_connection(
    request: Request, connection_id: str, user_email: str = Body("default_user")
):
    """
    Fetch indexes using a connection visible to the authenticated request.
    """
    # Keep the caller's auth/tenant context instead of making an unauthenticated
    # loopback HTTP request. The shared search also handles response decryption.
    data = await simple_search(
        request=request,
        entity_type="opensearchconnection",
        q=f"id:{connection_id}",
        skip=0,
        limit=1,
    )

    if not data.get("items"):
        raise HTTPException(
            404, f"No OpenSearch connection found with id {connection_id}"
        )

    conn_data = data["items"][0]
    endpoint = conn_data["endpoint"]
    username = conn_data["username"]
    password = conn_data["password"]
    use_ssl = conn_data.get("use_ssl", True)

    db_temp = OpenSearchDB(
        host=endpoint, username=username, password=password, use_ssl=use_ssl
    )

    logger.debug(
        f"Fetching indexes from OpenSearch at {endpoint} for user {user_email}"
    )

    indexes = db_temp.fetch_all_indexes(user_email)
    if indexes is None:
        raise HTTPException(500, "Failed to fetch indexes from OpenSearch")

    return {"indexes": indexes}


# ---- add after the simple_search route ----
@router.post("/search/{entity_type}/query")
async def query_search(
    request: Request,
    entity_type: str,
    body: Dict[str, Any] = Body(...),  # full OpenSearch DSL
    skip: int = 0,
    limit: int = 100,
):
    entity_type = _normalize_entity_type(entity_type)
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(404, "Invalid entity_type")

    # body must contain a "query" key (OpenSearch DSL)
    if "query" not in body:
        raise HTTPException(400, "Request body must contain a 'query' object")

    index_name = entity_type.lower()
    if not request.app.state.db.client.indices.exists(index=index_name):
        request.app.state.db.create_index(entity_type)
    if entity_type == "contract_version":
        _ensure_contract_version_mapping(request)

    query_body = body.get("query")
    if not isinstance(query_body, dict):
        raise HTTPException(400, "Request body 'query' must be an object")
    if entity_type == _CONTRACT_SHARE_ENTITY:
        visible_share_ids = {
            str(source.get("id") or "").strip()
            for source in _contract_share_sources(request)
            if _resource_share_owner_matches(request, source)
            or _resource_share_recipient_matches(request, source)
        }
        access_should = (
            [{"terms": {"_id": sorted(visible_share_ids)}}]
            if visible_share_ids
            else [{"match_none": {}}]
        )
        query_body = {
            "bool": {
                "must": [
                    query_body,
                    {"bool": {"should": access_should, "minimum_should_match": 1}},
                ]
            }
        }
    if entity_type in _PRIVATE_CONTRACT_ENTITIES:
        query_body = _with_contract_access_filter(request, entity_type, query_body)
    query_body = _with_tenant_scope(request, index_name, query_body)

    search_body = {
        "from": skip,
        "size": limit,
        **body,  # allow size/from override in body
        "query": query_body,
    }

    try:
        hits = request.app.state.db._run_search(index_name, search_body)
        items = [
            {
                **_source_for_response(entity_type, hit.get("_source", {}) or {}),
                "_id": hit["_id"],
            }
            for hit in hits.get("hits", [])
        ]
        if entity_type == "opensearchindex":
            _attach_datasource_names_to_indexes(request.app.state.db, items)
            _attach_live_document_counts_to_indexes(request.app.state.db, items)
        return {
            "total": hits["total"]["value"],
            "items": items,
            "skip": skip,
            "limit": limit,
        }
    except Exception as e:
        raise HTTPException(500, f"Search failed: {str(e)}")


@router.post("/compliance-rule/query")
async def query_compliance_rules(
    request: Request,
    body: Dict[str, Any] = Body(...),
    skip: int = 0,
    limit: int = 100,
):
    if "query" not in body:
        raise HTTPException(400, "Request body must contain a 'query' object")

    search_body = {
        "from": skip,
        "size": limit,
        **body,
    }
    try:
        hits = request.app.state.db._run_search("compliancerule", search_body)
        items = [{**hit["_source"], "_id": hit["_id"]} for hit in hits.get("hits", [])]
        return {
            "total": hits["total"]["value"],
            "items": items,
            "skip": skip,
            "limit": limit,
        }
    except Exception as e:
        raise HTTPException(500, f"Search failed: {str(e)}")


@router.post("/genz/call")
@queued_indexing
async def call_genz_endpoint(request: Request, api_config: GenzRequest = Body(...)):
    """
    Call the GenZ API with provided configuration.
    Returns normalized response with message, file_count, and last_sync.
    """
    try:
        result = await call_genz_api(api_config.model_dump(), request.app.state.db)
        return result
    except Exception as e:
        logger.error(f"Error calling GenZ API: {e}")
        raise HTTPException(500, f"Failed to call GenZ API: {str(e)}")


@router.post("/zetaris_dm/call")
async def call_zetaris_endpoint(
    request: Request, api_config: Dict[str, Any] = Body(...)
):
    """
    Call the Zetaris API with provided configuration.
    Returns normalized response with datamarts, count, and last_sync.
    """
    try:
        result = zetaris_all_dm_api(api_config)
        return result
    except Exception as e:
        logger.error(f"Error calling Zetaris API: {e}")
        raise HTTPException(500, f"Failed to call Zetaris API: {str(e)}")


@router.post("/opensearch/file_count_by_type")
async def get_file_count_by_type(
    request: Request,
    username: str = Body(..., embed=True),
    types: List[str] = Body(..., embed=True),
):
    """
    Returns the total count of distinct files for a given username
    across all indexes matching the requested datasource types.

    Supports:
    - SharePoint / OneDrive: {username}-{type}-{resource}
    - Email: {username}_{email}_gmail
    - HubSpot: {username}_hubspot_{id}
    - Splunk: {username}_splunk_logs
    """

    client = request.app.state.db.client

    # Validate types
    # invalid_types = [t for t in types if t not in TYPE_INDEX_PATTERNS]
    # if invalid_types:
    #     raise HTTPException(
    #         status_code=400,
    #         detail=f"Unknown datasource types: {invalid_types}"
    #     )

    # Build list of (type, compiled_pattern) so we can know which type matched each index
    compiled_patterns = []
    for t in set(types):
        if t in ["sharepoint", "onedrive"]:
            # Pattern: {username}-{type}-{resource}
            pattern_str = f"^{username}-{t}-.*$"
        elif t in ["hubspot"]:
            # Pattern: {username}_hubspot_{id}
            pattern_str = f"^{username}_hubspot_.*$"
        elif t == "email":
            # Pattern: {username}_{email}_gmail
            pattern_str = f"^{username}_.+_(gmail|outlook)$"
        elif t == "splunk":
            # Pattern: {username}_splunk_logs
            pattern_str = f"^{username}_splunk_logs$"
        else:
            continue  # safety, though validation above should prevent this
        compiled_patterns.append((t, re.compile(pattern_str)))

    # Fetch all index names
    indices_response = client.cat.indices(format="json")
    all_index_names = [idx["index"] for idx in indices_response]

    # Match indexes based on username + type
    # Keep a mapping of index_name -> matched_type (first matching type)
    matched_indexes = {}
    for index_name in all_index_names:
        for t, pattern in compiled_patterns:
            if pattern.match(index_name):
                matched_indexes[index_name] = t
                break

    if not matched_indexes:
        return {
            "file_count": 0,
            "types": list(set(types)),
            "indexes_scanned": [],
        }

    # Count files per index individually and sum them
    total_files = 0
    for index_name, matched_type in matched_indexes.items():
        # Use 'pod_name' for splunk-type indexes, otherwise use 'source'
        field_to_count = "pod_name" if matched_type == "splunk" else "source"
        try:
            resp = client.search(
                index=index_name,
                body={
                    "size": 0,
                    "aggs": {
                        "distinct_count": {
                            "cardinality": {
                                "field": field_to_count,
                                "precision_threshold": 10000,
                            }
                        }
                    },
                },
            )
            # Add the file count from this index
            total_files += resp["aggregations"]["distinct_count"]["value"]
        except Exception as e:
            # If aggregation fails for this index (missing field etc.), log and continue
            logger.error(
                f"Error counting distinct {field_to_count} in index {index_name}: {e}"
            )
            continue

    # Result
    return {
        "file_count": total_files,
        "types": list(set(types)),
        "indexes_scanned": list(matched_indexes),
    }


@router.post("/opensearch/file_count")
async def get_file_count(request: Request, index_name: str = Body(...)):
    """
    Returns the distinct count of 'source' values in the given OpenSearch index. Representing distinct files.
    """
    response = request.app.state.db.client.search(
        index=index_name,
        body={
            "size": 0,
            "aggs": {
                "distinct_source_count": {
                    "cardinality": {
                        "field": "source",
                        "precision_threshold": 10000,  # optional, improves accuracy
                    }
                }
            },
        },
    )

    return response["aggregations"]["distinct_source_count"]["value"]
