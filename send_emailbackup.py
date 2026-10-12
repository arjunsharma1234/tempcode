import asyncio
import base64
import json
import os
import re
from email.message import EmailMessage
from html import escape
from io import BytesIO, StringIO
from pathlib import Path

import pandas as pd
from bs4 import BeautifulSoup

from llm_processors.llm_selector.llm_mapper import LLMMapper
from logger.privatai_logger import PrivateAILogger
from utils.noreply_gmail_service import (
    create_noreply_gmail_service,
    get_noreply_delegated_sender,
)
from utils.utils import _pfx, _tool_error
from tools.send_email.recipient_extractor import RecipientExtractor


logger = PrivateAILogger().get_logger()

LLM_RESPONSE_TIMEOUT_SECONDS = 210
EMAIL_TABLE_MAX_INLINE_ROWS = 10
NOREPLY_DELEGATED_SENDER = get_noreply_delegated_sender()


def normalize_mcp_dataframe(data):

    from io import StringIO

    import pandas as pd

    try:

        if data is None:
            return None

        # Already dataframe
        if isinstance(data, pd.DataFrame):
            return data

        # MCP nested list format
        if isinstance(data, list):

            flat = str(data)

            # extract markdown table
            lines = [line for line in flat.splitlines() if "|" in line]

            if len(lines) >= 2:

                cleaned = "\n".join(lines)

                try:
                    df = pd.read_csv(StringIO(cleaned), sep="|", engine="python")

                    # cleanup unnamed cols
                    df = df.loc[:, ~df.columns.str.contains("^Unnamed")]

                    return df

                except Exception as e:
                    logger.error(f"Markdown parse failed: {e}")

        # string markdown table
        if isinstance(data, str) and "|" in data:

            try:

                df = pd.read_csv(StringIO(data), sep="|", engine="python")

                df = df.loc[:, ~df.columns.str.contains("^Unnamed")]

                return df

            except Exception as e:
                logger.error(f"String parse failed: {e}")

        return None

    except Exception as e:
        logger.error(f"normalize_mcp_dataframe failed: {e}")
        return None


def build_default_email(
    workflow_summary=None,
    table_html=None,
    query=None,
):
    workflow_summary = workflow_summary if isinstance(workflow_summary, dict) else {}
    workflow_name = (
        workflow_summary.get("workflow_name")
        or workflow_summary.get("name")
        or "Workflow Execution Report"
    )
    workflow_status = (
        workflow_summary.get("workflow_status")
        or workflow_summary.get("status")
        or "completed"
    )
    query_text = str(query or "").strip()
    intro = "workflow has completed."
    if query_text and not workflow_summary:
        intro = "Please find the requested information below."

    html = f"""
    <html>
    <body>

    <h2>Workflow Execution Report</h2>

    <p>{intro}</p>

    <table>
        <tr>
            <td><b>Workflow</b></td>
            <td>{workflow_name}</td>
        </tr>

        <tr>
            <td><b>Status</b></td>
            <td>{workflow_status}</td>
        </tr>
    </table>

    {table_html or ""}

    <p>
    This email was generated automatically.
    </p>

    </body>
    </html>
    """

    return {
        "subject": f"{workflow_name} - {workflow_status}",
        "html": html,
    }


def _send_fallback_email(
    service,
    recipients,
    subject,
    html_body,
    log_prefix=None,
):
    results = {"sent_to": [], "failed": []}

    for recipient in recipients:
        try:
            msg = EmailMessage()
            msg.set_content("Fallback email text")
            msg.add_alternative(html_body, subtype="html")
            msg["To"] = recipient
            msg["From"] = NOREPLY_DELEGATED_SENDER
            msg["Subject"] = subject

            encoded_message = base64.urlsafe_b64encode(msg.as_bytes()).decode()
            create_message = {"raw": encoded_message}

            service.users().messages().send(userId="me", body=create_message).execute()
            results["sent_to"].append(recipient)
        except Exception as exc:
            logger.warning(
                "%sFallback email send failed recipient=%s error=%s",
                _pfx(log_prefix),
                recipient,
                exc,
            )
            results["failed"].append({"recipient": recipient, "error": str(exc)})

    if results["failed"]:
        return _tool_error(
            "Some fallback emails failed.",
            "email_send_error",
        ) | {"details": results}

    return {
        "success": True,
        "message": "Fallback emails sent successfully.",
        "details": results,
    }


async def _invoke_llm_with_single_retry(llm, prompt, log_prefix=None):
    max_attempts = 2

    for attempt in range(1, max_attempts + 1):

        response = await _invoke_llm_with_timeout_checkout(
            llm,
            prompt,
        )

        if response not in ("LLM_TIMEOUT", "LLM_FAILED"):
            return response

        logger.warning(
            "%sLLM failed on attempt %d/%d. Response=%s",
            _pfx(log_prefix),
            attempt,
            max_attempts,
            response,
        )

        if attempt < max_attempts:
            await asyncio.sleep(2)

    return response


def prepare_workflow_summary_internal(query, dataframe=None, log_prefix=None):

    trim_df = reduce_dataframe_for_prompt(
        dataframe,
        max_rows=10,
        log_prefix=log_prefix,
    )
    logger.info(
        "%sprepare_workflow_summary_internal input_type=%s trimmed_rows=%d "
        "trimmed_first=%s",
        _pfx(log_prefix),
        type(dataframe).__name__,
        len(trim_df) if isinstance(trim_df, list) else -1,
        str(trim_df[:1] if isinstance(trim_df, list) else trim_df)[:500],
    )

    final_prompt = f"{query}\n\nTrimmed dataframe for prompt: {trim_df}"
    logger.info(
        f"{_pfx(log_prefix)}Prepared workflow summary for internal send email process: {final_prompt}"
    )
    return final_prompt


