/* eslint-disable react/prop-types */
import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Info, RotateCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  GitBranch,
  Plus,
  Play,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  Loader2,
  Database,
  Lock,
  Calendar,
  History,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { versionControlApiUrl } from "@/lib/versionControlApi";
import { format } from "date-fns";
import { toast } from "sonner";

const AVAILABLE_ENTITIES = [
  { id: "SystemConfig", label: "System Configurations", index: "systemconfig" },
  { id: "Tool", label: "Tools", index: "tool" },
  { id: "Agent", label: "AI Agents", index: "agent" },
  { id: "Workflow", label: "Workflows", index: "workflow" },
  { id: "WorkflowTemplate", label: "Workflow Templates", index: "workflowtemplate" },
  { id: "DataSource", label: "Data Sources", index: "datasource" },
  { id: "OpenSearchIndex", label: "OpenSearch Indexes", index: "opensearchindex" },
  {id: "OpenSearchConnection",label: "OpenSearch Connections", index: "opensearchconnection"},
  { id: "OpenSearchAlias", label: "OpenSearch Aliases", index: "opensearchalias" },
  { id: "Organization", label: "Organizations", index: "organization" },
  { id: "OrganizationUser", label: "Organization Users", index: "organizationuser" },
  {
    id: "digihumanchatuiconfigs",
    label: "DigiHuman Chat UI Configs",
    index: "digihumanchatuiconfigs",
  },
  { id: "APIToken", label: "API Tokens", index: "api_token" },
  { id: "ResourceShare", label: "Resource Shares", index: "resource_share" },
  {
    id: "CustomerDocumentBatch",
    label: "Customer Document Batches",
    index: "smart_docs_customerdocumentbatch",
  },
  {
    id: "CustomerDocument",
    label: "Customer Documents",
    index: "smart_docs_customerdocument",
  },
  { id: "ComplianceRule", label: "Compliance Rules", index: "compliancerule" },
  {
    id: "SmartDocsValidatePrompts",
    label: "SmartDoc Analyst Validation Prompts",
    index: "smart_docs_validate_prompts",
  },
  {
    id: "smart_docs_ai_analysis_prompt",
    label: "SmartDoc Analyst AI Analysis Prompt",
    index: "smart_docs_ai_analysis_prompt",
  },
  { id: "feedback", label: "Feedback", index: "feedback" },
  {
    id: "digiavatar_feedback_staged",
    label: "DigiAvatar Feedback Staged",
    index: "digiavatar_feedback_staged",
  },
  {
    id: "digiavatar_feedback_rejected",
    label: "DigiAvatar Feedback Rejected",
    index: "digiavatar_feedback_rejected",
  },
  {
    id: "digiavatar_filtered_new",
    label: "DigiAvatar Filtered New",
    index: "digiavatar_filtered_new",
  },
  {
    id: "digiavatar_filtered",
    label: "DigiAvatar Filtered",
    index: "digiavatar_filtered",
  },
  { id: "Contract", label: "Contracts", index: "contract" },
  { id: "Clause", label: "Clauses", index: "clause" },
  { id: "KnowledgeGraph", label: "Knowledge Graphs", index: "knowledgegraph" },
  { id: "ModelTraining", label: "Model Training Jobs", index: "modeltraining" },
  { id: "ChatConversation", label: "Chat Conversations", index: "chatconversation" },
  { id: "ChatMessage", label: "Chat Messages", index: "chatmessage" },
  { id: "Evaluation", label: "Evaluations", index: "evaluation" },
];

const AVAILABLE_BACKUP_INDEXES = AVAILABLE_ENTITIES.map((entity) => entity.index);
const ENTITY_INDEX_BY_ID = Object.fromEntries(
  AVAILABLE_ENTITIES.map((entity) => [entity.id, entity.index])
);
const LEGACY_SMART_DOC_BACKUP_INDEXES = {
  customerdocumentbatch: "smart_docs_customerdocumentbatch",
  customerdocument: "smart_docs_customerdocument",
};

const formatApiErrorDetail = (detail) => {
  if (!detail) return "";
  if (typeof detail === "string") return detail;

  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        const location = Array.isArray(item?.loc)
          ? ` (${item.loc.join(" → ")})`
          : "";
        return `${item?.msg || JSON.stringify(item)}${location}`;
      })
      .join("; ");
  }

  return detail.message || detail.msg || JSON.stringify(detail);
};