def prepare_workflow_summary(query, dataframe=None, log_prefix=None):

    try:

        workflow_data = query

        workflow = workflow_data.get("workflow", {})

        execution = workflow_data.get("execution", {})

        final_data = {
            "workflow_name": workflow.get("workflow_name"),
            "workflow_status": execution.get("status"),
            "notification_recipients": workflow.get("notification_recipients", []),
            "steps": [],
        }

        for step in execution.get("step_outputs", []):

            tools_used = step.get("tools_used", [])

            output = step.get("output")

            step_info = {
                "step_name": step.get("agent_name"),
                "status": step.get("status"),
                "tools_used": tools_used,
                "error": step.get("error"),
            }

            # ------------------------------------
            # ASK DATAMART
            # ------------------------------------

            if tools_used and "ask_datamart" in str(tools_used):

                if dataframe is not None:

                    step_info["result"] = reduce_dataframe_for_prompt(
                        dataframe,
                        max_rows=10,
                        log_prefix=log_prefix,
                    )
                    step_info["note"] = "Datamart result attached separately."
                if dataframe is None:
                    step_info["result"] = None
                    step_info["note"] = None

                try:

                    parsed_output = json.loads(output)

                    step_info["result_status"] = parsed_output.get("status")

                except Exception:
                    pass

            # ------------------------------------
            # NORMAL OUTPUT
            # ------------------------------------

            else:

                step_info["result"] = output

            final_data["steps"].append(step_info)

        return final_data

    except Exception as e:

        return {
            "workflow_name": None,
            "workflow_status": "failed",
            "steps": [],
            "error": str(e),
        }


def reduce_dataframe_for_prompt(df, max_rows=10, log_prefix=None):

    try:

        logger.info(
            "%sreduce_dataframe_for_prompt input_type=%s max_rows=%s is_none=%s",
            _pfx(log_prefix),
            type(df).__name__,
            max_rows,
            df is None,
        )

        if df is None:
            logger.info(
                "%sreduce_dataframe_for_prompt returning [] because input is None",
                _pfx(log_prefix),
            )
            return []

        # Already list/dict
        if isinstance(df, list):
            logger.info(
                "%sreduce_dataframe_for_prompt list_len=%d first_item_type=%s",
                _pfx(log_prefix),
                len(df),
                type(df[0]).__name__ if df else "none",
            )
            return df[:max_rows]

        if isinstance(df, dict):
            logger.info(
                "%sreduce_dataframe_for_prompt dict_keys=%s",
                _pfx(log_prefix),
                sorted(df.keys())[:20],
            )
            return [df]

        # String case
        if isinstance(df, str):

            try:

                if not df.strip():
                    logger.info(
                        "%sreduce_dataframe_for_prompt returning [] because string dataframe is empty/blank",
                        _pfx(log_prefix),
                    )
                    return []

                lines = df.split("\n")

                lines = [line for line in lines if line.strip()]
                logger.info(
                    "%sreduce_dataframe_for_prompt string_chars=%d non_empty_lines=%d first_line=%r",
                    _pfx(log_prefix),
                    len(df),
                    len(lines),
                    lines[0][:300] if lines else "",
                )

                header = lines[:1]
                rows = lines[1 : max_rows + 1]

                limited_text = "\n".join(header + rows)

                return [{"text": limited_text}]
            except Exception as e:
                logger.error(
                    f"{_pfx(log_prefix)}Failed to process string dataframe: {e}"
                )

        # Pandas DataFrame
        if isinstance(df, pd.DataFrame):

            logger.info(
                "%sreduce_dataframe_for_prompt dataframe_shape=%s columns=%s",
                _pfx(log_prefix),
                df.shape,
                list(df.columns)[:30],
            )

            if df.empty:
                logger.info(
                    "%sreduce_dataframe_for_prompt returning [] because DataFrame is empty",
                    _pfx(log_prefix),
                )
                return []

            preview_df = df.head(max_rows)

            return preview_df.to_dict(orient="records")

        # Fallback
        return [{"value": str(df)}]

    except Exception as e:

        logger.error(f"{_pfx(log_prefix)}Failed to reduce dataframe for prompt: {e}")

        return []


def extract_json_from_llm_output(raw_output: str) -> dict:
    """
    Cleans LLM output and extracts first valid JSON object.
    Handles:
    - <think>...</think>
    - extra text before/after JSON
    """

    try:

        cleaned = re.sub(r"<think>.*?</think>", "", raw_output, flags=re.DOTALL)
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)

        if not match:
            raise ValueError("No JSON object found in LLM output")

        json_str = match.group(0)

        return json.loads(json_str)

    except Exception as e:
        raise ValueError(f"Failed to extract JSON: {str(e)}")


def dataframe_to_attachment(data, filename="data.csv"):
    if isinstance(data, pd.DataFrame):
        buffer = BytesIO()
        data.to_csv(buffer, index=False)
        buffer.seek(0)
        content = buffer.read()
    elif isinstance(data, bytes):
        content = data
    elif isinstance(data, str):
        content = data.encode("utf-8")
    else:
        content = str(data).encode("utf-8")

    return {
        "content": content,
        "maintype": "application",
        "subtype": "octet-stream",
        "filename": filename,
    }


def _is_daily_ar_or_ap_subject(subject) -> bool:
    normalized = str(subject or "").upper()
    report_keywords = (
        "DAILY AR",
        "DAILY AP",
        "PAYABLE",
        "PAYABLES",
        "RECEIVABLE",
        "RECEIVABLES",
    )
    return any(keyword in normalized for keyword in report_keywords)


def _looks_like_attachment_operation_request(query) -> bool:
    text = str(query or "").lower()
    attachment_terms = {
        "attachment",
        "attached",
        "excel",
        "xlsx",
        "workbook",
        "sheet",
        "tab",
        "file",
        "files",
        "report",
    }
    operation_terms = {
        "group by",
        "groupby",
        "seller wise",
        "seller-wise",
        "vendor wise",
        "customer wise",
        "split",
        "split into workbook",
        "split into workbooks",
        "separate workbook",
        "separate workbooks",
        "seperate workbook",
        "seperate workbooks",
        "separate excel",
        "separate excels",
        "seperate excel",
        "seperate excels",
        "sperate excel",
        "sperate excels",
        "separate file",
        "separate files",
        "seperate file",
        "seperate files",
        "one workbook per",
        "one excel per",
        "one file per",
        "separate sheet",
        "separate tab",
        "filter",
        "sort",
        "aggregate",
        "summarize",
        "summary",
        "pivot",
    }
    return any(term in text for term in attachment_terms) and any(
        term in text for term in operation_terms
    )


def _excel_col_name(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _normalized_column_name(column) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(column or "").strip().lower())


def _find_report_column(df: pd.DataFrame, candidates: set[str]) -> str | None:
    for column in df.columns:
        if _normalized_column_name(column) in candidates:
            return column
    return None


def _coerce_report_numeric(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype(str).str.replace(r"[$,]", "", regex=True).str.strip(),
        errors="coerce",
    )


def _dataframe_from_attachment_source(
    dataframe=None,
    resolved_dataframe=None,
    file_reference=None,
    log_prefix=None,
) -> pd.DataFrame | None:
    try:
        if file_reference:
            file_path = Path(str(file_reference).strip())
            if not file_path.is_file():
                return None
            suffix = file_path.suffix.lower()
            if suffix in {".xlsx", ".xls"}:
                return pd.read_excel(file_path, dtype=str, keep_default_na=False)
            return pd.read_csv(file_path, dtype=str, keep_default_na=False)

        source = dataframe if dataframe is not None else resolved_dataframe
        if source is None:
            return None
        if isinstance(source, pd.DataFrame):
            return source.copy()
        if (
            isinstance(source, list)
            and source
            and all(isinstance(item, dict) for item in source)
        ):
            return pd.DataFrame(source)
        if isinstance(source, dict):
            return pd.DataFrame([source])
        if isinstance(source, str) and source.strip():
            return pd.read_csv(
                StringIO(source.strip()),
                dtype=str,
                keep_default_na=False,
            )
    except Exception as exc:
        logger.warning(
            "%sFailed to build report dataframe for Excel attachment: %s",
            _pfx(log_prefix),
            exc,
        )
    return None


def _sort_daily_ar_ap_report(df: pd.DataFrame, log_prefix=None) -> pd.DataFrame:
    days_col = _find_report_column(
        df,
        {
            "daysoverdue",
            "overduedays",
            "daysdue",
            "duedays",
            "agingdays",
            "age",
        },
    )
    amount_col = _find_report_column(
        df,
        {
            "invoiceamount",
            "invoiceamt",
            "amount",
            "invoicevalue",
            "totalinvoiceamount",
            "balance",
            "outstandingamount",
            "dueamount",
        },
    )
    if not days_col or not amount_col:
        logger.warning(
            "%sSkipping Daily AR/AP custom sort. days_col=%s amount_col=%s",
            _pfx(log_prefix),
            days_col,
            amount_col,
        )
        return df

    sortable_df = df.copy()
    sortable_df["_daily_report_days_overdue_sort"] = _coerce_report_numeric(
        sortable_df[days_col]
    )
    sortable_df["_daily_report_invoice_amount_sort"] = _coerce_report_numeric(
        sortable_df[amount_col]
    )

    overdue_df = sortable_df[sortable_df["_daily_report_days_overdue_sort"] > 0]
    not_due_df = sortable_df[
        sortable_df["_daily_report_days_overdue_sort"].le(0)
        | sortable_df["_daily_report_days_overdue_sort"].isna()
    ]
    overdue_df = overdue_df.sort_values(
        by=[
            "_daily_report_days_overdue_sort",
            "_daily_report_invoice_amount_sort",
        ],
        ascending=[True, False],
        na_position="last",
        kind="mergesort",
    )
    not_due_df = not_due_df.sort_values(
        by=[
            "_daily_report_days_overdue_sort",
            "_daily_report_invoice_amount_sort",
        ],
        ascending=[True, False],
        na_position="last",
        kind="mergesort",
    )
    return pd.concat([overdue_df, not_due_df], ignore_index=True).drop(
        columns=[
            "_daily_report_days_overdue_sort",
            "_daily_report_invoice_amount_sort",
        ],
        errors="ignore",
    )


def _daily_ar_ap_excel_attachment(
    dataframe=None,
    resolved_dataframe=None,
    file_reference=None,
    subject=None,
    log_prefix=None,
):
    df = _dataframe_from_attachment_source(
        dataframe=dataframe,
        resolved_dataframe=resolved_dataframe,
        file_reference=file_reference,
        log_prefix=log_prefix,
    )
    if df is None:
        return None

    df = _sort_daily_ar_ap_report(df, log_prefix=log_prefix)
    df = df.fillna("")

    output = BytesIO()
    with pd.ExcelWriter(output, engine="xlsxwriter") as writer:
        sheet_name = "Report"
        workbook = writer.book
        worksheet = workbook.add_worksheet(sheet_name)
        writer.sheets[sheet_name] = worksheet

        header_format = workbook.add_format(
            {"bold": True, "font_color": "white", "bg_color": "#4472C4"}
        )
        pink_format = workbook.add_format({"bg_color": "#F4CCCC"})
        nude_format = workbook.add_format({"bg_color": "#FCE4D6"})

        worksheet.freeze_panes(1, 0)
        row_count, col_count = df.shape
        if col_count == 0:
            worksheet.write(0, 0, "No data", header_format)
        else:
            df.to_excel(
                writer,
                sheet_name=sheet_name,
                startrow=1,
                header=False,
                index=False,
            )
            columns = [{"header": str(column)} for column in df.columns]
            last_row = max(row_count, 1)
            worksheet.add_table(
                0,
                0,
                last_row,
                col_count - 1,
                {
                    "columns": columns,
                    "style": "Table Style Medium 9",
                    "autofilter": True,
                },
            )
            worksheet.set_row(0, None, header_format)

            amount_col = _find_report_column(
                df,
                {
                    "invoiceamount",
                    "invoiceamt",
                    "amount",
                    "invoicevalue",
                    "totalinvoiceamount",
                },
            )
            if amount_col and row_count:
                amount_idx = list(df.columns).index(amount_col)
                amount_letter = _excel_col_name(amount_idx)
                amount_value_formula = f'IFERROR(VALUE(SUBSTITUTE(SUBSTITUTE(${amount_letter}2,"$",""),",","")),0)'
                data_range = f"A2:{_excel_col_name(col_count - 1)}{row_count + 1}"
                worksheet.conditional_format(
                    data_range,
                    {
                        "type": "formula",
                        "criteria": f"={amount_value_formula}>=1000000",
                        "format": pink_format,
                    },
                )
                worksheet.conditional_format(
                    data_range,
                    {
                        "type": "formula",
                        "criteria": (
                            f'=AND(${amount_letter}2<>"",{amount_value_formula}<1000000)'
                        ),
                        "format": nude_format,
                    },
                )

            for idx, column in enumerate(df.columns):
                values = df[column].astype(str)
                max_width = max([len(str(column)), *values.map(len).tolist()])
                worksheet.set_column(idx, idx, min(max(max_width + 2, 10), 60))

    output.seek(0)
    safe_name = re.sub(r"[^A-Za-z0-9]+", "_", str(subject or "daily_report")).strip("_")
    filename = f"{safe_name or 'daily_report'}.xlsx"
    return {
        "content": output.read(),
        "maintype": "application",
        "subtype": "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "filename": filename,
    }