export default function GitBackupPanel({ configs, backupHistory }) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingConfigId, setEditingConfigId] = useState(null);

  const [selectedRestoreIndexes, setSelectedRestoreIndexes] = useState([]);

  const [recoverableBackups, setRecoverableBackups] = useState({});
  const [loadingRecoverableBackups, setLoadingRecoverableBackups] =
    useState(true);

  const [newConfig, setNewConfig] = useState({
    name: "",
    provider: "github",
    api_token: "",
    repository_url: "",
    branch: "release",
    overwrite_existing: true,
    backup_frequency: "weekly",
    entities_to_backup: AVAILABLE_ENTITIES.map((e) => e.id),
  });
  const [editConfig, setEditConfig] = useState({
    name: "",
    provider: "github",
    api_token: "",
    repository_url: "",
    branch: "release",
    backup_frequency: "weekly",
    overwrite_existing: true,
    entities_to_backup: [],
  });

  const [backupStatus, setBackupStatus] = useState({});
  const [runningBackup, setRunningBackup] = useState(null);
  const [branches, setBranches] = useState([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const queryClient = useQueryClient();

  const VERSIONCONTROL_API = versionControlApiUrl();

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
    initialData: { email: "", role: "user" },
  });
  const currentUserEmail = currentUser?.email || "";

  const createAndRunBackupMutation = useMutation({
    mutationFn: async () => {
      await saveGitConfig(newConfig);
      if (newConfig.backup_frequency !== "manual") {
        const schedule = await createBackupSchedule(newConfig);

        toast.success("Backup schedule created successfully", {
          description:
            schedule?.message ||
            `${newConfig.backup_frequency} backup schedule has been created.`,
        });
      }

      const job = await startOpenSearchBackup(newConfig, "on_demand");

      setBackupStatus((prev) => ({
        ...prev,
        currentJobId: job.job_id,
      }));

      const finalStatus = await pollBackupStatus(job.job_id);

      return finalStatus;
    },

    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["backupHistory"] });
      const totalRecords =
        data.entities?.reduce(
          (sum, entity) => sum + (entity.document_count || 0),
          0
        ) || 0;

      toast.success("Backup completed successfully", {
        description: `Backed up ${totalRecords} records | Job ID: ${data.job_id}`,
      });

      setShowCreateDialog(false);
    },

    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["gitBackupConfigs"] });
      queryClient.invalidateQueries({ queryKey: ["backupHistory"] });
      toast.error("Backup failed", {
        description: error.message,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["gitBackupConfigs"] });
    },
  });

  const saveGitConfig = async (config) => {
    const response = await fetch(`${VERSIONCONTROL_API}/opensearch/gitconfig`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configuration_name: config.name,
        github_token: config.api_token || "",
        github_repo_url: config.repository_url,
        branch: config.branch,
        created_by: currentUser.email,
        updated_by: currentUser.email,
        index_names: config.entities_to_backup.map(entityToIndexName).filter(Boolean),
        schedule_frequency: config.backup_frequency,
        overwrite_existing: config.overwrite_existing ?? true,
      }),
    });
    if (!response.ok) throw new Error("Failed to save Git configuration");
    queryClient.invalidateQueries({ queryKey: ["gitBackupConfigs"] });
    return response.json();
  };

  const fetchBranches = useCallback(async (token, repoUrl) => {
    if (!repoUrl || (!token && !currentUserEmail)) return;

    try {
      setLoadingBranches(true);

      const response = await fetch(`${VERSIONCONTROL_API}/git/branches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          github_token: token,
          created_by: currentUserEmail,
          github_repo_url: repoUrl,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          typeof error.detail === "string"
            ? error.detail
            : `Failed to fetch branches (HTTP ${response.status})`
        );
      }

      const data = await response.json();
      setBranches(data.branches || []);
    } catch (error) {
      console.error(error);

      toast.error("Failed to load branches", {
        description: error.message,
      });

      setBranches([]);
    } finally {
      setLoadingBranches(false);
    }
  }, [VERSIONCONTROL_API, currentUserEmail]);

  const loadRecoverableBackups = useCallback(async () => {
    try {
      setLoadingRecoverableBackups(true);

      const response = await fetch(
        `${VERSIONCONTROL_API}/opensearch/recover/check`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            index_names: AVAILABLE_BACKUP_INDEXES,
            created_by: currentUserEmail,
            github_base_path: ".",
          }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch recoverable backups");
      }

      const data = await response.json();

      const backupMap = {};

      (data.indexes || []).forEach((item) => {
        backupMap[item.index_name] = item;
      });

      setRecoverableBackups(backupMap);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingRecoverableBackups(false);
    }
  }, [VERSIONCONTROL_API, currentUserEmail]);

  useEffect(() => {
    if (currentUserEmail) loadRecoverableBackups();
  }, [currentUserEmail, loadRecoverableBackups]);

  useEffect(() => {
    if (newConfig.api_token?.trim() && newConfig.repository_url?.trim()) {
      const timer = setTimeout(() => {
        fetchBranches(newConfig.api_token, newConfig.repository_url);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [newConfig.api_token, newConfig.repository_url, fetchBranches]);

  const entityToIndexName = (entity) => {
    if (ENTITY_INDEX_BY_ID[entity]) {
      return ENTITY_INDEX_BY_ID[entity];
    }

    if (LEGACY_SMART_DOC_BACKUP_INDEXES[entity]) {
      return LEGACY_SMART_DOC_BACKUP_INDEXES[entity];
    }

    if (AVAILABLE_BACKUP_INDEXES.includes(entity)) {
      return entity;
    }

    return null;
  };

  const startOpenSearchBackup = async (config, backupType = "manual") => {
    const response = await fetch(`${VERSIONCONTROL_API}/opensearch/backup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        index_names: config.entities_to_backup
          .map(entityToIndexName)
          .filter(Boolean),

        github_token: config.api_token || "",
        github_repo_url: config.repository_url,
        branch: config.branch,

        configuration_name: config.name,
        backup_type: backupType,

        created_by: currentUser?.email || "unknown-user",
        updated_by: currentUser?.email || "unknown-user",

        source_branch: "main",
        github_base_path: ".",
        commit_message: "OpenSearch index backup",

        export_last_n_days: 0,
        date_field: "string",
        scroll_size: 1000,
        timeout_seconds: 120,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let detail = errorBody;
      try {
        detail = JSON.parse(errorBody)?.detail || errorBody;
      } catch {
        // Preserve non-JSON upstream error responses for diagnosis.
      }
      throw new Error(
        `Failed to start backup (${response.status})${detail ? `: ${formatApiErrorDetail(detail)}` : ""}`
      );
    }

    return response.json();
  };

  const createBackupSchedule = async (config) => {
    const response = await fetch(
      `${VERSIONCONTROL_API}/opensearch/backupschedule`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          // Schedule upsert loads/decrypts the token from gitconfig server-side.
          created_by: currentUser?.email || "unknown-user",
          updated_by: currentUser?.email || "unknown-user",

          configuration_name: config.name,

          schedule_frequency: config.backup_frequency,

          index_names: config.entities_to_backup
            .map(entityToIndexName)
            .filter(Boolean),

          source_branch: "main",
          github_base_path: ".",
          commit_message: "OpenSearch index backup",

          export_last_n_days: 0,
          date_field: "string",
          scroll_size: 1000,
          timeout_seconds: 120,
          enabled: true,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      let detail = error;
      try {
        detail = JSON.parse(error)?.detail || error;
      } catch {
        // Preserve non-JSON upstream error responses for diagnosis.
      }
      throw new Error(
        `Failed to create backup schedule (${response.status})${detail ? `: ${detail}` : ""}`
      );
    }

    return response.json();
  };

  const getBackupStatus = async (jobId) => {
    const response = await fetch(
      `${VERSIONCONTROL_API}/opensearch/backup/${jobId}`
    );

    if (!response.ok) {
      throw new Error("Failed to fetch backup status");
    }
    return response.json();
  };

  const startRestore = async (config, indexNames) => {
    const response = await fetch(`${VERSIONCONTROL_API}/opensearch/restore`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        index_names: indexNames,

        created_by: currentUser.email,
        github_base_path: ".",
        overwrite_existing: config.overwrite_existing,
        restored_index_suffix: "",
        timeout_seconds: 120,
        bulk_size: 500,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let detail = errorBody;
      try {
        detail = JSON.parse(errorBody)?.detail || errorBody;
      } catch {
        // Preserve non-JSON upstream error responses for diagnosis.
      }
      throw new Error(
        `Failed to start restore (${response.status})${
          detail ? `: ${formatApiErrorDetail(detail)}` : ""
        }`
      );
    }

    return response.json();
  };

  const getRestoreStatus = async (jobId) => {
    const response = await fetch(
      `${VERSIONCONTROL_API}/opensearch/restore/${jobId}`
    );

    if (!response.ok) {
      throw new Error("Failed to fetch restore status");
    }

    return response.json();
  };

  const deleteConfigMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${VERSIONCONTROL_API}/opensearch/gitconfig/${encodeURIComponent(currentUser.email)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Failed to delete Git configuration");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gitBackupConfigs"] });
    },
    onError: (error) => toast.error("Failed to delete Git configuration", {
      description: error.message,
    }),
  });

  const updateConfigMutation = useMutation({
    mutationFn: async ({ data }) => {
      await saveGitConfig(data);
      if (data.backup_frequency !== "manual") await createBackupSchedule(data);
      else {
        const response = await fetch(`${VERSIONCONTROL_API}/opensearch/backupschedule/${encodeURIComponent(currentUser.email)}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Failed to remove backup schedule");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gitBackupConfigs"] });
      setShowEditDialog(false);
      setEditingConfigId(null);
    },
    onError: (error) => toast.error("Failed to update Git configuration", {
      description: error.message,
    }),
  });


  const runBackupMutation = useMutation({
    mutationFn: async (configId) => {
      setRunningBackup(configId);

      const config = visibleConfigs.find((c) => c.id === configId);

      if (!config) {
        throw new Error("Config not found");
      }

      const job = await startOpenSearchBackup(config);
      setBackupStatus((prev) => ({
        ...prev,
        currentJobId: job.job_id,
        currentConfigId: configId,
      }));
      return pollBackupStatus(job.job_id);
    },

    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ["gitBackupConfigs"],
      });

      queryClient.invalidateQueries({
        queryKey: ["backupHistory"],
      });

      const totalRecords =
        data.entities?.reduce(
          (sum, entity) => sum + (entity.document_count || 0),
          0
        ) || 0;

      toast.success("Backup completed successfully", {
        description: `Backed up ${totalRecords} records | Job ID: ${data.job_id}`,
      });

      setRunningBackup(null);
      setBackupStatus({});
    },

    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["backupHistory"] });
      toast.error("Backup failed", {
        description: error.message,
      });
      setRunningBackup(null);
      setBackupStatus({});
    },
  });

  const runRestoreMutation = useMutation({
    mutationFn: async ({ config, indexNames }) => {
      const job = await startRestore(config, indexNames);

      const finalStatus = await pollRestoreStatus(job.job_id);

      return finalStatus;
    },

    onSuccess: (data) => {
      toast.success("Restore completed successfully", {
        description: `Job ID: ${data.job_id}`,
      });

    },

    onError: (error) => {
      toast.error("Restore failed", {
        description: error.message,
      });

    },
  });

  const pollBackupStatus = async (jobId) => {
    return new Promise((resolve, reject) => {
      const maxAttempts = 120; // 10 minutes
      let attempts = 0;

      const interval = setInterval(async () => {
        try {
          attempts++;

          if (attempts > maxAttempts) {
            clearInterval(interval);
            reject(new Error("Backup timeout"));
            return;
          }

          const status = await getBackupStatus(jobId);

          setBackupStatus((prev) => ({
            ...prev,
            [jobId]: status,
          }));

          if (status.status === "success" || status.status === "completed") {
            clearInterval(interval);
            resolve(status);
            return;
          }

          if (["failed", "error", "partial_success"].includes(status.status)) {
            clearInterval(interval);
            reject(new Error(status.message || "Backup failed"));
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 5000);
    });
  };

  const pollRestoreStatus = async (jobId) => {
    return new Promise((resolve, reject) => {
      const maxAttempts = 120;
      let attempts = 0;

      const interval = setInterval(async () => {
        try {
          attempts++;

          if (attempts > maxAttempts) {
            clearInterval(interval);
            reject(new Error("Restore timeout"));
            return;
          }

          const status = await getRestoreStatus(jobId);


          if (status.status === "success" || status.status === "completed") {
            clearInterval(interval);
            resolve(status);
            return;
          }

          if (status.status === "failed" || status.status === "error") {
            clearInterval(interval);
            reject(new Error(status.message || "Restore failed"));
          }
        } catch (err) {
          clearInterval(interval);
          reject(err);
        }
      }, 5000);
    });
  };

  const openEditDialog = async (config) => {
    setEditingConfigId(config.id);
    setEditConfig({
      name: config.name || "",
      provider: config.provider || "github",
      // Tokens/keys may be encrypted or not returned from the backend.
      // Allow users to leave blank to keep existing.
      api_token: "",
      repository_url: config.repository_url || "",
      branch: config.branch || "release",
      backup_frequency: config.backup_frequency || "weekly",
      overwrite_existing: config.overwrite_existing ?? true,
      entities_to_backup: Array.isArray(config.entities_to_backup)
        ? config.entities_to_backup.map((value) => AVAILABLE_ENTITIES.find((entity) => entity.index === value)?.id || value)
        : [],
    });
    // Fetch branches for the edit dialog
    if (config.repository_url) {
      fetchBranches("", config.repository_url);
    }
    setShowEditDialog(true);
  };

  const toggleEntity = (entityId) => {
    setNewConfig((prev) => ({
      ...prev,
      entities_to_backup: prev.entities_to_backup.includes(entityId)
        ? prev.entities_to_backup.filter((id) => id !== entityId)
        : [...prev.entities_to_backup, entityId],
    }));
  };

  const toggleEditEntity = (entityId) => {
    setEditConfig((prev) => ({
      ...prev,
      entities_to_backup: prev.entities_to_backup.includes(entityId)
        ? prev.entities_to_backup.filter((id) => id !== entityId)
        : [...prev.entities_to_backup, entityId],
    }));
  };

  const normalizedConfigs = (Array.isArray(configs) ? configs : []).map(
    (config) => ({
      ...config,
      name: config.name || config.configuration_name || "Git Backup Configuration",
      repository_url: config.repository_url || config.github_repo_url || "",
      branch: config.branch || config.source_branch || "main",
      backup_frequency:
        config.backup_frequency || config.schedule_frequency || "manual",
      entities_to_backup: Array.isArray(config.entities_to_backup)
        ? config.entities_to_backup
        : Array.isArray(config.index_names)
          ? config.index_names
          : [],
    })
  );

  const configNameById = new Map(
    normalizedConfigs.map((config) => [config.id, config.name])
  );

  const visibleConfigs = normalizedConfigs;

  const toggleRestoreIndex = (indexName) => {
    setSelectedRestoreIndexes((prev) => {
      const next = new Set(prev);

      if (next.has(indexName)) {
        next.delete(indexName);
      } else {
        next.add(indexName);
      }

      return Array.from(next);
    });
  };

  const selectAllRestoreIndexes = () => {
    setSelectedRestoreIndexes(
      Object.values(recoverableBackups || {})
        .filter((b) => b.recoverable)
        .map((b) => b.index_name)
    );
  };

  const clearAllRestoreIndexes = () => {
    setSelectedRestoreIndexes([]);
  };

  const recoverableBackupList = Object.values(recoverableBackups || {}).filter(
    (backup) => backup.recoverable
  );

  const hasRecoverableBackups = recoverableBackupList.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
              <GitBranch className="h-5 w-5" />
            </div>
            <h3 className="text-lg font-bold">Backup Configurations</h3>
          </div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Protect your system data with scheduled Git repository backups.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!loadingRecoverableBackups && hasRecoverableBackups && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={selectAllRestoreIndexes}>
                Select All
              </Button>

              <Button variant="outline" onClick={clearAllRestoreIndexes}>
                Clear All
              </Button>

              <Button
                disabled={
                  selectedRestoreIndexes.length === 0 ||
                  runRestoreMutation.isPending
                }
                onClick={() => setShowOverwriteDialog(true)}
              >
                {runRestoreMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Restoring...
                  </>
                ) : (
                  <>Restore Selected ({selectedRestoreIndexes.length})</>
                )}
              </Button>
            </div>
          )}

          {configs.length === 0 && (
            <Button
              onClick={() => setShowCreateDialog(true)}
              className="bg-sky-600 hover:bg-sky-700 text-white"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Backup Config
            </Button>
          )}
        </div>
      </div>

      {loadingRecoverableBackups ? (
        <div className="border rounded-xl bg-[rgb(var(--md-surface))] p-4">
          <div className="mb-4">
            <div className="h-6 w-48 bg-gray-200 rounded animate-pulse mb-2" />
            <div className="h-4 w-64 bg-gray-200 rounded animate-pulse" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Card key={i} className="p-4">
                <div className="space-y-3 animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-1/2" />
                  <div className="h-3 bg-gray-200 rounded w-full" />
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : hasRecoverableBackups ? (
        <>

          <div className="rounded-xl border border-slate-200/80 bg-[rgb(var(--md-surface))] p-5 shadow-sm dark:border-slate-800">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h4 className="text-lg font-bold">Restore from Git Backups</h4>
                <p className="text-sm text-gray-500">
                  Select one or more indexes to restore into OpenSearch
                </p>
              </div>

              <Badge variant="outline">
                {recoverableBackupList.length} Available
              </Badge>
            </div>

            <div className="max-h-[500px] overflow-y-auto pr-2">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {recoverableBackupList.map((backup) => {
                  const isSelected = selectedRestoreIndexes.includes(
                    backup.index_name
                  );

                  return (
                    <Card
                      key={backup.index_name}
                      className={`cursor-pointer rounded-xl p-4 transition-all ${
                        isSelected
                          ? "border-sky-500 bg-sky-50 shadow-sm ring-1 ring-sky-500 dark:bg-sky-950/20"
                          : "border-slate-200 hover:-translate-y-0.5 hover:border-sky-300 hover:shadow-sm dark:border-slate-700"
                      }`}
                      onClick={() => toggleRestoreIndex(backup.index_name)}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                            setSelectedRestoreIndexes((prev) => {
                              if (checked) {
                                return prev.includes(backup.index_name)
                                  ? prev
                                  : [...prev, backup.index_name];
                              }

                              return prev.filter((i) => i !== backup.index_name);
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <h4 className="truncate pr-2 text-sm font-semibold capitalize">
                              {backup.index_name}
                            </h4>

                            <Badge className="shrink-0 bg-emerald-100 text-[10px] text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                              Recoverable
                            </Badge>
                          </div>

                          <p className="text-xs text-gray-500 mt-2">
                            <span className="block">
                              {backup.latest_backup_file?.split("/")?.pop()}
                            </span>
                            <span className="block">
                              Last Update:{" "}
                              {new Date(backup.latest_backup_date).toLocaleString(
                                "en-IN",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  hour12: true,
                                }
                              )}
                            </span>
                          </p>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {configs.length === 0 ? (
        <Card className="p-12 text-center bg-[rgb(var(--md-surface))]">
          <GitBranch className="w-16 h-16 mx-auto mb-4 text-gray-400" />

          <h3 className="text-lg font-semibold mb-2">
            No Backup Configurations
          </h3>

          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Set up your first backup configuration to protect your data
          </p>

          <Button
            onClick={() => setShowCreateDialog(true)}
            className="bg-sky-600 hover:bg-sky-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create First Config
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {visibleConfigs.map((config) => (
            <Card
              key={config.id}
              className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h4 className="font-bold text-lg">{config.name}</h4>
                    {config.is_active && (
                      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Active
                      </Badge>
                    )}
                    {config.last_backup_status === "success" && (
                      <Badge variant="outline" className="text-xs">
                        <CheckCircle2 className="w-3 h-3 mr-1 text-green-600" />
                        Last backup successful
                      </Badge>
                    )}
                    {config.last_backup_status === "failed" && (
                      <Badge variant="outline" className="text-xs text-red-600">
                        <XCircle className="w-3 h-3 mr-1" />
                        Last backup failed
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {config.provider} • {config.repository_url}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runBackupMutation.mutate(config.id)}
                    disabled={runningBackup === config.id}
                    className="md-ripple"
                  >
                    {runningBackup === config.id ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 mr-2" />
                        Run Now
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEditDialog(config)}
                    className="md-ripple"
                    title="Edit configuration"
                  >
                    <Pencil className="w-4 h-4" />
                    <span className="ml-1">Edit</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deleteConfigMutation.mutate(config.id)}
                    className="text-red-600 hover:text-red-700 md-ripple"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Frequency
                    </p>
                    <p className="text-sm font-medium capitalize">
                      {config.backup_frequency}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Entities
                    </p>
                    <p className="text-sm font-medium">
                      {config.entities_to_backup?.length || 0}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Recent Backups
                    </p>
                    <p className="text-sm font-medium">
                      {(backupHistory || []).filter((backup) =>
                        backup.config_id === config.id ||
                        backup.configuration_name === config.name
                      ).length}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-gray-400" />
                  <div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      Security
                    </p>
                    <p className="text-sm font-medium">Standard</p>
                  </div>
                </div>
              </div>

              {backupStatus.currentConfigId === config.id &&
                backupStatus.currentJobId &&
                backupStatus[backupStatus.currentJobId] && (
                  <div className="mt-3">
                    <div className="flex justify-between text-sm">
                      <span>Backup Progress</span>
                      <span>
                        {
                          backupStatus[backupStatus.currentJobId]
                            .progress_percent
                        }
                        %
                      </span>
                    </div>

                    <div className="w-full bg-gray-200 rounded h-2 mt-1">
                      <div
                        className="bg-blue-600 h-2 rounded"
                        style={{
                          width: `${
                            backupStatus[backupStatus.currentJobId]
                              .progress_percent
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                )}

              <div className="flex flex-wrap gap-1 mt-3">
                {config.entities_to_backup?.slice(0, 5).map((entity) => (
                  <Badge key={entity} variant="outline" className="text-xs">
                    {entity}
                  </Badge>
                ))}
                {config.entities_to_backup?.length > 5 && (
                  <Badge variant="outline" className="text-xs">
                    +{config.entities_to_backup.length - 5} more
                  </Badge>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {configs.length > 0 && (
        <Card className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
          <h4 className="font-bold mb-4 flex items-center gap-2">
            <History className="w-5 h-5" />
            Recent Backup History
          </h4>
          {(!backupHistory || backupHistory.length === 0) && (
            <p className="text-sm text-gray-500">No backups recorded yet.</p>
          )}
          {backupHistory?.length > 0 && <ScrollArea className="h-[300px]">
            <div className="space-y-3 pr-4">
              {backupHistory.slice(0, 10).map((backup) => (
                <div
                  key={backup.id}
                  className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {backup.status === "completed" ? (
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                      ) : backup.status === "failed" ? (
                        <XCircle className="w-4 h-4 text-red-600" />
                      ) : (
                        <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      )}
                      <div className="leading-tight">
                        <div className="flex items-center gap-2 text-sm font-medium capitalize">
                          {backup.backup_type} backup
                          <Badge
                            variant="outline"
                            className={
                              backup.status === "completed"
                                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                                : backup.status === "failed"
                                  ? "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
                                  : ""
                            }
                          >
                            {backup.status === "completed"
                              ? "Successful"
                              : backup.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          Config:{" "}
                          {backup.configuration_name ||
                            configNameById.get(backup.config_id) ||
                            backup.config_id ||
                            "Unknown"}
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {format(new Date(backup.started_at), "MMM d, HH:mm")}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                    <p>
                      Records: {backup.total_records || 0} • Size:{" "}
                      {backup.backup_size_mb || 0} MB
                    </p>
                    {backup.commit_url && (
                      <a
                        href={backup.commit_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        View commit →
                      </a>
                    )}
                    {backup.error_message && (
                      <p className="text-red-600">{backup.error_message}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>}
        </Card>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Backup Configuration</DialogTitle>
            <DialogDescription>
              Configure automatic backups to your Git repository
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <Label>Configuration Name *</Label>
              <Input
                placeholder="e.g., Daily Production Backup"
                value={newConfig.name}
                onChange={(e) =>
                  setNewConfig({ ...newConfig, name: e.target.value })
                }
                className="mt-2"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Git Provider</Label>
                <Select
                  value={newConfig.provider}
                  onValueChange={(val) =>
                    setNewConfig({ ...newConfig, provider: val })
                  }
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                    <SelectItem value="bitbucket">Bitbucket</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Backup Frequency</Label>
                <Select
                  value={newConfig.backup_frequency}
                  onValueChange={(val) =>
                    setNewConfig({ ...newConfig, backup_frequency: val })
                  }
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual Only</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>API Token *</Label>
              <Input
                type="password"
                placeholder="ghp_xxxxxxxxxxxx"
                value={newConfig.api_token}
                onChange={(e) =>
                  setNewConfig({ ...newConfig, api_token: e.target.value })
                }
                className="mt-2"
              />
              <p className="text-xs text-gray-500 mt-1">
                Generate from your Git provider settings
              </p>
            </div>

            <div>
              <Label>Repository URL *</Label>
              <Input
                placeholder="https://github.com/username/backups"
                value={newConfig.repository_url}
                onChange={(e) =>
                  setNewConfig({ ...newConfig, repository_url: e.target.value })
                }
                className="mt-2"
              />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <Label>Branch</Label>

                <Info
                  className="w-4 h-4 text-blue-500"
                  title="Enter Git Token and Repository URL to load branches"
                />
              </div>

              <Select
                value={newConfig.branch}
                onValueChange={(val) =>
                  setNewConfig({
                    ...newConfig,
                    branch: val,
                  })
                }
              >
                {!newConfig.api_token?.trim() ||
                !newConfig.repository_url?.trim() ? (
                  <p className="text-xs text-amber-600 mt-2">
                    Enter API Token and Repository URL to load available
                    branches.
                  </p>
                ) : loadingBranches ? (
                  <p className="text-xs text-blue-600 mt-2">
                    Loading branches...
                  </p>
                ) : branches.length === 0 ? (
                  <p className="text-xs text-red-600 mt-2">
                    No branches found for the provided repository.
                  </p>
                ) : null}
                <SelectTrigger className="mt-2">
                  <div className="flex items-center justify-between w-full">
                    <SelectValue placeholder="Select branch" />

                    <RotateCw
                      className={`w-4 h-4 ml-2 cursor-pointer text-gray-500 hover:text-blue-600 ${
                        loadingBranches ? "animate-spin" : ""
                      }`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        if (
                          !loadingBranches &&
                          newConfig.api_token?.trim() &&
                          newConfig.repository_url?.trim()
                        ) {
                          fetchBranches(
                            newConfig.api_token,
                            newConfig.repository_url
                          );
                        }
                      }}
                    />
                  </div>
                </SelectTrigger>

                <SelectContent>
                  {loadingBranches ? (
                    <SelectItem value="loading" disabled>
                      Loading branches...
                    </SelectItem>
                  ) : (
                    branches.map((branch) => (
                      <SelectItem key={branch} value={branch}>
                        {branch}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Entities to Backup *</Label>

              <ScrollArea className="h-[200px] border rounded-lg p-4 mt-2">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 border-b pb-2 mb-2">
                    <Checkbox
                      id="select-all-entities"
                      checked={
                        newConfig.entities_to_backup.length ===
                        AVAILABLE_ENTITIES.length
                      }
                      onCheckedChange={(checked) => {
                        setNewConfig((prev) => ({
                          ...prev,
                          entities_to_backup: checked
                            ? AVAILABLE_ENTITIES.map((e) => e.id)
                            : [],
                        }));
                      }}
                    />

                    <label
                      htmlFor="select-all-entities"
                      className="text-sm font-medium cursor-pointer"
                    >
                      {newConfig.entities_to_backup.length ===
                      AVAILABLE_ENTITIES.length
                        ? "Clear All"
                        : "Select All"}
                    </label>
                  </div>

                  {AVAILABLE_ENTITIES.map((entity) => (
                    <div
                      key={entity.id}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={entity.id}
                        checked={newConfig.entities_to_backup.includes(
                          entity.id
                        )}
                        onCheckedChange={() => toggleEntity(entity.id)}
                      />

                      <label
                        htmlFor={entity.id}
                        className="text-sm cursor-pointer"
                      >
                        {entity.label}
                      </label>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCreateDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createAndRunBackupMutation.mutate()}
              disabled={
                !newConfig.name ||
                !newConfig.api_token ||
                !newConfig.repository_url ||
                newConfig.entities_to_backup.length === 0
              }
              className="bg-sky-600 hover:bg-sky-700"
            >
              {createAndRunBackupMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Backup
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showOverwriteDialog} onOpenChange={setShowOverwriteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Restore Configuration</DialogTitle>
            <DialogDescription>
              Choose how restore operations should behave.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="flex items-center justify-between">
              <Label>Overwrite Existing Data</Label>

              <Switch
                checked={overwriteExisting}
                onCheckedChange={setOverwriteExisting}
              />
            </div>

            <p className="text-xs text-gray-500 mt-2">
              ON = Existing indexes will be replaced during restore.
              <br />
              OFF = Existing indexes will be preserved.
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowOverwriteDialog(false)}
            >
              Cancel
            </Button>

            <Button
              onClick={() => {
                setShowOverwriteDialog(false);

                runRestoreMutation.mutate({
                  config: {
                    id: "global-restore",
                    overwrite_existing: overwriteExisting,
                  },
                  indexNames: selectedRestoreIndexes,
                });
              }}
            >
              Start Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Backup Configuration</DialogTitle>
            <DialogDescription>
              Update an existing backup configuration. Leave secrets blank to
              keep current values.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <Label>Configuration Name *</Label>
              <Input
                placeholder="e.g., Daily Production Backup"
                value={editConfig.name}
                onChange={(e) =>
                  setEditConfig({ ...editConfig, name: e.target.value })
                }
                className="mt-2"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Git Provider</Label>
                <Select
                  value={editConfig.provider}
                  onValueChange={(val) =>
                    setEditConfig({ ...editConfig, provider: val })
                  }
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                    <SelectItem value="bitbucket">Bitbucket</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Backup Frequency</Label>
                <Select
                  value={editConfig.backup_frequency}
                  onValueChange={(val) =>
                    setEditConfig({ ...editConfig, backup_frequency: val })
                  }
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual Only</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>API Token</Label>
              <Input
                type="password"
                placeholder="Leave blank to keep existing"
                value={editConfig.api_token}
                onChange={(e) =>
                  setEditConfig({ ...editConfig, api_token: e.target.value })
                }
                className="mt-2"
              />
              <p className="text-xs text-gray-500 mt-1">
                Only required if you want to change it
              </p>
            </div>

            <div>
              <Label>Repository URL *</Label>
              <Input
                placeholder="https://github.com/username/backups"
                value={editConfig.repository_url}
                onChange={(e) =>
                  setEditConfig({
                    ...editConfig,
                    repository_url: e.target.value,
                  })
                }
                className="mt-2"
              />
            </div>

            <div>
              <Label>Branch</Label>
              <Select
                value={editConfig.branch}
                onValueChange={(val) =>
                  setEditConfig({
                    ...editConfig,
                    branch: val,
                  })
                }
              >
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([editConfig.branch, ...branches].filter(Boolean))).map((branch) => (
                    <SelectItem key={branch} value={branch}>
                      {branch}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Entities to Backup *</Label>
              <ScrollArea className="h-[200px] border rounded-lg p-4 mt-2">
                <div className="space-y-2">
                  {AVAILABLE_ENTITIES.map((entity) => (
                    <div
                      key={entity.id}
                      className="flex items-center space-x-2"
                    >
                      <Checkbox
                        id={`edit_${entity.id}`}
                        checked={editConfig.entities_to_backup.includes(
                          entity.id
                        )}
                        onCheckedChange={() => toggleEditEntity(entity.id)}
                      />
                      <label
                        htmlFor={`edit_${entity.id}`}
                        className="text-sm cursor-pointer"
                      >
                        {entity.label}
                      </label>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowEditDialog(false);
                setEditingConfigId(null);
              }}
            >
              Cancel
            </Button>

            <Button
              onClick={() => {
                if (!editingConfigId) return;

                const payload = {
                  name: editConfig.name,
                  provider: editConfig.provider,
                  repository_url: editConfig.repository_url,
                  branch: editConfig.branch,
                  backup_frequency: editConfig.backup_frequency,
                  overwrite_existing: editConfig.overwrite_existing,
                  entities_to_backup: editConfig.entities_to_backup,
                };

                if (String(editConfig.api_token || "").trim()) {
                  payload.api_token = editConfig.api_token;
                }

                updateConfigMutation.mutate({
                  id: editingConfigId,
                  data: payload,
                });
              }}
              disabled={
                updateConfigMutation.isPending ||
                !editConfig.name ||
                !editConfig.repository_url ||
                editConfig.entities_to_backup.length === 0
              }
              className="bg-sky-600 hover:bg-sky-700"
            >
              {updateConfigMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Pencil className="w-4 h-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