def _pydantic_attachment_operation(
    query,
    llm,
    dataframe=None,
    resolved_dataframe=None,
    file_reference=None,
    subject=None,
    log_prefix=None,
):
    if isinstance(query, dict) and isinstance(query.get("notification"), dict):
        return None
    if not _looks_like_attachment_operation_request(query):
        return None

    df = _dataframe_from_attachment_source(
        dataframe=dataframe,
        resolved_dataframe=resolved_dataframe,
        file_reference=file_reference,
        log_prefix=log_prefix,
    )
    if df is None or df.empty:
        return None

    try:
        from tools.send_email.attachment_pydantic_operations import (
            process_attachment_pydantic_operations,
        )

        safe_name = re.sub(
            r"[^A-Za-z0-9]+",
            "_",
            str(subject or "processed_attachment"),
        ).strip("_")
        attachment = process_attachment_pydantic_operations(
            query=str(query),
            dataframe=df,
            llm=llm,
            datamart_context={"subject": subject},
            default_filename=f"{safe_name or 'processed_attachment'}.xlsx",
            sort_receivables_payables=_is_daily_ar_or_ap_subject(subject),
        )
        if attachment:
            attachment.pop("operation", None)
        return attachment
    except Exception as exc:
        logger.warning(
            "%sPydantic attachment operation failed; falling back to default attachment flow: %s",
            _pfx(log_prefix),
            exc,
            exc_info=True,
        )
        return None


def _read_file_reference_preview(file_reference, max_rows=10, log_prefix=None):
    file_path = Path(str(file_reference).strip())
    lines = []

    try:
        with file_path.open("r", encoding="utf-8-sig") as handle:
            for line in handle:
                if not line.strip():
                    continue
                lines.append(line.rstrip("\n"))
                if len(lines) >= max_rows + 1:
                    break
    except Exception as exc:
        logger.warning(
            "%sFailed to read CSV preview from file reference %s: %s",
            _pfx(log_prefix),
            file_path,
            exc,
        )
        return None

    return "\n".join(lines) if lines else None


def _read_file_reference_full(file_reference, log_prefix=None):
    file_path = Path(str(file_reference).strip())

    lines = []

    try:
        with file_path.open("r", encoding="utf-8-sig") as handle:
            for line in handle:
                if not line.strip():
                    continue

                lines.append(line.rstrip("\n"))

    except Exception as exc:
        logger.warning(
            "%sFailed to read full CSV from file reference %s: %s",
            _pfx(log_prefix),
            file_path,
            exc,
        )
        return None

    return "\n".join(lines) if lines else None


def _resolve_dataframe_input(
    dataframe=None,
    file_reference=None,
    log_prefix=None,
):
    logger.info(
        "%sResolving dataframe input. Dataframe type: %s, File reference: %s",
        _pfx(log_prefix),
        type(dataframe),
        file_reference,
    )

    # ---------------------------------------------------------
    # File reference
    # ---------------------------------------------------------
    if file_reference:
        file_reference = str(file_reference).strip()

        if not file_reference:
            return None, None

        preview = _read_file_reference_preview(
            file_reference,
            log_prefix=log_prefix,
        )

        full = _read_file_reference_full(
            file_reference,
            log_prefix=log_prefix,
        )

        return preview, full

    # ---------------------------------------------------------
    # No input
    # ---------------------------------------------------------
    if dataframe is None:
        return None, None

    # ---------------------------------------------------------
    # DataFrame
    # ---------------------------------------------------------
    if isinstance(dataframe, pd.DataFrame):
        csv_data = dataframe.to_csv(index=False)
        return csv_data, csv_data

    # ---------------------------------------------------------
    # String
    # ---------------------------------------------------------
    if isinstance(dataframe, str):
        return dataframe, dataframe

    # ---------------------------------------------------------
    # List
    # ---------------------------------------------------------
    if isinstance(dataframe, list):
        if dataframe and all(isinstance(item, dict) for item in dataframe):
            csv_data = pd.DataFrame(dataframe).to_csv(index=False)
            return csv_data, csv_data

        value = str(dataframe)
        return value, value

    # ---------------------------------------------------------
    # Dict
    # ---------------------------------------------------------
    if isinstance(dataframe, dict):
        csv_data = pd.DataFrame([dataframe]).to_csv(index=False)
        return csv_data, csv_data

    # ---------------------------------------------------------
    # Fallback
    # ---------------------------------------------------------
    value = str(dataframe)
    return value, value


def _file_reference_to_attachment(file_reference, log_prefix=None):
    file_path = Path(str(file_reference).strip())
    if not file_path.is_file():
        logger.warning(
            "%sFile reference does not exist or is not a file: %s",
            _pfx(log_prefix),
            file_path,
        )
        return None

    try:
        return {
            "content": file_path.read_bytes(),
            "maintype": "application",
            "subtype": "octet-stream",
            "filename": file_path.name,
        }
    except Exception as exc:
        logger.warning(
            "%sFailed to read attachment bytes from file reference %s: %s",
            _pfx(log_prefix),
            file_path,
            exc,
        )
        return None


def _coerce_dataframe_for_email_table(dataframe, log_prefix=None):
    if dataframe is None:
        return None

    try:
        if isinstance(dataframe, pd.DataFrame):
            return dataframe

        if isinstance(dataframe, list):
            if dataframe and all(isinstance(item, dict) for item in dataframe):
                return pd.DataFrame(dataframe)
            dataframe = str(dataframe)

        if isinstance(dataframe, dict):
            return pd.DataFrame([dataframe])

        if isinstance(dataframe, str):
            text = dataframe.strip()
            if not text:
                return None

            if "|" in text and "\n" in text:
                parsed = normalize_mcp_dataframe(text)
                if isinstance(parsed, pd.DataFrame) and not parsed.empty:
                    return parsed

            try:
                return pd.read_csv(
                    StringIO(text),
                    dtype=str,
                    keep_default_na=False,
                )
            except Exception as csv_error:
                logger.info(
                    "%sCould not parse dataframe string as CSV for email table: %s",
                    _pfx(log_prefix),
                    csv_error,
                )
                return None

        return None
    except Exception as exc:
        logger.warning(
            "%sFailed to coerce dataframe for deterministic email table: %s",
            _pfx(log_prefix),
            exc,
        )
        return None


def _merge_table_style(match) -> str:
    attrs = match.group(1)
    attrs = re.sub(
        r"\s*style\s*=\s*(['\"]).*?\1",
        "",
        attrs,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return (
        "<table "
        "style='width:100%; border-collapse:collapse; table-layout:auto; "
        f"font-family:Arial,sans-serif;'{attrs}>"
    )


def _apply_legacy_email_table_cell_style(match) -> str:
    tag = match.group(1)
    attrs = re.sub(
        r"\s*style\s*=\s*(['\"]).*?\1",
        "",
        match.group(2),
        flags=re.IGNORECASE | re.DOTALL,
    )
    return (
        f"<{tag}{attrs} "
        "style='padding:10px; border:1px solid #ddd; "
        "white-space:nowrap; vertical-align:top;'>"
    )


def _render_dataframe_html_table(
    df: pd.DataFrame,
    full_df: pd.DataFrame,
    log_prefix=None,
) -> str | None:
    if df is None or df.empty:
        return None

    row_count, col_count = full_df.shape

    logger.info(
        "%sRendering deterministic email table rows=%d cols=%d max_inline_rows=%d",
        _pfx(log_prefix),
        row_count,
        col_count,
        EMAIL_TABLE_MAX_INLINE_ROWS,
    )

    # ---------------------------------------------------------
    # LARGE DATAFRAME:
    # Do NOT render the dataframe rows in the email.
    # The complete dataframe will remain available in CSV.
    # Render only ONE ROW x ONE COLUMN.
    # ---------------------------------------------------------
    if row_count > EMAIL_TABLE_MAX_INLINE_ROWS:
        logger.info(
            "%sDataframe exceeds inline row limit. "
            "Rendering single-cell summary table only.",
            _pfx(log_prefix),
        )

        summary_df = pd.DataFrame(
            {
                "Result": [
                    f"{row_count:,} rows returned. "
                    "Complete results are available in the attachment."
                ]
            }
        )

        from pretty_html_table import build_table

        table_html = build_table(
            summary_df,
            "blue_light",
            font_family="Arial, sans-serif",
            font_size="12px",
            text_align="left",
            width="100%",
        )

        table_html = re.sub(
            r"<table([^>]*)>",
            _merge_table_style,
            table_html,
            count=1,
        )

        table_html = re.sub(
            r"<thead[^>]*>\s*<tr[^>]*>",
            "<thead>\n" "    <tr style='background:#f4f4f4; text-align:left;'>",
            table_html,
            count=1,
            flags=re.IGNORECASE,
        )

        table_html = re.sub(
            r"<(td|th)\b([^>]*)>",
            _apply_legacy_email_table_cell_style,
            table_html,
        )

        return "<div style='overflow-x:auto; width:100%;'>" f"{table_html}" "</div>"

    # ---------------------------------------------------------
    # SMALL DATAFRAME:
    # Render the actual dataframe normally.
    # ---------------------------------------------------------
    display_df = df.fillna("")

    logger.info(
        "%sRendering full dataframe inline rows=%d cols=%d",
        _pfx(log_prefix),
        row_count,
        col_count,
    )

    from pretty_html_table import build_table

    table_html = build_table(
        display_df,
        "blue_light",
        font_family="Arial, sans-serif",
        font_size="12px",
        text_align="left",
        width="100%",
    )

    table_html = re.sub(
        r"<table([^>]*)>",
        _merge_table_style,
        table_html,
        count=1,
    )

    table_html = re.sub(
        r"<thead[^>]*>\s*<tr[^>]*>",
        "<thead>\n" "    <tr style='background:#f4f4f4; text-align:left;'>",
        table_html,
        count=1,
        flags=re.IGNORECASE,
    )

    table_html = re.sub(
        r"<(td|th)\b([^>]*)>",
        _apply_legacy_email_table_cell_style,
        table_html,
    )

    logger.info(
        "%sRendered email table with pretty_html_table",
        _pfx(log_prefix),
    )

    return "<div style='overflow-x:auto; width:100%;'>" f"{table_html}" "</div>"


def _cleanup_file_reference(file_reference=None, log_prefix=None):
    if not file_reference:
        return

    file_path = str(file_reference).strip()
    if not file_path:
        return

    try:
        if os.path.isfile(file_path):
            os.remove(file_path)
            logger.info(
                "%sDeleted temporary file reference %s", _pfx(log_prefix), file_path
            )
    except Exception as exc:
        logger.warning(
            "%sFailed to delete temporary file reference %s: %s",
            _pfx(log_prefix),
            file_path,
            exc,
        )


async def render_email_html_prompt(query, log_prefix=None):
    instruction = """
    You are an AI that generates production-ready HTML email content for Gmail.

    TASK:
    Based on the user query, produce both:
    1. A subject line for the email
    2. A full HTML email body that MATCHES the existing template structure below.

    !!! IMPORTANT TEMPLATE REQUIREMENT !!!
    The HTML MUST follow EXACTLY this structural wrapper:

    <html>
    <body style="font-family: 'Segoe UI', Arial, sans-serif; color:#333; margin:0; padding:0; background-color:#f7f7f7;">
        <table style="width:100%; max-width:800px; margin:20px auto; border:1px solid #ddd; border-radius:8px; background-color:#fff; overflow:hidden;">
            <tr>
                <td style="background-color:#27a7d2; color:#fff; padding:20px; text-align:center; font-size:24px;">
                    <strong>{HEADER_TITLE}</strong>
                </td>
            </tr>
            <tr>
                <td style="padding:20px;">
                    <p style="font-size:18px;">{GREETING}</p>
                    {BODY_CONTENT}
                    <p style="font-size:16px; margin-top:20px;">{FOOTER}</p>
                </td>
            </tr>
        </table>
    </body>
    </html>

    !!! RULES !!!
    - Replace {HEADER_TITLE}, {GREETING}, {FOOTER} with values from the query.
    - If values do not exist in query: use defaults
    - HEADER_TITLE default: "Important Info"
    - GREETING default: "Hi,"
    - FOOTER default: "Thanks"
    - BODY_CONTENT always contain text related to subject very prominently and a table if present.

    IF TABULAR DATA IS DETECTED:
    if already pre-rendered table HTML is provided, use it as-is in BODY_CONTENT.

    Else:
        - Convert tabular info into a clean <table> using <table>, <tr>, <th>, <td> with inline styles.
        - Table style must be:
        <table style='width:100%; border-collapse:collapse; table-layout:auto; font-family:Arial,sans-serif;'>
        Header row style: <tr style='background:#f4f4f4; text-align:left;'>
        Cell style: 'padding:10px; border:1px solid #ddd; white-space:nowrap; vertical-align:top;'
        - Do not Truncate the tabular data. need complete data ensure it is still fully included.
        if table column or rows too much more than 15 column and 50 rows you can consider first 50 rows correctly without structure break

    IMPORTANT:
        - Never allow table cell values to wrap onto multiple lines.
        - Dates, IDs, account numbers, emails, and numeric values must remain on a single line.
        - Every <td> must include:
        white-space: nowrap;
        - Do not insert <br> tags inside table cells.

    IF NO TABULAR DATA:
    - Insert the content as <p> text inside BODY_CONTENT.

    IF the content contains:
        - SQL query failed
        - Database query failed
        - schema error
        - missing column
        - traceback
        - exception
        - error messages
        - headers error
        - empty result
        - Followup Question

        THEN:
        - Do NOT include the raw error in the email
        - Do NOT include SQL queries
        - Do NOT include stack traces
        - Instead send a professional message:

        "No data available for the requested query."

        OR

        "The query could not be completed successfully."

        - Never expose internal database/schema errors to users.

    HTML RESTRICTIONS:
    - Must be valid HTML.
    - Must use inline CSS only.
    - Must not escape HTML.
    - No Markdown.
    - No commentary.
    - No additional wrapping outside the required template.
    - No hallucinated data.

    STRICT: USER QUERY MAY CONTAIN ADDITIONAL INSTRUCTIONS.
         You should follow instructions found inside the query and can override the defaults above if specified in the query. and ignore pydnantic instructions in body text if any.
    Never Add Sql queries, error messages, or stack traces to the email content

    - Do not include any instructions,Followup Question, thoughts,thinking or explanations in the output. Only return the JSON with subject and html.

    - You MUST NOT include:
       - <think>...</think>
       - explanations
       - comments
    - Output MUST be valid JSON ONLY.
    - Do not prefix or suffix the JSON with any text.

    OUTPUT FORMAT (STRICT JSON):
    {
        "subject": "string",
        "html": "<html> ... valid email html ... </html>"
    }

    USER QUERY:
    """
    final_prompt = f"{instruction}\n\n{query}"
    logger.info(f"{_pfx(log_prefix)}Sending prompt to LLM: {final_prompt}")
    return final_prompt


def create_service():
    try:
        return create_noreply_gmail_service()
    except Exception as e:
        return None, f"Error creating Gmail service: {str(e)}"


async def _invoke_llm_with_timeout(llm, prompt):
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(llm.invoke, prompt),
            timeout=LLM_RESPONSE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise TimeoutError("LLM response timed out after 3.5 minutes.") from exc


async def _invoke_llm_with_timeout_checkout(llm, prompt):
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(llm.invoke, prompt),
            timeout=LLM_RESPONSE_TIMEOUT_SECONDS,
        )

    except asyncio.TimeoutError:
        return "LLM_TIMEOUT"

    except Exception:
        return "LLM_FAILED"


async def function_tools_email(
    query: dict | str,
    excluded_columns: str,
    use_model: str,
    framework: str,
    key: str,
    username: str,
    endpoint: str = None,
    dataframe=None,
    file_reference=None,
    log_prefix=None,
    recipient_mode: str = "regex",
):
    try:
        return await _function_tools_email_impl(
            query=query,
            excluded_columns=excluded_columns,
            use_model=use_model,
            framework=framework,
            key=key,
            username=username,
            endpoint=endpoint,
            dataframe=dataframe,
            file_reference=file_reference,
            log_prefix=log_prefix,
            recipient_mode=recipient_mode,
        )
    finally:
        _cleanup_file_reference(file_reference, log_prefix=log_prefix)


async def _function_tools_email_impl(
    query: dict | str,
    excluded_columns: str,
    use_model: str,
    framework: str,
    key: str,
    username: str,
    endpoint: str = None,
    dataframe=None,
    file_reference=None,
    log_prefix=None,
    recipient_mode: str = "regex",
):
    prefix = _pfx(log_prefix)
    logger.info(
        f"{prefix}Entered function_tools_email with query with type of {type(query)} and content: {query}"
    )
    query_str = str(query)
    notification = query.get("notification") if isinstance(query, dict) else None
    notification = notification if isinstance(notification, dict) else {}

    llm = None
    if isinstance(notification, dict) and "to" in notification:
        to = notification["to"]
        recipients = [to] if isinstance(to, str) else list(to or [])
        recipients = list(dict.fromkeys(recipients))
    elif recipient_mode == "llm":
        try:
            llm_mapper = LLMMapper(
                use_model=use_model,
                framework=framework,
                key=key,
                endpoint=endpoint,
                llm_provider="langchain",
            )
            llm_mapper.construct_llm()
            llm = llm_mapper.model
            recipients = await RecipientExtractor(mode="llm", llm=llm).extract(
                query_str
            )
        except Exception as exc:
            logger.error("%sRecipient extraction failed: %s", prefix, exc)
            return _tool_error(
                f"Recipient extraction failed: {exc}", "recipient_extraction_error"
            )
    else:
        recipients = list(set(re.findall(r"[\w\.-]+@[\w\.-]+\.\w+", query_str)))
    logger.info(f"{prefix}Extracted recipients: {recipients}")

    if not recipients:
        return _tool_error("No recipients found in query.", "validation_error")

    resolved_dataframe, resolved_full_dataframe = _resolve_dataframe_input(
        dataframe=dataframe,
        file_reference=file_reference,
        log_prefix=log_prefix,
    )
    table_dataframe = _coerce_dataframe_for_email_table(
        resolved_dataframe,
        log_prefix=log_prefix,
    )

    table_full_dataframe = _coerce_dataframe_for_email_table(
        resolved_full_dataframe,
        log_prefix=log_prefix,
    )

    table_html = None
    if table_dataframe is not None and not table_dataframe.empty:
        table_html = _render_dataframe_html_table(
            table_dataframe,
            table_full_dataframe,
            log_prefix=log_prefix,
        )

    workflow_summary = None
    if "internal_send_email_process" in str(query):

        workflow_summary = query
        if table_html:
            workflow_summary = (
                f"{workflow_summary}\n\n"
                "Pre-rendered dataframe HTML table. Use this table HTML as-is in the email body; "
                f"do not recreate the table:\n{table_html}"
            )

    if isinstance(query, dict) and "internal_send_email_process" not in query:
        workflow_summary = prepare_workflow_summary(
            query,
            dataframe=resolved_dataframe,
            log_prefix=log_prefix,
        )
        if table_html:
            workflow_summary = (
                f"{workflow_summary}\n\n"
                "Pre-rendered dataframe HTML table. Use this table HTML as-is in the email body; "
                f"do not recreate the table:\n{table_html}"
            )

    service = create_service()
    if isinstance(service, tuple):
        return _tool_error(service[1], "gmail_service_error")

    try:
        if llm is None:
            llm_mapper = LLMMapper(
                use_model=use_model,
                framework=framework,
                key=key,
                endpoint=endpoint,
                llm_provider="langchain",
            )
            llm_mapper.construct_llm()
            llm = llm_mapper.model

        if "internal_send_email_process" in query_str:
            prompt = await render_email_html_prompt(
                workflow_summary, log_prefix=log_prefix
            )

            try:
                response = await _invoke_llm_with_single_retry(
                    llm,
                    prompt,
                    log_prefix=log_prefix,
                )

                # LLM unavailable after all retries
                if response in ("LLM_TIMEOUT", "LLM_FAILED"):

                    logger.warning(
                        "%sLLM failed after all retries. Using deterministic email.",
                        prefix,
                    )

                    if table_html:
                        fallback = build_default_email(
                            query=query,
                            workflow_summary=workflow_summary,
                            table_html=table_html,
                        )

                        return _send_fallback_email(
                            service=service,
                            recipients=recipients,
                            subject=fallback["subject"],
                            html_body=fallback["html"],
                            log_prefix=log_prefix,
                        )

                    return _tool_error(
                        "LLM unavailable and no fallback table available.",
                        "llm_unavailable",
                    )

                # Success
                raw_output = (
                    response.content if hasattr(response, "content") else response
                )

            except Exception as e:

                logger.exception(
                    "%sUnexpected error while generating email: %s",
                    prefix,
                    e,
                )

                if table_html:
                    fallback = build_default_email(
                        query=query,
                        workflow_summary=workflow_summary,
                        table_html=table_html,
                    )

                    return _send_fallback_email(
                        service=service,
                        recipients=recipients,
                        subject=fallback["subject"],
                        html_body=fallback["html"],
                        log_prefix=log_prefix,
                    )

                raise

        if isinstance(query, str) and "internal_send_email_process" not in query_str:
            prompt_input = query
            if table_html:
                prompt_input = (
                    f"{query}\n\n"
                    "Pre-rendered dataframe HTML table. Use this table HTML as-is in the email body; "
                    f"do not recreate the table:\n{table_html}"
                )

            prompt = await render_email_html_prompt(prompt_input, log_prefix=log_prefix)
            response = await _invoke_llm_with_timeout(llm, prompt)
            raw_output = response.content if hasattr(response, "content") else response

        if isinstance(query, dict) and "internal_send_email_process" not in query_str:
            prompt = await render_email_html_prompt(
                workflow_summary, log_prefix=log_prefix
            )
            response = await _invoke_llm_with_timeout(llm, prompt)
            raw_output = response.content if hasattr(response, "content") else response
    except TimeoutError as e:
        logger.error(f"{prefix}Send email LLM timed out: {e}")
        return _tool_error(str(e), "llm_timeout")
    except Exception as e:
        logger.error(f"{prefix}Send email LLM processing failed: {e}")
        return _tool_error(
            f"Send email LLM processing failed: {e}", "llm_processing_error"
        )

    logger.info(f"{prefix}Raw LLM output: {raw_output}")

    try:
        extracted = extract_json_from_llm_output(raw_output)
        subject = extracted.get("subject", "Notification")
        html_body = extracted.get("html", "<html><body>No content.</body></html>")
        if notification:
            subject = notification.get("subject") or subject
            sections = notification.get("body_sections") or {}
            if sections:
                section_html = "".join(
                    '<div style="margin:16px 0;font-family:Arial,sans-serif;">'
                    f"<p><strong>{escape(str(title))}</strong></p>"
                    '<div style="white-space:pre-wrap;overflow-wrap:anywhere;">'
                    f"{escape(str(text or ''))}</div></div>"
                    for title, text in sections.items()
                )
                soup = BeautifulSoup(html_body, "html.parser")
                content = BeautifulSoup(section_html, "html.parser")
                tables = soup.find_all("table")
                if tables:
                    tables[-1].insert_after(content)
                else:
                    (soup.body or soup).append(content)
                html_body = str(soup)

    except Exception as e:
        logger.error(f"{prefix}Failed to parse LLM JSON output: {e}")
        return _tool_error("Invalid LLM output format.", "llm_output_error")

    results = {"sent_to": [], "failed": []}
    attachment = None

    attachment = _pydantic_attachment_operation(
        query=query,
        llm=llm,
        dataframe=dataframe,
        resolved_dataframe=resolved_full_dataframe,
        file_reference=file_reference,
        subject=subject,
        log_prefix=log_prefix,
    )
    if attachment:
        logger.info(
            "%sPrepared query-driven pydantic Excel attachment: %s",
            prefix,
            attachment.get("filename"),
        )

    if attachment is None and _is_daily_ar_or_ap_subject(subject):
        attachment = _daily_ar_ap_excel_attachment(
            dataframe=dataframe,
            resolved_dataframe=resolved_full_dataframe,
            file_reference=file_reference,
            subject=subject,
            log_prefix=log_prefix,
        )
        if attachment:
            logger.info(
                "%sPrepared formatted Daily AR/AP Excel attachment: %s",
                prefix,
                attachment["filename"],
            )
        else:
            logger.warning(
                "%sCould not prepare Daily AR/AP Excel attachment. Falling back to default attachment.",
                prefix,
            )

    if attachment is None and file_reference:
        attachment = _file_reference_to_attachment(
            file_reference, log_prefix=log_prefix
        )
    elif attachment is None and resolved_dataframe is not None:
        try:
            logger.info(f"{prefix}Processing dataframe once for email attachment.")
            csv_payload = None
            if isinstance(resolved_dataframe, str):
                logger.info(
                    f"{prefix}Resolved dataframe is a string, using as CSV payload."
                )
                csv_payload = resolved_dataframe.strip()
            elif isinstance(resolved_dataframe, pd.DataFrame):
                logger.info(
                    f"{prefix}Resolved dataframe is a DataFrame, converting to CSV payload."
                )
                csv_payload = resolved_dataframe.to_csv(index=False)
            elif isinstance(resolved_dataframe, list):
                logger.info(
                    f"{prefix}Resolved dataframe is a list, checking if it contains dicts."
                )
                if resolved_dataframe and all(
                    isinstance(item, dict) for item in resolved_dataframe
                ):
                    csv_payload = pd.DataFrame(resolved_dataframe).to_csv(index=False)
                else:
                    csv_payload = str(resolved_dataframe)
            elif isinstance(resolved_dataframe, dict):
                logger.info(
                    f"{prefix}Resolved dataframe is a dict, converting to DataFrame and then to CSV payload."
                )
                csv_payload = pd.DataFrame([resolved_dataframe]).to_csv(index=False)

            if csv_payload:
                attachment = dataframe_to_attachment(csv_payload)
        except Exception as e:
            logger.error(f"{prefix}Failed to process dataframe: {e}")

    attachments = []
    if attachment:
        if isinstance(attachment.get("attachments"), list):
            attachments.extend(attachment["attachments"])
        else:
            attachments.append(attachment)
    try:
        attachments.extend(
            dataframe_to_attachment(
                base64.b64decode(item["content_base64"], validate=True),
                filename=item["filename"],
            )
            for item in notification.get("attachments") or []
        )
    except (KeyError, TypeError, ValueError) as exc:
        return _tool_error(f"Invalid email attachment: {exc}", "validation_error")

    for recipient in recipients:
        try:
            msg = EmailMessage()
            msg.set_content("Fallback email text")
            msg.add_alternative(html_body, subtype="html")

            for email_attachment in attachments:
                msg.add_attachment(
                    email_attachment["content"],
                    maintype=email_attachment["maintype"],
                    subtype=email_attachment["subtype"],
                    filename=email_attachment["filename"],
                )

            msg["To"] = recipient
            msg["From"] = NOREPLY_DELEGATED_SENDER
            msg["Subject"] = subject

            encoded_message = base64.urlsafe_b64encode(msg.as_bytes()).decode()
            create_message = {"raw": encoded_message}

            service.users().messages().send(userId="me", body=create_message).execute()

            results["sent_to"].append(recipient)

        except Exception as e:
            results["failed"].append({"recipient": recipient, "error": str(e)})

    success = len(results["failed"]) == 0
    if not success:
        return _tool_error(
            "Some emails failed.",
            "email_send_error",
        ) | {"details": results}

    return {"success": True, "message": "Emails sent successfully.", "details": results}

