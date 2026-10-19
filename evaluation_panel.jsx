/* eslint-disable react/prop-types */
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { removeSpecialCharacters } from "@/utils";
import { toast } from "sonner";
import {
  PlayCircle,
  Package,
  Bot,
  Workflow as WorkflowIcon,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  ClipboardList,
  TrendingUp,
  TrendingDown,
  Clock,
  Target,
  Brain,
  Shield,
  MessageSquareText,
  ShieldCheck,
  Compass,
  Filter,
  ScanSearch,
  TriangleAlert,
  Scale,
  Flame,
  BadgeCheck,
  ClipboardCheck,
  Play, // Added for new 'Run Evaluation' buttons on cards
  Download,
  Database, // Added for RAG Data Sources
  Network,  // Added for RAG Knowledge Graphs
  Search,   // Added for RAG OpenSearch Indices
  Trash2,  // Added for deleting evaluations
  Info,
  RefreshCw,
  ChevronsUpDown,
  Sparkles,
  Eye,
} from "lucide-react";
import { format } from "date-fns";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"; // Added Dialog components
import SchedulerConfigurator from "../workflow/SchedulerConfigurator"; // Added SchedulerConfigurator
import { FRAMEWORK_MODELS, getAvailableModelsForFramework } from "@/constants/frameworkModels";
import {
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  CartesianGrid,
  ResponsiveContainer,
  LineChart,
  Line,
  Bar,
  BarChart,
  ComposedChart,
  Cell,
  Legend,
} from "recharts";

const FRAMEWORK_LABELS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  huggingface: "Hugging Face",
  nvidia: "NVIDIA AI",
  privateai: "PrivateAI",
  ollama: "Ollama",
  sglang: "SGLang",
};
const FRAMEWORK_OPTIONS = [...Object.keys(FRAMEWORK_MODELS), "ollama"].map((frameworkId) => ({
  value: frameworkId,
  label: FRAMEWORK_LABELS[frameworkId] || frameworkId,
}));

const newAgentGoldenQuestion = () => ({
  question_id: crypto.randomUUID(), question: "", expected_tool: "",
  expected_contains: "", task_type: "", human_time_minutes: "",
});

// Show framework defaults first, with an explicit option for deployed/custom model IDs.
const EvaluationModelPicker = ({ value, onChange, options = [] }) => {
  const [customSelected, setCustomSelected] = useState(false);
  const inputId = React.useId();
  const customOption = "__evaluation_custom_model__";
  const isCustom = customSelected || Boolean(value && !options.some((model) => model.value === value));
  return (
    <div className="mt-2">
      <Select
        value={isCustom ? customOption : value || ""}
        onValueChange={(nextValue) => {
          if (nextValue === customOption) {
            setCustomSelected(true);
          } else {
            setCustomSelected(false);
            onChange(nextValue);
          }
        }}
      >
        <SelectTrigger aria-label="Model">
          <SelectValue placeholder="Select a default model" />
        </SelectTrigger>
        <SelectContent>
          {options.map((model) => (
            <SelectItem key={model.value} value={model.value}>{model.label}</SelectItem>
          ))}
          <SelectItem value={customOption}>Enter custom model…</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && (
        <div className="mt-3">
          <Label htmlFor={inputId}>Custom model ID</Label>
          <Input
            id={inputId}
            className="mt-2"
            value={value || ""}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => onChange(String(value || "").trim())}
            placeholder="e.g. finance-broker or Qwen/Qwen3-32B-AWQ"
            aria-describedby={`${inputId}-help`}
          />
        </div>
      )}
      <p id={`${inputId}-help`} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {isCustom
          ? "Enter the exact model ID available on your selected framework. To use a default model, select it from the dropdown above."
          : "Choose a default model from the list. If your model is not listed, select ‘Enter custom model…’ to type its model ID."}
      </p>
    </div>
  );
};

const DEEPEVAL_METRICS = [
  {
    id: 'answer_relevancy',
    name: 'Answer Relevancy',
    description: 'Measures whether the response directly addresses the user’s question and stays on topic',
    icon: MessageSquareText,
    color: 'text-blue-600',
    chartColor: '#2563eb',
    threshold: 0.8
  },
  {
    id: 'faithfulness',
    name: 'Faithfulness',
    description: 'Checks if the response is accurate and based on reliable information, without adding incorrect details',
    icon: ShieldCheck,
    color: 'text-green-600',
    chartColor: '#059669',
    threshold: 0.8
  },
  {
    id: 'contextual_relevancy',
    name: 'Contextual Relevancy',
    description: 'Evaluates whether the information used to generate the response is appropriate and related to the question',
    icon: Compass,
    color: 'text-purple-600',
    chartColor: '#7c3aed',
    threshold: 0.8
  },
  {
    id: 'contextual_precision',
    name: 'Contextual Precision',
    description: 'Assesses whether the response includes only useful information and avoids unnecessary or unrelated details',
    icon: Filter,
    color: 'text-indigo-600',
    chartColor: '#4f46e5',
    threshold: 0.8
  },
  {
    id: 'contextual_recall',
    name: 'Contextual Recall',
    description: 'Checks if all important information needed to fully answer the question has been included',
    icon: ScanSearch,
    color: 'text-cyan-600',
    chartColor: '#0ea5e9',
    threshold: 0.8
  },
  {
    id: 'hallucination',
    name: 'Hallucination Detection',
    description: 'Identifies responses that include information that is made up, unsupported, or not grounded in known facts',
    icon: TriangleAlert,
    color: 'text-red-600',
    chartColor: '#dc2626',
    threshold: 0.3,
    inverse: true
  },
  {
    id: 'bias',
    name: 'Bias Detection',
    description: 'Checks whether the response is balanced and avoids unfair or one-sided viewpoints',
    icon: Scale,
    color: 'text-orange-600',
    chartColor: '#f97316',
    threshold: 0.3,
    inverse: true
  },
  {
    id: 'toxicity',
    name: 'Toxicity Detection',
    description: 'Ensures the response uses respectful language and does not include harmful or inappropriate content',
    icon: Flame,
    color: 'text-red-600',
    chartColor: '#ef4444',
    threshold: 0.3,
    inverse: true
  },
  {
    id: 'correctness_similarity',
    name: 'Correctness Similarity',
    description: 'Measures how closely the response matches the expected or ideal answer',
    icon: BadgeCheck,
    color: 'text-emerald-600',
    chartColor: '#14b8a6',
    threshold: 0.8
  },
  {
    id: 'g_eval',
    name: 'G-Eval (Custom Review)',
    description: 'Evaluates responses against your specific business expectations or quality guidelines',
    icon: ClipboardCheck,
    color: 'text-purple-600',
    chartColor: '#9333ea',
    threshold: 0.8,
    requiresCriteria: true
  }
];

const AGENT_CASE_METRICS = [
  {
    id: "status",
    name: "Run Completed",
    description: "Agent API returned the expected terminal status",
    chartColor: "#2563eb",
    threshold: 1,
  },
  {
    id: "success",
    name: "Success",
    description: "All configured case checks passed",
    chartColor: "#16a34a",
    threshold: 1,
  },
  {
    id: "expected_tool",
    name: "Expected Tool",
    description: "Called tools matched the expected tools",
    chartColor: "#7c3aed",
    threshold: 1,
  },
  {
    id: "expected_tool_output",
    name: "Expected Tool Output",
    description: "Actual output matched the expected content check",
    chartColor: "#0d9488",
    threshold: 1,
  },
  {
    id: "tool_correct",
    name: "Tool Correctness",
    description: "DeepEval tool correctness metric passed",
    chartColor: "#f59e0b",
    threshold: 1,
  },
  {
    id: "task_completion",
    name: "Task Completion",
    description: "DeepEval task completion score passed",
    chartColor: "#22c55e",
    threshold: 0.7,
  },
  {
    id: "step_efficiency",
    name: "Step Efficiency",
    description: "Agent completed the task with an efficient execution path",
    chartColor: "#8b5cf6",
    threshold: 0.7,
  },
  {
    id: "argument_correctness",
    name: "Argument Correctness",
    description: "Tool arguments were appropriate for the requested task",
    chartColor: "#ec4899",
    threshold: 0.7,
  },
  {
    id: "time",
    name: "Time",
    description: "Agent runtime was within the human baseline",
    chartColor: "#06b6d4",
    threshold: 1,
  },
];

const METRIC_NAME_LOOKUP = [...DEEPEVAL_METRICS, ...AGENT_CASE_METRICS].reduce((acc, metric) => {
  acc[metric.id] = metric.name;
  return acc;
}, {});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const formatLocalDayKey = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  return format(new Date(timestamp), "yyyy-MM-dd");
};

const parseLocalDayKey = (dayKey) => {
  if (!dayKey) return null;
  const [year, month, day] = String(dayKey).split("-").map((value) => Number(value));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(year, month - 1, day);
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const formatMetricScore = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "—";
};

const getAgentCheckValue = (checks = {}, key) => {
  if (!checks || typeof checks !== "object") return undefined;
  const legacyKeys = {
    status: `status_${"ok"}`,
    expected_tool: `tool_${"ok"}`,
    expected_tool_output: `contains_${"ok"}`,
    time: `time_${"ok"}`,
  };
  if (typeof checks[key] === "boolean") return checks[key];
  const legacyKey = legacyKeys[key];
  return typeof checks[legacyKey] === "boolean" ? checks[legacyKey] : undefined;
};

const formatBooleanValue = (value) => (value === true ? "true" : value === false ? "false" : "—");

const booleanChipClass = (value) =>
  value === true
    ? "border-green-200 bg-green-50 text-green-700"
    : value === false
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-gray-200 bg-gray-50 text-gray-600";

const getAgentEvalSummary = (evaluationOrResponse) => {
  const source =
    evaluationOrResponse?.eval_api_response && typeof evaluationOrResponse.eval_api_response === "object"
      ? evaluationOrResponse.eval_api_response
      : evaluationOrResponse || {};
  const summary =
    source.summary && typeof source.summary === "object"
      ? source.summary
      : evaluationOrResponse?.eval_summary && typeof evaluationOrResponse.eval_summary === "object"
        ? evaluationOrResponse.eval_summary
        : null;
  return summary || {};
};

const formatAgentEvalPercent = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * 100)}%` : "—";
};

const formatAgentEvalMinutes = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  if (numeric >= 60) return `${(numeric / 60).toFixed(1)}h`;
  if (numeric >= 1) return `${numeric.toFixed(1)}m`;
  return `${Math.round(numeric * 60)}s`;
};

const formatAgentEvalSeconds = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return formatAgentEvalMinutes(numeric / 60.0);
};

const compactAgentEvalResponse = (responseJson, fallback = {}) => {
  const persisted = responseJson?.persisted && typeof responseJson.persisted === "object"
    ? responseJson.persisted
    : {};
  return {
    status: responseJson?.status || "completed",
    run_id: responseJson?.run_id || persisted.run_id || fallback.run_id || null,
    kind: "summary",
    agent_id: responseJson?.agent_id || fallback.agent_id || null,
    agent_name: responseJson?.agent_name || fallback.agent_name || null,
    username: responseJson?.username || fallback.username || null,
    summary: getAgentEvalSummary(responseJson),
    output_files: responseJson?.output_files || {},
    output_opensearch_index:
      responseJson?.output_opensearch_index ||
      persisted.index ||
      fallback.output_opensearch_index ||
      "agent_eval_output",
    deepeval_metrics_model: responseJson?.deepeval_metrics_model || fallback.deepeval_metrics_model || null,
    deepeval_metrics_framework:
      responseJson?.deepeval_metrics_framework || fallback.deepeval_metrics_framework || null,
    ingested_at_unix: responseJson?.ingested_at_unix || persisted.ingested_at_unix || null,
    created_time: responseJson?.created_time || persisted.created_time || null,
    persisted: {
      backend: persisted.backend,
      index: persisted.index,
      rows_indexed: persisted.rows_indexed,
      errors: persisted.errors,
    },
  };
};

const fetchAgentDeepEvalResults = async (agent, username = "") => {
  if (!agent?.id && !agent?.name) return null;
  const params = new URLSearchParams();
  if (agent?.id) params.set("agent_id", agent.id);
  if (agent?.name) params.set("agent_name", agent.name);
  if (username) params.set("username", username);
  params.set("index", "agent_eval_output");
  params.set("limit", "500");

  const response = await fetch(`${getEvalServiceBaseUrl()}/agent-deepeval-results?${params.toString()}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") {
    throw new Error(
      payload?.message ||
        payload?.detail ||
        payload?.error ||
        `Failed to load agent eval results (HTTP ${response.status})`
    );
  }
  return payload;
};

const fetchAgentGoldenCase = async (agent, indexName = "agent_eval_golden") => {
  if (!agent?.id && !agent?.name) return null;
  const params = new URLSearchParams();
  if (agent?.id) params.set("agent_id", agent.id);
  if (agent?.name) params.set("agent_name", agent.name);
  params.set("index", indexName || "agent_eval_golden");

  const response = await fetch(`${getEvalServiceBaseUrl()}/agent-golden-case?${params.toString()}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status === "error") {
    throw new Error(
      payload?.message ||
        payload?.detail ||
        payload?.error ||
        `Failed to load agent golden case (HTTP ${response.status})`
    );
  }
  return payload;
};

const buildAgentEvaluationFromOutput = (agent, result) => {
  const latest = result?.latest_summary && typeof result.latest_summary === "object"
    ? result.latest_summary
    : null;
  if (!latest) return null;
  const aggregateTotalCases = Number(result?.case_count);
  const aggregateSuccessfulCases = Number(result?.successful_cases);
  const aggregateFailedCases = Number(result?.failed_cases);
  const hasAggregateCases =
    Number.isFinite(aggregateTotalCases) &&
    aggregateTotalCases > 0 &&
    Number.isFinite(aggregateSuccessfulCases);
  const aggregatePassRate = hasAggregateCases ? aggregateSuccessfulCases / aggregateTotalCases : null;
  const summary = {
    ...(latest.summary || {}),
    ...(hasAggregateCases
      ? {
          total_cases: aggregateTotalCases,
          deepeval_passed: aggregateSuccessfulCases,
          deepeval_pass_rate: aggregatePassRate,
          overall_successful: aggregateSuccessfulCases,
          overall_success_rate: aggregatePassRate,
          average_metric_score: aggregatePassRate,
          failed_cases: Number.isFinite(aggregateFailedCases) ? aggregateFailedCases : aggregateTotalCases - aggregateSuccessfulCases,
        }
      : {}),
  };
  return {
    evaluation_type: "agent",
    item_id: agent?.id || latest.agent_id,
    item_name: agent?.name || latest.agent_name,
    status: "completed",
    passed: Number(summary.deepeval_pass_rate) >= 1,
    overall_score: summary.average_metric_score,
    completed_at: latest.created_time,
    output_opensearch_index: result?.index || "agent_eval_output",
    eval_run_id: latest.run_id,
    eval_api_response: {
      ...latest,
      summary,
      output_opensearch_index: result?.index || "agent_eval_output",
    },
  };
};

const getAgentEvalResultCases = (result) => {
  const candidates = [
    result?.case_rows,
    result?.all_cases,
    result?.cases,
    result?.items,
    result?.records,
    result?.data,
    result?.hits?.hits,
    result?.hits,
    result?.results,
  ];
  const list = candidates.find((value) => Array.isArray(value));
  return Array.isArray(list) ? list : [];
};

function summarizeAgentCaseEvaluations(cases = []) {
  const rows = Array.isArray(cases) ? cases : [];
  const totalCases = rows.length;
  const completedCases = rows.filter((item) =>
    ["completed", "complete", "success"].includes(
      String(item?.eval_api_response?.status || item?.status || "").toLowerCase()
    )
  ).length;
  const successfulCases = rows.filter((item) => item?.passed === true).length;
  const failedCases = rows.filter((item) => item?.passed === false).length;
  const statusMatched = rows.filter((item) => getAgentCheckValue(item?.eval_api_response?.checks, "status") === true).length;
  const expectedToolMatched = rows.filter((item) => getAgentCheckValue(item?.eval_api_response?.checks, "expected_tool") === true).length;
  const expectedToolOutputMatched = rows.filter((item) => getAgentCheckValue(item?.eval_api_response?.checks, "expected_tool_output") === true).length;
  const toolCorrect = rows.filter((item) => {
    const metrics = item?.eval_api_response?.deepeval?.metrics;
    if (!Array.isArray(metrics)) return false;
    return metrics.some((metric) =>
      String(metric?.name || "").toLowerCase().includes("tool") && metric?.passed === true
    );
  }).length;
  const totalAgentSeconds = rows.reduce(
    (sum, item) => sum + (Number(item?.eval_api_response?.agent_seconds) || 0),
    0
  );
  const totalHumanMinutes = rows.reduce(
    (sum, item) => sum + (Number(item?.eval_api_response?.human_time_minutes) || 0),
    0
  );
  const totalSavedMinutes = rows.reduce(
    (sum, item) => sum + (Number(item?.eval_api_response?.saved_minutes) || 0),
    0
  );
  const timeMatched = rows.filter((item) => getAgentCheckValue(item?.eval_api_response?.checks, "time") === true).length;
  const metricScores = rows
    .map((item) => Number(item?.overall_score))
    .filter((value) => Number.isFinite(value));
  const averageScore = metricScores.length
    ? metricScores.reduce((sum, value) => sum + value, 0) / metricScores.length
    : null;

  return {
    total_cases: totalCases,
    completed_cases: completedCases,
    completed_rate: totalCases ? completedCases / totalCases : null,
    overall_successful: successfulCases,
    overall_success_rate: totalCases ? successfulCases / totalCases : null,
    failed_cases: failedCases,
    failed_rate: totalCases ? failedCases / totalCases : null,
    status: statusMatched,
    status_rate: totalCases ? statusMatched / totalCases : null,
    expected_tool: expectedToolMatched,
    expected_tool_rate: totalCases ? expectedToolMatched / totalCases : null,
    expected_tool_output: expectedToolOutputMatched,
    expected_tool_output_rate: totalCases ? expectedToolOutputMatched / totalCases : null,
    tool_correct: toolCorrect,
    tool_correct_rate: totalCases ? toolCorrect / totalCases : null,
    deepeval_passed: toolCorrect,
    deepeval_pass_rate: totalCases ? toolCorrect / totalCases : null,
    average_metric_score: averageScore,
    total_agent_seconds: totalAgentSeconds,
    average_agent_seconds: totalCases ? totalAgentSeconds / totalCases : null,
    total_human_time_minutes: totalHumanMinutes,
    average_human_time_minutes: totalCases ? totalHumanMinutes / totalCases : null,
    saved_minutes: totalSavedMinutes,
    saved_hours: totalSavedMinutes / 60.0,
    time: timeMatched,
    time_rate: totalCases ? timeMatched / totalCases : null,
  };
}

function rebuildAgentEvaluationGroupWithCases(evaluation, cases = []) {
  if (!evaluation || !Array.isArray(cases)) return evaluation;
  const summary = {
    ...(evaluation.eval_summary || {}),
    ...summarizeAgentCaseEvaluations(cases),
  };
  return {
    ...evaluation,
    passed: summary.total_cases > 0 && summary.overall_successful === summary.total_cases,
    overall_score: summary.average_metric_score,
    eval_summary: summary,
    eval_api_response: {
      ...(evaluation.eval_api_response || {}),
      summary,
      case_rows: cases,
    },
  };
}

const buildAgentEvaluationGroupFromOutput = (agent, result) => {
  const cases = getAgentEvalResultCases(result);
  if (!cases.length) return buildAgentEvaluationFromOutput(agent, result);
  const normalizedCases = cases
    .map((item, index) => normalizeAgentEvalCaseToEvaluation(agent, result, item, index))
    .filter(Boolean);
  if (!normalizedCases.length) return buildAgentEvaluationFromOutput(agent, result);

  const latest = result?.latest_summary && typeof result.latest_summary === "object"
    ? result.latest_summary
    : {};
  const firstCase = normalizedCases[0];
  const caseSummary = summarizeAgentCaseEvaluations(normalizedCases);
  const summary = {
    ...(latest.summary || {}),
    ...caseSummary,
    average_metric_score: Number.isFinite(caseSummary.average_metric_score)
      ? caseSummary.average_metric_score
      : latest.summary?.average_metric_score,
  };

  return {
    evaluation_type: "agent",
    id: `agent-output-group:${agent?.id || latest.agent_id || firstCase.item_id || firstCase.item_name}`,
    item_id: agent?.id || latest.agent_id || firstCase.item_id,
    item_name: agent?.name || latest.agent_name || firstCase.item_name,
    status: "completed",
    passed: summary.total_cases > 0 && summary.overall_successful === summary.total_cases,
    overall_score: summary.average_metric_score,
    completed_at: latest.created_time || firstCase.completed_at,
    started_at: latest.created_time || firstCase.started_at,
    created_date: latest.created_time || firstCase.created_date,
    eval_run_id: latest.run_id || firstCase.eval_run_id,
    output_opensearch_index: result?.index || "agent_eval_output",
    eval_results_found: true,
    eval_summary: summary,
    eval_api_response: {
      ...latest,
      agent_id: agent?.id || latest.agent_id || firstCase.item_id,
      agent_name: agent?.name || latest.agent_name || firstCase.item_name,
      run_id: latest.run_id || firstCase.eval_run_id,
      ingested_at_unix: latest.ingested_at_unix || firstCase.eval_api_response?.ingested_at_unix,
      created_time: latest.created_time || firstCase.completed_at,
      output_opensearch_index: result?.index || "agent_eval_output",
      summary,
      case_rows: normalizedCases,
    },
  };
};

const normalizeAgentEvalCaseToEvaluation = (agent, result, item, index) => {
  if (!item || typeof item !== "object") return null;
  const source = item._source && typeof item._source === "object" ? item._source : item;
  const runId = source.run_id || source.eval_run_id || result?.latest_summary?.run_id || result?.run_id;
  const caseNumber = source.case_number ?? source.caseNumber ?? index + 1;
  const rawMetrics = source.deepeval?.metrics || source.metrics || [];
  const deepevalMetrics = Array.isArray(rawMetrics)
    ? rawMetrics.reduce((acc, metric) => {
        const metricName = metric?.name || metric?.metric || metric?.id;
        const metricId = normalizeAgentMetricKey(metricName);
        if (!metricId) return acc;
        acc[metricId] = {
          score: metric?.score,
          threshold: metric?.threshold,
          passed: metric?.passed,
          reason: metric?.reason,
          skipped: metric?.skipped,
          name: metricName,
        };
        return acc;
      }, {})
    : {};
  const metricScores = Object.values(deepevalMetrics)
    .map((metric) => Number(metric.score))
    .filter((value) => Number.isFinite(value));
  const averageScore = metricScores.length
    ? metricScores.reduce((sum, value) => sum + value, 0) / metricScores.length
    : source.success === true || source.deepeval?.passed === true
      ? 1
      : source.success === false || source.deepeval?.passed === false
        ? 0
        : null;
  const createdTime =
    source.created_time ||
    source.created_at ||
    source.ingested_at ||
    (Number.isFinite(Number(source.ingested_at_unix))
      ? new Date(Number(source.ingested_at_unix) * 1000).toISOString()
      : null);
  const expectedTools = source.expected_tools || source.deepeval?.expected_tools || [];
  const toolsCalled = source.tools_called || source.selected_tools || source.deepeval?.tools_called || [];
  const expectedTool = source.expected_tool || (Array.isArray(expectedTools) ? expectedTools[0] : expectedTools);
  const selectedTools = Array.isArray(toolsCalled) ? toolsCalled : toolsCalled ? [toolsCalled] : [];
  const agentId = source.agent_id || agent?.id || result?.latest_summary?.agent_id;
  const agentName = source.agent_name || agent?.name || result?.latest_summary?.agent_name || "Agent";
  const docId = source._id || item._id || `${runId || "agent-eval"}:case:${caseNumber}`;

  return {
    id: `agent-output:${docId}`,
    evaluation_type: "agent",
    item_id: agentId,
    item_name: agentName,
    status: String(source.status || "COMPLETED").toLowerCase() === "running" ? "running" : "completed",
    passed:
      typeof source.success === "boolean"
        ? source.success
        : typeof source.deepeval?.passed === "boolean"
          ? source.deepeval.passed
          : null,
    overall_score: averageScore,
    completed_at: createdTime,
    started_at: createdTime,
    created_date: createdTime,
    actual_output: source.actual_output || source.deepeval?.actual_output || source.result_preview || "",
    test_scenario: source.question || `Case ${caseNumber}`,
    deepeval_metrics: deepevalMetrics,
    eval_results_found: true,
    eval_overall_status:
      source.success === true || source.deepeval?.passed === true
        ? "pass"
        : source.success === false || source.deepeval?.passed === false
          ? "fail"
          : source.status || "",
    eval_run_id: runId,
    eval_summary: {
      total_cases: 1,
      deepeval_passed: source.deepeval?.passed === true ? 1 : 0,
      deepeval_pass_rate: source.deepeval?.passed === true ? 1 : 0,
      overall_successful: source.success === true ? 1 : 0,
      overall_success_rate: source.success === true ? 1 : 0,
      average_metric_score: averageScore,
      failed_cases: source.success === false ? 1 : 0,
    },
    eval_api_response: {
      ...source,
      summary: {
        total_cases: 1,
        deepeval_passed: source.deepeval?.passed === true ? 1 : 0,
        deepeval_pass_rate: source.deepeval?.passed === true ? 1 : 0,
        overall_successful: source.success === true ? 1 : 0,
        overall_success_rate: source.success === true ? 1 : 0,
        average_metric_score: averageScore,
        failed_cases: source.success === false ? 1 : 0,
      },
      expected_tool: expectedTool,
      selected_tools: selectedTools,
      output_opensearch_index: result?.index || source.output_opensearch_index || "agent_eval_output",
    },
    expected_tool: expectedTool,
    selected_tools: selectedTools,
    output_opensearch_index: result?.index || source.output_opensearch_index || "agent_eval_output",
  };
};

const getAgentVisualKey = (evaluation) => {
  const response =
    evaluation?.eval_api_response && typeof evaluation.eval_api_response === "object"
      ? evaluation.eval_api_response
      : {};
  return String(
    evaluation?.item_id ||
      response.agent_id ||
      evaluation?.item_name ||
      response.agent_name ||
      ""
  ).trim();
};

const AgentEvaluationSummaryCard = ({ evaluation, completedRunCount = null }) => {
  const response =
    evaluation?.eval_api_response && typeof evaluation.eval_api_response === "object"
      ? evaluation.eval_api_response
      : {};
  const summary = getAgentEvalSummary(evaluation);
  const totalCases = Number(summary.total_cases);
  const completedCases = Number(summary.completed_cases);
  const successful = Number(summary.overall_successful);
  const successRate = Number(summary.overall_success_rate);
  const expectedToolOutput = Number(summary.expected_tool_output ?? summary[`contains_${"ok"}`]);
  const expectedToolOutputRate = Number(summary.expected_tool_output_rate ?? summary[`contains_${"ok"}_rate`]);
  const savedMinutes = Number(summary.saved_minutes);
  const averageAgentSeconds = Number(summary.average_agent_seconds);
  const averageHumanMinutes = Number(summary.average_human_time_minutes);
  const outputIndex =
    evaluation?.output_opensearch_index ||
    response.output_opensearch_index ||
    response.persisted?.index ||
    "agent_eval_output";
  const runId = evaluation?.eval_run_id || response.run_id;
  const ingestedAtUnix = Number(response.ingested_at_unix);
  const ingestedLabel = Number.isFinite(ingestedAtUnix)
    ? format(new Date(ingestedAtUnix * 1000), "MMM d, yyyy h:mm a")
    : formatEvaluationDate(response.created_time || evaluation?.completed_at || evaluation?.updated_date);
  const statClass =
    "rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-3";

  return (
    <div className="mt-3 rounded-xl border border-purple-200/70 dark:border-purple-900/40 bg-purple-50/50 dark:bg-purple-950/15 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-200">
            Agent DeepEval Summary
          </p>
          <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {response.agent_name || evaluation?.item_name || "Agent"}
          </p>
        </div>
        <Badge
          variant="secondary"
          className={`w-fit ${
            Number.isFinite(successful) && Number.isFinite(totalCases) && successful === totalCases
              ? "bg-green-100 text-green-700"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {Number.isFinite(successful) && Number.isFinite(totalCases) && successful === totalCases
            ? "Success"
            : "Completed"}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        {Number.isFinite(Number(completedRunCount)) && (
          <div className={statClass}>
            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Runs</p>
            <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
              {completedRunCount}
            </p>
          </div>
        )}
        <div className={statClass}>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Cases</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(totalCases) ? totalCases : "—"}
          </p>
        </div>
        <div className={statClass}>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Completed</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(completedCases) && Number.isFinite(totalCases) ? `${completedCases}/${totalCases}` : "—"}
          </p>
        </div>
        <div className={statClass}>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Success</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(successful) && Number.isFinite(totalCases) ? `${successful}/${totalCases}` : "—"}
          </p>
          <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
            {formatAgentEvalPercent(successRate)}
          </p>
        </div>
        <div className={statClass}>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Expected Tool Output</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(expectedToolOutput) && Number.isFinite(totalCases) ? `${expectedToolOutput}/${totalCases}` : "—"}
          </p>
          <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
            {formatAgentEvalPercent(expectedToolOutputRate)}
          </p>
        </div>
        <div className={statClass}>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Time Saved</p>
          <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
            {formatAgentEvalMinutes(savedMinutes)}
          </p>
          <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
            Avg agent {formatAgentEvalSeconds(averageAgentSeconds)} / human {formatAgentEvalMinutes(averageHumanMinutes)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-gray-600 dark:text-gray-300">
        {runId && (
          <span className="rounded-full border border-gray-200/80 dark:border-gray-800 bg-white/70 dark:bg-gray-950/30 px-2 py-1">
            Run {runId}
          </span>
        )}
        <span className="rounded-full border border-gray-200/80 dark:border-gray-800 bg-white/70 dark:bg-gray-950/30 px-2 py-1">
          Index {outputIndex}
        </span>
        {ingestedLabel && (
          <span className="rounded-full border border-gray-200/80 dark:border-gray-800 bg-white/70 dark:bg-gray-950/30 px-2 py-1">
            Saved {ingestedLabel}
          </span>
        )}
      </div>
    </div>
  );
};

const AgentEvalCasesList = ({ cases = [], maxRows = null }) => {
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [deletingId, setDeletingId] = useState(null);
  const initialRows = Array.isArray(cases) ? cases : [];
  const first = initialRows[0];
  const agentId = first?.item_id;
  const indexName = first?.output_opensearch_index || "agent_eval_output";
  const pageSize = 10;
  const { data: pageData, isFetching, error: pageError } = useQuery({
    queryKey: ["agent-case-page", agentId, indexName, page, statusFilter],
    enabled: expanded && Boolean(agentId),
    queryFn: async () => {
      const params = new URLSearchParams({ agent_id: agentId, index: indexName, limit: String(pageSize), offset: String(page * pageSize), case_status: statusFilter });
      const response = await fetch(`${getEvalServiceBaseUrl()}/agent-deepeval-results?${params}`);
      const payload = await response.json();
      if (!response.ok || payload.status === "error") throw new Error(payload.message || "Unable to load cases");
      return payload;
    },
  });
  // Older Eval servers omit pagination metadata; paginate the supplied cases locally.
  const serverPaginated = Number.isFinite(pageData?.offset);
  const matchesFilter = (evaluation) => statusFilter === "success"
    ? evaluation?.passed === true
    : statusFilter === "failed" ? evaluation?.passed === false : true;
  const localRows = initialRows.filter(matchesFilter);
  const rows = serverPaginated
    ? getAgentEvalResultCases(pageData).map((item, index) => normalizeAgentEvalCaseToEvaluation({ id: agentId, name: first?.item_name }, pageData, item, index))
    : localRows.slice(page * pageSize, (page + 1) * pageSize);
  const totalRows = serverPaginated ? (pageData.filtered_case_count ?? pageData.case_count ?? 0) : localRows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  useEffect(() => {
    if (!isFetching && page >= pageCount) setPage(pageCount - 1);
  }, [isFetching, page, pageCount]);
  const deleteCaseResult = async (evaluation) => {
    const response = evaluation.eval_api_response || {};
    if (!window.confirm(`Delete result for ${response.run_id}, case ${response.case_number}?`)) return;
    setDeletingId(evaluation.id);
    try {
      const result = await fetch(`${getEvalServiceBaseUrl()}/agent-deepeval-case-result`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: evaluation.item_id, run_id: response.run_id, case_number: response.case_number, index: indexName }),
      });
      const responseText = await result.text();
      let payload;
      try { payload = JSON.parse(responseText); }
      catch {
        throw new Error(`Eval delete endpoint returned HTML or an invalid response (HTTP ${result.status}). Restart or deploy the updated Eval service and check the Eval API URL.`);
      }
      if (!result.ok || payload.status === "error") throw new Error(payload.message || "Unable to delete result");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["agent-case-page"] }), queryClient.invalidateQueries({ queryKey: ["agent-deepeval-output"] })]);
      toast.success("Case result deleted");
    } catch (error) { toast.error(error.message); }
    finally { setDeletingId(null); }
  };
  const hasMaxRows = maxRows !== null && maxRows !== undefined && Number.isFinite(Number(maxRows));
  const successRows = rows.filter((evaluation) => evaluation?.passed === true).length;
  const failedRows = rows.filter((evaluation) => evaluation?.passed === false).length;
  const filteredRows = rows.filter((evaluation) => {
    if (statusFilter === "success") return evaluation?.passed === true;
    if (statusFilter === "failed") return evaluation?.passed === false;
    return true;
  });
  const visibleRows = hasMaxRows ? filteredRows.slice(0, Number(maxRows)) : filteredRows;
  if (!initialRows.length && !pageData) return null;

  return (
    <div className="mt-3 rounded-xl border border-gray-200/70 dark:border-gray-800 bg-white/70 dark:bg-gray-900/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
            Case Results
          </span>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {pageData?.case_count ?? initialRows.length} cases · {pageData?.successful_cases ?? successRows} success · {pageData?.failed_cases ?? failedRows} failed
          </span>
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Hide details" : "Show details"}
        </Button>
      </div>
      {!expanded ? null : (
      <>
      <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {["all", "success", "failed"].map((filter) => (
            <Button
              key={filter}
              type="button"
              variant="outline"
              size="sm"
              className={`h-7 px-2 text-[11px] capitalize ${
                statusFilter === filter ? "border-purple-400 bg-purple-50 text-purple-700" : ""
              }`}
              onClick={() => { setStatusFilter(filter); setPage(0); }}
            >
              {filter}
            </Button>
          ))}
        </div>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {filteredRows.length}/{rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-950/20 p-3 text-xs text-gray-500 dark:text-gray-400">
          No {statusFilter} cases for this agent.
        </div>
      ) : (
      <div className="space-y-2">
        {visibleRows.map((evaluation, index) => {
          const response = evaluation?.eval_api_response || {};
          const checks = response.checks || {};
          const statusValue = getAgentCheckValue(checks, "status");
          const expectedToolValue = getAgentCheckValue(checks, "expected_tool");
          const expectedToolOutputValue = getAgentCheckValue(checks, "expected_tool_output");
          const timeValue = getAgentCheckValue(checks, "time");
          const success = evaluation?.passed === true;
          const metrics = Array.isArray(response.deepeval?.metrics) ? response.deepeval.metrics : [];
          const deepEvalMetricRows = metrics
            .map((metric) => {
              const metricId = normalizeAgentMetricKey(metric?.name || metric?.metric || metric?.id);
              const meta = AGENT_CASE_METRICS.find((item) => item.id === metricId);
              return {
                ...metric,
                metricId,
                label: meta?.name || metric?.name || metric?.metric || metric?.id || "Metric",
              };
            })
            .filter((metric) => metric.metricId && AGENT_CASE_METRIC_IDS.has(metric.metricId));
          const createdAt = formatEvaluationDate(evaluation.completed_at || response.created_time);
          const selectedTools = evaluation.selected_tools || response.selected_tools || [];
          const expectedTool = evaluation.expected_tool || response.expected_tool;
          const agentSeconds = Number(response.agent_seconds);
          const humanMinutes = Number(response.human_time_minutes);
          const savedMinutes = Number(response.saved_minutes);
          const timeOk =
            timeValue === true ||
            (Number.isFinite(agentSeconds) &&
              Number.isFinite(humanMinutes) &&
              agentSeconds / 60.0 <= humanMinutes);

          return (
            <div
              key={evaluation.id || response._id || `${response.run_id || "agent-case"}-${index}`}
              className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-950/20 p-3"
            >
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {response.run_id && (
                      <span className="rounded-full border border-gray-200/80 bg-white/80 px-2 py-0.5 text-[11px] text-gray-600 dark:border-gray-800 dark:bg-gray-900/50 dark:text-gray-300">
                        {response.run_id} · Case {response.case_number ?? index + 1}
                      </span>
                    )}
                    {createdAt && (
                      <span className="text-[11px] text-gray-500 dark:text-gray-400">{createdAt}</span>
                    )}
                  </div>
                  {response.question_id && <p className="mt-2 text-xs text-gray-500">Question ID: <code>{response.question_id}</code></p>}
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    Agent instruction
                  </p>
                  <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100">
                    {evaluation.test_scenario || response.question || "Agent evaluation case"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {response.run_id && response.case_number && (
                    <Button type="button" variant="outline" size="sm" disabled={Boolean(deletingId) || isFetching} onClick={() => deleteCaseResult(evaluation)}>Delete result</Button>
                  )}
                  <Badge variant="secondary" className="bg-gray-100 text-gray-700">
                    {response.status || evaluation.status || "COMPLETED"}
                  </Badge>
                  <Badge
                    variant="secondary"
                    className={success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}
                  >
                    {success ? "Success" : "Fail"}
                  </Badge>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-gray-600 dark:text-gray-300">
                {expectedTool && (
                  <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">
                    Expected {expectedTool}
                  </span>
                )}
                <span className={`rounded-full border px-2 py-1 ${booleanChipClass(statusValue)}`}>
                  Run completed: {formatBooleanValue(statusValue)}
                </span>
                <span className={`rounded-full border px-2 py-1 ${booleanChipClass(expectedToolValue)}`}>
                  Expected tool: {formatBooleanValue(expectedToolValue)}
                </span>
                <span className={`rounded-full border px-2 py-1 ${booleanChipClass(expectedToolOutputValue)}`}>
                  Expected tool output: {formatBooleanValue(expectedToolOutputValue)}
                </span>
                {deepEvalMetricRows.map((metric) => {
                  const score = Number(metric.score);
                  const isSkipped = metric.skipped === true;
                  const isPassed = metric.passed === true || (isSkipped && metric.passed !== false);
                  const chipClass = isSkipped
                    ? "border-gray-200 bg-gray-50 text-gray-600"
                    : isPassed
                      ? "border-green-200 bg-green-50 text-green-700"
                      : "border-red-200 bg-red-50 text-red-700";
                  return (
                    <span key={`${metric.metricId}-${metric.name || metric.label}`} className={`rounded-full border px-2 py-1 ${chipClass}`}>
                      {metric.label} {Number.isFinite(score) ? formatMetricScore(score) : isSkipped ? "Skipped" : "—"}
                    </span>
                  );
                })}
                {Number.isFinite(humanMinutes) && (
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-sky-700">
                    Human {formatAgentEvalMinutes(humanMinutes)}
                  </span>
                )}
                {Number.isFinite(agentSeconds) && (
                  <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-700">
                    Agent {formatAgentEvalSeconds(agentSeconds)}
                  </span>
                )}
                {Number.isFinite(savedMinutes) && (
                  <span className={`rounded-full border px-2 py-1 ${timeOk ? "border-green-200 bg-green-50 text-green-700" : "border-red-200 bg-red-50 text-red-700"}`}>
                    Saved {formatAgentEvalMinutes(savedMinutes)}
                  </span>
                )}
                {(Number.isFinite(humanMinutes) || Number.isFinite(agentSeconds)) && (
                  <span className={`rounded-full border px-2 py-1 ${booleanChipClass(timeOk)}`}>
                    Time: {formatBooleanValue(timeOk)}
                  </span>
                )}
              </div>

              {(response.actual_output || response.deepeval?.actual_output || evaluation.actual_output || response.result_preview) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-purple-600">Agent response</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs">{String(response.actual_output || response.deepeval?.actual_output || evaluation.actual_output || response.result_preview)}</p>
                </details>
              )}
              {deepEvalMetricRows.some((metric) => metric.reason) && (
                <div className="mt-2 space-y-1">
                  {deepEvalMetricRows
                    .filter((metric) => metric.reason)
                    .map((metric) => (
                      <details key={`reason-${metric.metricId}-${metric.name || metric.label}`}>
                        <summary className="cursor-pointer text-[11px] text-purple-600 dark:text-purple-300">
                          {metric.label} reason
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap text-[11px] text-gray-600 dark:text-gray-300">
                          {String(metric.reason)}
                        </p>
                      </details>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
      {pageError && <p className="mt-2 text-xs text-red-600">{pageError.message}</p>}
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((value) => value - 1)}>Previous</Button>
        <span className="text-xs">{isFetching ? "Loading…" : `Page ${page + 1} of ${pageCount} · ${totalRows} cases`}</span>
        <Button type="button" variant="outline" size="sm" disabled={isFetching || page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</Button>
      </div>
      {hasMaxRows && filteredRows.length > Number(maxRows) && (
        <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
          Showing {visibleRows.length} of {filteredRows.length} cases.
        </p>
      )}
      </>
      )}
    </div>
  );
};

const AgentEvalOutputPanel = ({ agent, result, isLoading, error }) => {
  if (isLoading) {
    return (
      <div className="mt-4 grid gap-2 md:grid-cols-4">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
        Agent eval results could not be loaded from <code>agent_eval_output</code>.
      </div>
    );
  }

  const evaluation = buildAgentEvaluationGroupFromOutput(agent, result);
  if (!evaluation) {
    return (
      <div className="mt-4 rounded-xl border border-gray-200/70 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-950/20 p-3 text-xs text-gray-500 dark:text-gray-400">
        No Agent DeepEval results found in <code>agent_eval_output</code> for this agent yet.
      </div>
    );
  }

  const caseRows = getAgentEvalResultCases(result)
    .map((item, index) => normalizeAgentEvalCaseToEvaluation(agent, result, item, index))
    .filter(Boolean);
  const successfulCases = Number(result?.successful_cases);
  const failedCases = Number(result?.failed_cases);
  const totalCases = Number(result?.case_count);

  return (
    <div className="mt-4 space-y-3">
      <AgentEvaluationSummaryCard
        evaluation={evaluation}
        completedRunCount={Number(result?.run_count) || 0}
        compact
      />

      <div className="grid gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-950/20 p-3">
          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">All Cases</p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(totalCases) ? totalCases : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-950/15 p-3">
          <p className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-200">Successful</p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(successfulCases) ? successfulCases : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-rose-200/70 dark:border-rose-900/40 bg-rose-50/60 dark:bg-rose-950/15 p-3">
          <p className="text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-200">Failed</p>
          <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
            {Number.isFinite(failedCases) ? failedCases : "—"}
          </p>
        </div>
      </div>

      <AgentEvalCasesList cases={caseRows} />
    </div>
  );
};

const getMetricHealth = (metricMeta, score) => {
  if (!metricMeta || !Number.isFinite(score) || metricMeta.threshold == null) return null;
  return metricMeta.inverse ? score <= metricMeta.threshold : score >= metricMeta.threshold;
};

const getHealthPillClasses = (health) => {
  if (health === true) {
    return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200";
  }
  if (health === false) {
    return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-900/20 dark:text-rose-200";
  }
  return "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200";
};

const HISTOGRAM_TIMEFRAMES = [
  { id: 'daily', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last10', label: 'Last 10 days' },
  { id: '30d', label: 'Last 30 days' },
];
const HISTOGRAM_VISIBLE_TIMEFRAMES = 3;

const getTimeframeRange = (timeframeId, now = Date.now()) => {
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  switch (timeframeId) {
    case 'daily':
      return { start: todayStart, end: now };
    case 'yesterday':
      return { start: todayStart - MS_PER_DAY, end: todayStart };
    case 'last10':
      return { start: now - 10 * MS_PER_DAY, end: now };
    case '30d':
      return { start: now - 30 * MS_PER_DAY, end: now };
    default:
      return { start: 0, end: now };
  }
};

const formatTimeframeRangeLabel = (timeframeId, start, end) => {
  if (timeframeId === 'daily' || timeframeId === 'yesterday') {
    return format(new Date(start), 'MMM d');
  }
  return `${format(new Date(start), 'MMM d')} – ${format(new Date(end - 1), 'MMM d')}`;
};

const DEEPEVAL_METRIC_IDS = new Set(DEEPEVAL_METRICS.map((metric) => metric.id));
const METRIC_KEY_ALIASES = {
  answerrelevancy: 'answer_relevancy',
  answerrelevancymetric: 'answer_relevancy',
  contextualrelevancy: 'contextual_relevancy',
  contextualrelevancymetric: 'contextual_relevancy',
  contextualprecision: 'contextual_precision',
  contextualprecisionmetric: 'contextual_precision',
  contextualrecall: 'contextual_recall',
  contextualrecallmetric: 'contextual_recall',
  faithfulness: 'faithfulness',
  faithfulnessmetric: 'faithfulness',
  hallucination: 'hallucination',
  hallucinationmetric: 'hallucination',
  hallucinationdetection: 'hallucination',
  hallucinationdetectionmetric: 'hallucination',
  bias: 'bias',
  biasmetric: 'bias',
  biasdetection: 'bias',
  biasdetectionmetric: 'bias',
  toxicity: 'toxicity',
  toxicitymetric: 'toxicity',
  toxicitydetection: 'toxicity',
  toxicitydetectionmetric: 'toxicity',
  correctnesssimilarity: 'correctness_similarity',
  correctnesssimilaritymetric: 'correctness_similarity',
  toolcorrectness: 'correctness_similarity',
  toolcorrectnessmetric: 'correctness_similarity',
  taskcompletion: 'g_eval',
  taskcompletionmetric: 'g_eval',
  geval: 'g_eval',
  gevalcustomreview: 'g_eval',
};

const normalizeMetricKey = (key) => {
  if (!key) return null;
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return null;
  if (METRIC_KEY_ALIASES[normalized]) return METRIC_KEY_ALIASES[normalized];
  if (normalized.startsWith('correctnesssimilarity')) return 'correctness_similarity';
  if (normalized.startsWith('toolcorrectness')) return 'correctness_similarity';
  if (normalized.startsWith('taskcompletion')) return 'g_eval';
  if (normalized.startsWith('answerrelevancy')) return 'answer_relevancy';
  if (normalized.startsWith('contextualrelevancy')) return 'contextual_relevancy';
  if (normalized.startsWith('contextualprecision')) return 'contextual_precision';
  if (normalized.startsWith('contextualrecall')) return 'contextual_recall';
  if (normalized.startsWith('faithfulness')) return 'faithfulness';
  if (normalized.startsWith('hallucination')) return 'hallucination';
  if (normalized.startsWith('toxicity')) return 'toxicity';
  if (normalized.startsWith('bias')) return 'bias';
  if (normalized.startsWith('geval')) return 'g_eval';
  if (normalized.endsWith('metric')) {
    const trimmed = normalized.slice(0, -6);
    if (METRIC_KEY_ALIASES[trimmed]) return METRIC_KEY_ALIASES[trimmed];
  }
  if (normalized.endsWith('score')) {
    const trimmed = normalized.slice(0, -5);
    if (METRIC_KEY_ALIASES[trimmed]) return METRIC_KEY_ALIASES[trimmed];
    return trimmed;
  }
  return METRIC_KEY_ALIASES[normalized] || normalized;
};

const AGENT_CASE_METRIC_IDS = new Set(AGENT_CASE_METRICS.map((metric) => metric.id));

const AGENT_METRIC_KEY_ALIASES = {
  toolcorrectness: "tool_correct",
  toolcorrectnessmetric: "tool_correct",
  taskcompletion: "task_completion",
  taskcompletiongeval: "task_completion",
  taskcompletionmetric: "task_completion",
  stepefficiency: "step_efficiency",
  stepefficiencygeval: "step_efficiency",
  stepefficiencymetric: "step_efficiency",
  argumentcorrectness: "argument_correctness",
  argumentcorrectnessmetric: "argument_correctness",
};

const normalizeAgentMetricKey = (key) => {
  if (!key) return null;
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  if (AGENT_METRIC_KEY_ALIASES[normalized]) return AGENT_METRIC_KEY_ALIASES[normalized];
  if (normalized.startsWith("toolcorrectness")) return "tool_correct";
  if (normalized.startsWith("taskcompletion")) return "task_completion";
  if (normalized.startsWith("stepefficiency")) return "step_efficiency";
  if (normalized.startsWith("argumentcorrectness")) return "argument_correctness";
  const fallback = normalizeMetricKey(key);
  return AGENT_CASE_METRIC_IDS.has(fallback) ? fallback : normalized;
};

const IN_PROGRESS_EVAL_STATUSES = new Set([
  "running",
  "processing",
  "pending",
  "queued",
  "in_progress",
  "in-progress",
  "started",
]);

const TERMINAL_EVAL_STATUSES = new Set([
  "completed",
  "complete",
  "finished",
  "done",
  "passed",
  "pass",
  "success",
  "failed",
  "fail",
  "error",
]);

const getEvalResponseStatusValue = (body) => {
  if (!body || typeof body !== "object") return "";
  return String(
    body.overall_status ||
      body.status ||
      body.eval_overall_status ||
      body.state ||
      body.job_status ||
      body.jobStatus ||
      body.phase ||
      ""
  ).trim().toLowerCase();
};

const isEvalResponseInProgress = (body) => IN_PROGRESS_EVAL_STATUSES.has(getEvalResponseStatusValue(body));

const isEvaluationRecordInProgress = (evaluation) => {
  if (!evaluation || typeof evaluation !== "object") return false;
  const topLevelStatus = String(evaluation.status || "").trim().toLowerCase();
  const evalStatus = String(evaluation.eval_status || evaluation.eval_overall_status || "").trim().toLowerCase();
  return (
    IN_PROGRESS_EVAL_STATUSES.has(topLevelStatus) ||
    IN_PROGRESS_EVAL_STATUSES.has(evalStatus) ||
    isEvalResponseInProgress(evaluation.eval_api_response)
  );
};

const isEvaluationResultTerminal = (evaluation) => {
  if (!evaluation || typeof evaluation !== "object") return false;
  if (isEvaluationRecordInProgress(evaluation)) return false;
  const topLevelStatus = String(evaluation.status || "").trim().toLowerCase();
  const evalStatus = String(evaluation.eval_status || evaluation.eval_overall_status || "").trim().toLowerCase();
  const responseStatus = getEvalResponseStatusValue(evaluation.eval_api_response);
  return (
    TERMINAL_EVAL_STATUSES.has(topLevelStatus) ||
    TERMINAL_EVAL_STATUSES.has(evalStatus) ||
    TERMINAL_EVAL_STATUSES.has(responseStatus) ||
    Boolean(evaluation.completed_at || evaluation.finished_at || evaluation.ended_at || evaluation.eval_results_found)
  );
};

function getNormalizedSummaryAvgScores(avgScores) {
  const normalized = {};
  const fallbackAliasScores = {};
  if (!avgScores || typeof avgScores !== 'object') return normalized;

  Object.entries(avgScores).forEach(([metricKey, value]) => {
    if (metricKey === 'Average_Score') return;
    const metricId = normalizeMetricKey(metricKey);
    if (!metricId || !DEEPEVAL_METRIC_IDS.has(metricId)) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;

    // Computed per-record averages are written with canonical metric ids. Prefer
    // those over backend alias summaries so the UI matches the downloaded CSV.
    if (metricKey === metricId) {
      normalized[metricId] = numeric;
      return;
    }

    // Some backends return multiple aliases (e.g. `AnswerRelevancy_Score` +
    // `AnswerRelevancyMetric_Score`) and fill non-selected metrics with 0.
    // Keep the old highest-value fallback only when no canonical average exists.
    if (fallbackAliasScores[metricId] === undefined || numeric > fallbackAliasScores[metricId]) {
      fallbackAliasScores[metricId] = numeric;
    }
  });

  Object.entries(fallbackAliasScores).forEach(([metricId, value]) => {
    if (normalized[metricId] === undefined) {
      normalized[metricId] = value;
    }
  });

  return normalized;
}

const parseMetricResult = (rawValue) => {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue === "object") {
    const scoreCandidate = rawValue.score ?? rawValue.value ?? rawValue.result ?? rawValue.rating;
    const score = Number(scoreCandidate);
    const reasonCandidate =
      rawValue.reason ??
      rawValue.reasoning ??
      rawValue.explanation ??
      rawValue.details ??
      rawValue.rationale ??
      rawValue.justification ??
      rawValue.analysis ??
      rawValue.feedback ??
      rawValue.commentary ??
      rawValue.comment ??
      rawValue.message;
    const thresholdCandidate =
      rawValue.threshold ?? rawValue.cutoff ?? rawValue.min_score ?? rawValue.pass_threshold;
    const threshold = Number(thresholdCandidate);
    const result = {};
    if (Number.isFinite(score)) result.score = score;
    if (reasonCandidate !== undefined && reasonCandidate !== null) {
      const normalizedReason =
        typeof reasonCandidate === "string"
          ? reasonCandidate
          : typeof reasonCandidate === "object"
            ? JSON.stringify(reasonCandidate, null, 2)
            : String(reasonCandidate);
      const numericReason = Number(normalizedReason);
      if (!Number.isFinite(numericReason) || !Number.isFinite(score) || numericReason !== score) {
        if (normalizedReason.trim()) result.reason = normalizedReason;
      }
    }
    if (Number.isFinite(threshold)) result.threshold = threshold;
    return Object.keys(result).length ? result : null;
  }
  if (typeof rawValue === "string") {
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) return { score: numeric };
    const trimmed = rawValue.trim();
    return trimmed ? { reason: trimmed } : null;
  }
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) return { score: numeric };
  return null;
};

const mergeMetricResult = (target, metricId, rawValue, options = {}) => {
  if (!metricId) return;
  const normalizedId = DEEPEVAL_METRIC_IDS.has(metricId)
    ? metricId
    : normalizeMetricKey(metricId);
  if (!normalizedId || !DEEPEVAL_METRIC_IDS.has(normalizedId)) return;
  const parsed = parseMetricResult(rawValue);
  if (!parsed) return;
  const existing = target[normalizedId] || {};
  const shouldKeepExistingScore =
    options.preserveExistingScore &&
    Number.isFinite(Number(existing.score)) &&
    Number.isFinite(Number(parsed.score));
  target[normalizedId] = {
    ...existing,
    ...parsed,
    ...(shouldKeepExistingScore ? { score: existing.score } : {}),
    reason: parsed.reason || existing.reason || "",
  };
};

const extractMetricMapFromEntry = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  const candidates = [
    entry.metrics,
    entry.metric_scores,
    entry.metricScores,
    entry.scores,
    entry.evaluations,
    entry.eval_results,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return null;
};

const extractMetricDetailsFromReasoningRecord = (record) => {
  if (!record || typeof record !== "object") return null;
  const details = {};
  const entries = Object.entries(record);
  for (const [key, value] of entries) {
    if (typeof key !== "string") continue;
    if (key.endsWith("_Reasoning")) {
      const baseKey = key.replace(/_Reasoning$/, "");
      mergeMetricResult(details, baseKey, { reason: value });
    } else if (key.endsWith("_Score")) {
      const baseKey = key.replace(/_Score$/, "");
      mergeMetricResult(details, baseKey, { score: value });
    }
  }
  return Object.keys(details).length ? details : null;
};

const parseCsvRecords = (csvText) => {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const text = String(csvText || "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];

  const headers = rows[0].map((header, index) =>
    index === 0 ? String(header).replace(/^\uFEFF/, "") : String(header)
  );
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
};

const computeAvgScoresFromEvalResultJson = (payload, allowedMetricIds = null) => {
  if (!payload || typeof payload !== "object") return null;

  const allowed =
    allowedMetricIds && allowedMetricIds.size
      ? allowedMetricIds
      : null;

  const pickFirstArray = (obj) => {
    if (!obj || typeof obj !== "object") return [];
    const candidates = [
      obj.results,
      obj.records,
      obj.items,
      obj.data,
    ];
    const chosen = candidates.find((value) => Array.isArray(value) && value.length > 0);
    return Array.isArray(chosen) ? chosen : [];
  };

  const entries = pickFirstArray(payload);
  if (!entries.length) return null;

  const primarySums = {};
  const primaryCounts = {};
  const fallbackSums = {};
  const fallbackCounts = {};

  const addCaseScore = (metricId, score, preferred = true) => {
    if (!metricId || !DEEPEVAL_METRIC_IDS.has(metricId)) return;
    if (allowed && !allowed.has(metricId)) return;
    if (!Number.isFinite(score)) return;
    const sums = preferred ? primarySums : fallbackSums;
    const counts = preferred ? primaryCounts : fallbackCounts;
    if (sums[metricId] === undefined) {
      sums[metricId] = 0;
      counts[metricId] = 0;
    }
    sums[metricId] += score;
    counts[metricId] += 1;
  };

  const isPrimaryScoreKey = (key, metricId) => {
    const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!normalizedKey) return true;
    if (normalizedKey.includes("metric")) return false;
    if (metricId === "correctness_similarity") {
      return normalizedKey.includes("geval");
    }
    return true;
  };

  const collectScoresFromMap = (map, primaryCaseScores, fallbackCaseScores) => {
    if (!map || typeof map !== "object") return;
    const validReasonsByMetric = {};
    Object.entries(map).forEach(([key, rawValue]) => {
      const metricId = normalizeMetricKey(key);
      if (!metricId || !DEEPEVAL_METRIC_IDS.has(metricId)) return;
      const parsed = parseMetricResult(rawValue);
      const reason = String(parsed?.reason || "").trim();
      if (reason.startsWith("The score is")) {
        validReasonsByMetric[metricId] = reason;
      }
    });

    Object.entries(map).forEach(([key, rawValue]) => {
      const metricId = normalizeMetricKey(key);
      if (!metricId || !DEEPEVAL_METRIC_IDS.has(metricId)) return;
      if (allowed && !allowed.has(metricId)) return;
      const parsed = parseMetricResult(rawValue);
      const numeric = Number(parsed?.score);
      if (!Number.isFinite(numeric)) return;
      const reason = String(parsed?.reason || validReasonsByMetric[metricId] || "").trim();
      if (!reason.startsWith("The score is")) return;
      const target = isPrimaryScoreKey(key, metricId) ? primaryCaseScores : fallbackCaseScores;
      if (target[metricId] === undefined || numeric > target[metricId]) {
        target[metricId] = numeric;
      }
    });
  };

  entries.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const primaryCaseScores = {};
    const fallbackCaseScores = {};

    collectScoresFromMap(entry?.deepeval_metrics, primaryCaseScores, fallbackCaseScores);
    collectScoresFromMap(extractMetricMapFromEntry(entry), primaryCaseScores, fallbackCaseScores);
    collectScoresFromMap(extractMetricDetailsFromReasoningRecord(entry), primaryCaseScores, fallbackCaseScores);
    // Some backends flatten metric columns at the top level of each row.
    collectScoresFromMap(entry, primaryCaseScores, fallbackCaseScores);

    Object.entries(primaryCaseScores).forEach(([metricId, score]) => {
      addCaseScore(metricId, Number(score), true);
    });
    Object.entries(fallbackCaseScores).forEach(([metricId, score]) => {
      addCaseScore(metricId, Number(score), false);
    });
  });

  const avgScores = {};
  Object.entries(primaryCounts).forEach(([metricId, count]) => {
    if (!count) return;
    avgScores[metricId] = primarySums[metricId] / count;
  });
  Object.entries(fallbackCounts).forEach(([metricId, count]) => {
    if (!count || avgScores[metricId] !== undefined) return;
    avgScores[metricId] = fallbackSums[metricId] / count;
  });
  return Object.keys(avgScores).length ? avgScores : null;
};

const extractMetricDetailsFromResponse = (responseJson) => {
  const details = {};
  if (!responseJson || typeof responseJson !== "object") return details;

  const directObject =
    responseJson.deepeval_metrics && typeof responseJson.deepeval_metrics === "object"
      ? responseJson.deepeval_metrics
      : null;
  if (directObject) {
    Object.entries(directObject).forEach(([metricId, result]) => {
      mergeMetricResult(details, metricId, result);
    });
    if (Object.keys(details).length) return details;
  }

  const topLevelObjectCandidates = [
    responseJson.metrics,
    responseJson.metric_scores,
    responseJson.metricScores,
    responseJson.scores,
    responseJson.evaluations,
  ];
  for (const candidate of topLevelObjectCandidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      Object.entries(candidate).forEach(([metricId, result]) => {
        mergeMetricResult(details, metricId, result);
      });
      if (Object.keys(details).length) return details;
    }
  }

  const listCandidates = [
    responseJson.metrics,
    responseJson.rag_metrics,
    responseJson.cases,
    responseJson.results,
    responseJson.items,
    responseJson.records,
    responseJson.data,
  ];
  const list = listCandidates.find((v) => Array.isArray(v));
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry) continue;
      const name = entry.name || entry.metric || entry.id;
      if (name) {
        mergeMetricResult(details, name, entry);
        continue;
      }
      const nestedMetrics = extractMetricMapFromEntry(entry);
      if (nestedMetrics) {
        Object.entries(nestedMetrics).forEach(([metricId, result]) => {
          mergeMetricResult(details, metricId, result);
        });
        continue;
      }
      const nestedMetricList =
        (entry.deepeval && Array.isArray(entry.deepeval.metrics) ? entry.deepeval.metrics : null) ||
        (Array.isArray(entry.metrics) ? entry.metrics : null);
      if (nestedMetricList) {
        nestedMetricList.forEach((metric) => {
          mergeMetricResult(details, metric?.name || metric?.metric || metric?.id, metric);
        });
        continue;
      }
      const recordDetails = extractMetricDetailsFromReasoningRecord(entry);
      if (recordDetails) {
        Object.entries(recordDetails).forEach(([metricId, result]) => {
          mergeMetricResult(details, metricId, result);
        });
      }
    }
    if (Object.keys(details).length) return details;
  }

  const resultsArray = Array.isArray(responseJson.results) ? responseJson.results : [];
  if (resultsArray.length === 1) {
    const nestedMetrics = extractMetricMapFromEntry(resultsArray[0]);
    if (nestedMetrics) {
      Object.entries(nestedMetrics).forEach(([metricId, result]) => {
        mergeMetricResult(details, metricId, result);
      });
    }
    const recordDetails = extractMetricDetailsFromReasoningRecord(resultsArray[0]);
    if (recordDetails) {
      Object.entries(recordDetails).forEach(([metricId, result]) => {
        mergeMetricResult(details, metricId, result);
      });
    }
  }

  return details;
};

const getEvaluationMetricDetails = (evaluation) => {
  const details = {};
  if (!evaluation) return details;
  if (!isEvaluationResultTerminal(evaluation)) return details;

  const deepevalObject = evaluation?.deepeval_metrics;
  if (deepevalObject && typeof deepevalObject === "object") {
    Object.entries(deepevalObject).forEach(([metricId, result]) => {
      mergeMetricResult(details, metricId, result);
    });
  }

  const evalApiResponse =
    evaluation.eval_api_response && typeof evaluation.eval_api_response === "object"
      ? evaluation.eval_api_response
      : null;
  if (evalApiResponse) {
    const extracted = extractMetricDetailsFromResponse(evalApiResponse);
    Object.entries(extracted).forEach(([metricId, result]) => {
      mergeMetricResult(details, metricId, result);
    });
  }

  const summaryAvgScores =
    evaluation?.eval_summary?.avg_scores ||
    evaluation?.summary?.avg_scores ||
    evalApiResponse?.summary?.avg_scores;
  if (summaryAvgScores && typeof summaryAvgScores === "object") {
    const normalized = getNormalizedSummaryAvgScores(summaryAvgScores);
    Object.entries(normalized).forEach(([metricId, value]) => {
      mergeMetricResult(details, metricId, value);
    });
  }

  if (evalApiResponse) {
    const computedAvgScores = computeAvgScoresFromEvalResultJson(evalApiResponse);
    if (computedAvgScores) {
      Object.entries(computedAvgScores).forEach(([metricId, value]) => {
        mergeMetricResult(details, metricId, value);
      });
    }
  }

  return details;
};

const computeQualityRiskScores = (metricDetails) => {
  if (!metricDetails || typeof metricDetails !== "object") {
    return { qualityScore: null, riskScore: null, combinedScore: null };
  }
  const qualityScores = [];
  const riskScores = [];
  DEEPEVAL_METRICS.forEach((metric) => {
    const entry = metricDetails[metric.id];
    const numeric = Number(entry?.score);
    if (!Number.isFinite(numeric)) return;
    if (metric.inverse) {
      riskScores.push(numeric);
    } else {
      qualityScores.push(numeric);
    }
  });
  const avg = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const qualityScore = avg(qualityScores);
  const riskScore = avg(riskScores);
  let combinedScore = null;
  if (Number.isFinite(qualityScore) && Number.isFinite(riskScore)) {
    combinedScore = (qualityScore + (1 - riskScore)) / 2;
  } else if (Number.isFinite(qualityScore) && !Number.isFinite(riskScore)) {
    combinedScore = qualityScore;
  }
  return { qualityScore, riskScore, combinedScore };
};

const getMetricDisplayScore = (metric, rawScore) => {
  const numeric = Number(rawScore);
  if (!Number.isFinite(numeric)) return null;
  const clamped = Math.min(1, Math.max(0, numeric));
  // For "lower is better" metrics, invert so graphs are consistent (higher is better).
  return metric?.inverse ? 1 - clamped : clamped;
};

const computeNextRunAtFromCron = (cronExpression) => {
  const cron = String(cronExpression || "").trim();
  if (!cron) return null;
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minPart, hourPart, dayPart, monthPart, weekdayPart] = parts;
  if (dayPart !== "*" || monthPart !== "*") {
    // We only support the common preset-style crons used in the UI today.
    if (!(dayPart === "1" && monthPart === "*")) return null;
  }

  const now = new Date();
  const base = new Date(now.getTime() + 60 * 1000);
  base.setSeconds(0, 0);

  const setTime = (date, hour, minute) => {
    const next = new Date(date);
    next.setHours(hour, minute, 0, 0);
    return next;
  };

  const isWeekdayAllowed = (date) => {
    if (weekdayPart === "*" || !weekdayPart) return true;
    const day = date.getDay(); // 0 Sun ... 6 Sat
    if (weekdayPart.toUpperCase() === "MON-FRI") return day >= 1 && day <= 5;
    if (weekdayPart.toUpperCase() === "MON") return day === 1;
    return null;
  };

  const parseIntStrict = (value) => {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  // Every N minutes: */5 * * * *
  if (/^\*\/\d+$/.test(minPart) && hourPart === "*" && weekdayPart === "*" && dayPart === "*" && monthPart === "*") {
    const step = parseIntStrict(minPart.slice(2));
    if (!step) return null;
    const d = new Date(base);
    const m = d.getMinutes();
    const delta = step - (m % step || step);
    d.setMinutes(m + delta);
    return d;
  }

  // Hourly at minute M: 0 * * * *
  if (parseIntStrict(minPart) !== null && hourPart === "*" && weekdayPart === "*" && dayPart === "*" && monthPart === "*") {
    const minute = parseIntStrict(minPart);
    if (minute === null || minute < 0 || minute > 59) return null;
    const d = new Date(base);
    const candidate = setTime(d, d.getHours(), minute);
    if (candidate <= now) {
      candidate.setHours(candidate.getHours() + 1);
    }
    return candidate;
  }

  // Every N hours at minute M: 0 */3 * * *
  if (parseIntStrict(minPart) !== null && /^\*\/\d+$/.test(hourPart) && weekdayPart === "*" && dayPart === "*" && monthPart === "*") {
    const minute = parseIntStrict(minPart);
    const step = parseIntStrict(hourPart.slice(2));
    if (minute === null || step === null) return null;
    for (let offsetHours = 0; offsetHours <= 48; offsetHours += 1) {
      const d = new Date(base);
      d.setHours(d.getHours() + offsetHours);
      const hour = d.getHours();
      if (hour % step !== 0) continue;
      const candidate = setTime(d, hour, minute);
      if (candidate > now) return candidate;
    }
    return null;
  }

  // Daily at HH:MM: 0 9 * * *
  if (parseIntStrict(minPart) !== null && parseIntStrict(hourPart) !== null && weekdayPart === "*" && dayPart === "*" && monthPart === "*") {
    const minute = parseIntStrict(minPart);
    const hour = parseIntStrict(hourPart);
    if (minute === null || hour === null) return null;
    const candidate = setTime(base, hour, minute);
    if (candidate > now) return candidate;
    const nextDay = new Date(candidate);
    nextDay.setDate(nextDay.getDate() + 1);
    return nextDay;
  }

  // Weekdays / weekly at HH:MM: 0 9 * * MON-FRI / MON
  if (parseIntStrict(minPart) !== null && parseIntStrict(hourPart) !== null && dayPart === "*" && monthPart === "*") {
    const minute = parseIntStrict(minPart);
    const hour = parseIntStrict(hourPart);
    if (minute === null || hour === null) return null;
    for (let offsetDays = 0; offsetDays <= 14; offsetDays += 1) {
      const d = new Date(base);
      d.setDate(d.getDate() + offsetDays);
      const allowed = isWeekdayAllowed(d);
      if (allowed === false) continue;
      if (allowed === null) return null;
      const candidate = setTime(d, hour, minute);
      if (candidate > now) return candidate;
    }
    return null;
  }

  // Monthly on 1st at HH:MM: 0 0 1 * *
  if (parseIntStrict(minPart) !== null && parseIntStrict(hourPart) !== null && dayPart === "1" && monthPart === "*" && weekdayPart === "*") {
    const minute = parseIntStrict(minPart);
    const hour = parseIntStrict(hourPart);
    if (minute === null || hour === null) return null;
    const d = new Date(base);
    const candidate = new Date(d.getFullYear(), d.getMonth(), 1, hour, minute, 0, 0);
    if (candidate > now) return candidate;
    return new Date(d.getFullYear(), d.getMonth() + 1, 1, hour, minute, 0, 0);
  }

  return null;
};

const getEvalRunApiUrl = () => {
  return `${getEvalServiceBaseUrl() || ""}/run-evaluation`;
};

const getEvalServiceBaseUrl = () => {
  const configured = import.meta.env.VITE_EVAL_API_BASE_URL || "";
  if (configured) return String(configured).replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const { host, hostname, origin, protocol } = window.location;
    if (host === "localhost" || host === "127.0.0.1" || hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:5001";
    }
    const url = new URL(origin);
    if (url.hostname.startsWith("agentflow.")) {
      url.hostname = url.hostname.replace(/^agentflow\./, "eval.");
    }
    if (url.hostname === "agentflow") {
      url.hostname = "eval";
    }
    if (url.port) url.port = "";
    return url.toString().replace(/\/+$/, "") || `${protocol}//${host.replace(/^agentflow\./, "eval.")}`;
  }
  return "";
};

const getAgentDeepEvalRunApiUrl = () => `${getEvalServiceBaseUrl()}/run-agent-deepeval-evaluation`;
const getAgentGoldenCsvUploadApiUrl = () => `${getEvalServiceBaseUrl()}/upload-agent-golden-csv`;

const getAgentRuntimeBaseUrl = () => {
  // Temporary SaaS target for evaluation authentication testing.
  return "http://localhost:8000";
};

const buildAgentGoldenIndexName = (agent, username) => {
  const userPart = normalizeUsername(username || "agentflow_user") || "agentflow_user";
  const agentPart = removeSpecialCharacters(String(agent?.name || agent?.id || "agent")).toLowerCase() || "agent";
  return `agent_eval_golden_${userPart}_${agentPart}_${Date.now()}`;
};

const truncateText = (value, max = 80) => {
  if (!value) return "";
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
};

const parseEmailRecipients = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { emails: [], invalid: [] };
  const tokens = raw
    .split(/[,\n;]/g)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set();
  const emails = [];
  const invalid = [];
  // pragmatic email check (good enough for UI validation)
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  tokens.forEach((token) => {
    if (seen.has(token.toLowerCase())) return;
    seen.add(token.toLowerCase());
    if (emailRe.test(token)) emails.push(token);
    else invalid.push(token);
  });
  return { emails, invalid };
};

const normalizeEmailRecipientsForApi = (value) => {
  const { emails } = parseEmailRecipients(value);
  // API expects comma-separated
  return emails.join(",");
};

const normalizeSelectedMetrics = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((entry) => {
            if (!entry) return null;
            if (typeof entry === "object") {
              return normalizeMetricKey(entry.name || entry.metric || entry.id);
            }
            return normalizeMetricKey(entry);
          })
          .filter((metricId) => metricId && DEEPEVAL_METRIC_IDS.has(metricId))
      )
    );
  }
  if (!value) return [];
  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(",")
          .map((entry) => normalizeMetricKey(entry))
          .filter((metricId) => metricId && DEEPEVAL_METRIC_IDS.has(metricId))
      )
    );
  }
  if (typeof value === "object") {
    return Array.from(
      new Set(
        Object.entries(value)
          .filter(([, enabled]) => Boolean(enabled))
          .map(([key]) => normalizeMetricKey(key))
          .filter((metricId) => metricId && DEEPEVAL_METRIC_IDS.has(metricId))
      )
    );
  }
  return [];
};

const normalizeUsername = (username) =>
  String(username || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .trim();

// NOTE: We intentionally keep the index dropdown minimal: show only the full index name.

const buildScheduledEvalTarget = ({
  evaluationType,
  selectedMetrics = [],
  metricThresholds = {},
  overallThresholdValue,
  evalTopK,
  evalInputMode,
  evalIndexName,
  evalCsvFilename,
  testScenario,
  testInputs,
  expectedOutput,
  excludeContains,
  emailToNotify,
  evalUsername,
  deepevalModel,
  deepevalFramework,
  ragTestModel,
  ragTestFramework,
  goldenModel,
  goldenFramework,
  agentId,
  agentName,
  agentGoldenIndexName,
  agentOutputIndexName,
}) => {
  if (evaluationType === "agent") {
    const goldenIndex = String(agentGoldenIndexName || evalIndexName || "agent_eval_golden").trim();
    return {
      eval_target_url: getAgentDeepEvalRunApiUrl(),
      eval_target_method: "POST",
      eval_target_content_type: "application/json",
      eval_target_params: {
        base_url: getAgentRuntimeBaseUrl(),
        username: String(evalUsername || "").trim() || "agentflow_user",
        agent_id: agentId || null,
        agent_name: agentName || null,
        opensearch_golden_index: goldenIndex || "agent_eval_golden",
        output_opensearch_index: String(agentOutputIndexName || "agent_eval_output").trim(),
        deepeval_metrics_framework: deepevalFramework || "sglang",
        deepeval_metrics_model: deepevalModel || "finance-broker",
      },
      eval_target_input_mode: "index_name",
    };
  }
  if (!String(evaluationType || "").startsWith("rag_")) return null;
  const evalApiUrl = getEvalRunApiUrl();
  const ragMetrics = buildRagMetricsPayload(selectedMetrics, metricThresholds || {});
  const questionValue = String(testScenario || testInputs || "").trim();
  const expectedValue = String(expectedOutput || "").trim();
  const excludeContainsValue = String(excludeContains || "").trim();
  const usernameValue = String(evalUsername || "").trim() || "agentflow_user";
  const emailValue = normalizeEmailRecipientsForApi(emailToNotify);
  const safeOverallThreshold = Number.isFinite(Number(overallThresholdValue))
    ? Number(overallThresholdValue)
    : 0.8;
  const safeTopK = Number.isFinite(Number(evalTopK)) ? Number(evalTopK) : 50;

  const payload = {
    email_to_notify: emailValue,
    deepeval_metrics_model: deepevalModel || null,
    deepeval_metrics_framework: deepevalFramework || null,
    model_under_test: ragTestModel || null,
    model_under_test_framework: ragTestFramework || null,
    username: usernameValue,
    rag_metrics: ragMetrics,
    overall_threshold_value: safeOverallThreshold,
    top_k: safeTopK,
  };

  if (evalInputMode === "question" && !expectedValue && goldenModel && goldenFramework) {
    payload.golden_truth_model = goldenModel;
    payload.golden_truth_framework = goldenFramework;
  }

  if ((evalInputMode === "index_name" || evalInputMode === "csv_upload") && evalIndexName) {
    payload.eval_index_name = ensureUserPrefixedIndexName(evalIndexName, usernameValue);
  }

  if (evalInputMode === "csv_upload" && evalCsvFilename) {
    payload.eval_csv_filename = String(evalCsvFilename).trim();
  }

  if (evalInputMode === "question") {
    payload.question = questionValue;
    if (expectedValue) {
      payload.expected_output = expectedValue;
    }
  }

  if (excludeContainsValue) {
    payload.excludeContains = excludeContainsValue;
  }

  return {
    eval_target_url: evalApiUrl,
    eval_target_method: "POST",
    eval_target_content_type: evalInputMode === "csv_upload" ? "multipart/form-data" : "application/json",
    eval_target_params: payload,
    eval_target_input_mode: evalInputMode || null,
  };
};

const buildScheduleTargetSummary = (evaluation) => {
  const scheduleConfig = evaluation?.schedule_config || {};
  const url = scheduleConfig.eval_target_url;
  if (!url) return null;
  const params = scheduleConfig.eval_target_params || {};
  const parts = [];
  if (params.overall_threshold_value !== undefined) {
    const threshold = Number(params.overall_threshold_value);
    if (Number.isFinite(threshold)) parts.push(`Threshold: ${threshold.toFixed(2)}`);
  }
  if (params.top_k !== undefined) {
    const topK = Number(params.top_k);
    if (Number.isFinite(topK)) parts.push(`Top K: ${Math.round(topK)}`);
  }
  if (params.question) parts.push(`Q: ${truncateText(params.question, 60)}`);
  if (params.excludeContains || params.exclude_contains) {
    parts.push(`Exclude: ${truncateText(params.excludeContains || params.exclude_contains, 60)}`);
  }
  return { url, details: parts.join(" · ") };
};

const buildScheduledEvalTargetFromEvaluation = (evaluation) => {
  if (!evaluation) return null;
  const evalApi = evaluation?.eval_api_response && typeof evaluation.eval_api_response === "object"
    ? evaluation.eval_api_response
    : null;
  const scheduleParams =
    evaluation?.schedule_config?.eval_target_params &&
    typeof evaluation.schedule_config.eval_target_params === "object"
      ? evaluation.schedule_config.eval_target_params
      : {};
  const selectedMetrics = normalizeSelectedMetrics(
    scheduleParams.rag_metrics ?? evaluation?.selected_metrics ?? evaluation?.selectedMetrics
  );
  const thresholdsFromScheduleMetrics = Array.isArray(scheduleParams.rag_metrics)
    ? scheduleParams.rag_metrics.reduce((acc, metric) => {
        const metricId = normalizeMetricKey(metric?.name || metric?.metric || metric?.id);
        const threshold = Number(metric?.threshold);
        if (metricId && DEEPEVAL_METRIC_IDS.has(metricId) && Number.isFinite(threshold)) {
          acc[metricId] = threshold;
        }
        return acc;
      }, {})
    : {};
  const metricThresholds = {
    ...(evaluation?.metric_thresholds ?? {}),
    ...thresholdsFromScheduleMetrics,
  };
  const overallThresholdValue = scheduleParams.overall_threshold_value ?? evaluation?.overall_threshold_value ?? 0.8;
  const evalTopK = Number(
    scheduleParams.top_k ??
      evaluation?.top_k ??
      evaluation?.eval_top_k ??
      evalApi?.top_k ??
      evalApi?.eval_top_k ??
      50
  );
  const evalInputMode =
    evaluation?.schedule_config?.eval_target_input_mode ||
    evaluation?.eval_input_mode ||
    evalApi?.eval_input_mode ||
    "";
  const evalIndexName = resolveEvaluationValue(evaluation, [
    "schedule_config.eval_target_params.eval_index_name",
    "schedule_config.eval_target_params.opensearch_golden_index",
    "eval_index_name",
    "eval_api_response.eval_index_name",
    "eval_api_response.opensearch_golden_index",
    "eval_api_response.index_name",
    "eval_api_response.eval_index",
    "eval_api_response.dataset",
    "eval_api_response.dataset_name",
  ]);
  const outputIndexName = resolveEvaluationValue(evaluation, [
    "schedule_config.eval_target_params.output_opensearch_index",
    "output_opensearch_index",
    "eval_api_response.output_opensearch_index",
  ]);
  const evalCsvFilename =
    scheduleParams.eval_csv_filename ||
    evaluation?.eval_csv_filename ||
    evalApi?.eval_csv_filename ||
    evalApi?.csv_filename ||
    "";
  const emailToNotify =
    scheduleParams.email_to_notify ||
    evaluation?.email_to_notify ||
    evalApi?.email_to_notify ||
    "";
  const evalUsername =
    scheduleParams.username ||
    evaluation?.eval_username ||
    evalApi?.eval_username ||
    evalApi?.username ||
    "";
  const deepevalModel =
    scheduleParams.deepeval_metrics_model ||
    evaluation?.deepeval_metrics_model ||
    evalApi?.deepeval_metrics_model ||
    evaluation?.selected_model ||
    null;
  const deepevalFramework =
    scheduleParams.deepeval_metrics_framework ||
    evaluation?.deepeval_metrics_framework ||
    evalApi?.deepeval_metrics_framework ||
    evaluation?.selected_framework ||
    null;
  const ragTestModel =
    scheduleParams.model_under_test ||
    evaluation?.model_under_test ||
    evalApi?.model_under_test ||
    evaluation?.selected_model ||
    null;
  const ragTestFramework =
    scheduleParams.model_under_test_framework ||
    evaluation?.model_under_test_framework ||
    evalApi?.model_under_test_framework ||
    evaluation?.selected_framework ||
    null;
  const goldenModel =
    scheduleParams.golden_truth_model ||
    evaluation?.golden_truth_model ||
    evalApi?.golden_truth_model ||
    null;
  const goldenFramework =
    scheduleParams.golden_truth_framework ||
    evaluation?.golden_truth_framework ||
    evalApi?.golden_truth_framework ||
    null;
  const testScenario = evaluation?.test_scenario || scheduleParams.question || "";
  const testInputs = evaluation?.test_inputs || scheduleParams.question || "";
  const expectedOutput = evaluation?.expected_output || scheduleParams.expected_output || "";
  const excludeContains = scheduleParams.excludeContains || scheduleParams.exclude_contains || "";

  return buildScheduledEvalTarget({
    evaluationType: evaluation?.evaluation_type,
    selectedMetrics,
    metricThresholds,
    overallThresholdValue,
    evalTopK,
    evalInputMode,
    evalIndexName,
    evalCsvFilename,
    testScenario,
    testInputs,
    expectedOutput,
    excludeContains,
    emailToNotify,
    evalUsername,
    deepevalModel,
    deepevalFramework,
    ragTestModel,
    ragTestFramework,
    goldenModel,
    goldenFramework,
    agentId: evaluation?.item_id,
    agentName: evaluation?.item_name,
    agentGoldenIndexName: evalIndexName || "agent_eval_golden",
    agentOutputIndexName: outputIndexName || "agent_eval_output",
  });
};

const buildRagMetricsPayload = (selectedMetrics = [], metricThresholds = {}) => {
  const remapName = (metricId) => {
    if (metricId === "bias") return "bias_detection";
    if (metricId === "toxicity") return "toxicity_detection";
    return metricId;
  };

  const normalizedMetrics = normalizeSelectedMetrics(selectedMetrics);
  return normalizedMetrics.map((metricId) => ({
    name: remapName(metricId),
    threshold: metricThresholds?.[metricId],
  }));
};

const extractMetricsFromEvalApiResponse = (responseJson) => {
  if (!responseJson || typeof responseJson !== "object") {
    return { deepevalMetrics: {}, overallScore: 0, passed: false, raw: responseJson };
  }
  if (isEvalResponseInProgress(responseJson)) {
    return { deepevalMetrics: {}, overallScore: 0, passed: false, raw: responseJson };
  }

  const deepevalMetrics = extractMetricDetailsFromResponse(responseJson);
  const scores = Object.values(deepevalMetrics)
    .map((m) => Number(m?.score))
    .filter((n) => Number.isFinite(n));
  const overallScore =
    Number(responseJson.overall_score ?? responseJson.overallScore) ||
    (scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0);
  const passed = Boolean(responseJson.passed ?? responseJson.success ?? false);
  return {
    deepevalMetrics,
    overallScore,
    passed,
    raw: responseJson,
  };
};

const deriveUsernameFromEmail = (email) => {
  if (!email) {
    return "";
  }
  return String(email)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
};

const ensureUserPrefixedIndexName = (indexName, userKey) => {
  const raw = String(indexName || "").trim();
  if (!raw) return "";
  const prefix = removeSpecialCharacters(String(userKey || "")) || "";
  if (!prefix) return raw;
  const lower = raw.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  if (lower.startsWith(`${prefixLower}_`) || lower.startsWith(`${prefixLower}-`)) return raw;
  return `${prefix}_${raw}`;
};

const buildGroundTruthIndexName = (username, filename) => {
  const cleanUser = removeSpecialCharacters(String(username || ""));
  const baseName = String(filename || "").replace(/\.[^/.]+$/, "");
  const cleanBase = removeSpecialCharacters(baseName);
  const safeUser = cleanUser || "agentflow_user";
  const safeBase = cleanBase || "dataset";
  return `${safeUser}_${safeBase}_ground_truth.csv`;
};

const buildGroundTruthCsvBaseName = (filename) => {
  const baseName = String(filename || "").replace(/\.[^/.]+$/, "");
  const safeBase = removeSpecialCharacters(baseName) || "dataset";
  // Backend will prefix user_email_id; keep filename free of user prefix to avoid double-prefix.
  return `${safeBase}_ground_truth.csv`;
};

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1"]);

const isLocalhostHostname = (hostname = "") => LOCALHOST_HOSTS.has(String(hostname || "").toLowerCase());

const extractTimestampFromEvalRunId = (evalRunId) => {
  const raw = String(evalRunId || "").trim();
  if (!raw) return 0;
  const match = raw.match(/(\d{14})/);
  if (!match) return 0;
  const value = match[1];
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }
  const date = new Date(year, month - 1, day, hour, minute, second);
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const normalizeDownloadUrls = (downloadUrls) => {
  if (!downloadUrls) return null;
  if (Array.isArray(downloadUrls)) {
    const mapped = {};
    downloadUrls.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const kind = String(entry.kind || entry.type || entry.name || "").toLowerCase();
      const url = String(entry.url || entry.download_url || entry.downloadUrl || "").trim();
      if (!url) return;
      if (kind.includes("eval")) mapped.eval_csv = mapped.eval_csv || url;
      else if (kind.includes("rag")) mapped.rag_csv = mapped.rag_csv || url;
      else if (kind.includes("ground")) mapped.ground_truth_csv = mapped.ground_truth_csv || url;
    });
    return Object.keys(mapped).length ? mapped : null;
  }
  if (typeof downloadUrls !== "object") return null;

  const getFirst = (keys = []) => {
    for (const key of keys) {
      const value = downloadUrls?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  const evalCsv =
    getFirst(["eval_csv", "evalCsv", "evaluation_csv", "evaluationCsv", "eval_csv_url", "evalUrl", "eval_url"]) ||
    getFirst(["eval", "evaluation"]);
  const ragCsv =
    getFirst(["rag_csv", "ragCsv", "rag_csv_url", "ragUrl", "rag_url"]) ||
    getFirst(["rag"]);
  const groundTruthCsv =
    getFirst(["ground_truth_csv", "groundTruthCsv", "ground_truth", "groundTruth"]) ||
    "";

  const normalized = {
    ...(evalCsv ? { eval_csv: evalCsv } : {}),
    ...(ragCsv ? { rag_csv: ragCsv } : {}),
    ...(groundTruthCsv ? { ground_truth_csv: groundTruthCsv } : {}),
  };

  // Preserve any other keys for forward compatibility.
  Object.entries(downloadUrls).forEach(([key, value]) => {
    if (normalized[key] !== undefined) return;
    if (typeof value === "string" && value.trim()) {
      normalized[key] = value.trim();
    }
  });

  return Object.keys(normalized).length ? normalized : null;
};

const resolveUrl = (url) => {
  if (!url) return "";
  try {
    if (typeof window !== "undefined") {
      const { protocol, host } = window.location;
      
      const evalHost = host.replace(/^agentflow/, "eval");
      // Force HTTPS if not on localhost
      const useProtocol = (host.includes("localhost") || host.includes("127.0.0.1")) 
        ? protocol 
        : "https:";
        
      const evalBase = `${useProtocol}//${evalHost}`;
      
      const parsed = new URL(url, evalBase);

      // If the backend returned a localhost URL while we're on a non-localhost UI,
      // rewrite it to the current eval host so downloads work for real users.
      if (!isLocalhostHostname(window.location.hostname) && isLocalhostHostname(parsed.hostname)) {
        parsed.protocol = useProtocol;
        parsed.host = evalHost;
      }

      let finalUrl = parsed.toString();
      
      // Safety check: force https on the final string if not localhost
      if (!host.includes("localhost") && finalUrl.startsWith("http:")) {
        finalUrl = finalUrl.replace("http:", "https:");
      }
      
      return finalUrl;
    }
    return url;
  } catch {
    return url;
  }
};

const appendQueryParams = (url, params = {}) => {
  if (!url) return "";
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const parsed = new URL(url, base);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        parsed.searchParams.set(key, String(value));
      }
    });
    return parsed.toString();
  } catch {
    return url;
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientEvalStatus = (statusCode, body) => {
  // Some backends return a temporary 404/400 while the status document is still being created.
  if (![400, 404].includes(Number(statusCode))) return false;
  try {
    const text =
      typeof body === "string"
        ? body
        : body && typeof body === "object"
          ? JSON.stringify(body)
          : "";
    const normalized = String(text || "").toLowerCase();
    return (
      normalized.includes("document_missing_exception") ||
      normalized.includes("document missing") ||
      normalized.includes("not found") && normalized.includes("document")
    );
  } catch {
    return false;
  }
};

const updateEvaluationCache = (queryClient, evaluationId, patch) => {
  if (!queryClient) return;
  queryClient.setQueryData(['evaluations'], (current) => {
    if (!Array.isArray(current)) return current;
    return current.map((entry) => (entry.id === evaluationId ? { ...entry, ...patch } : entry));
  });
};

const formatPercentage = (value) => {
  if (value === undefined || value === null) return null;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return numericValue <= 1 ? `${(numericValue * 100).toFixed(1)}%` : `${numericValue.toFixed(1)}%`;
};

const buildReasoningFetchUrl = (evaluation) => {
  if (!evaluation) return "";
  const resolvedResultsUrl = resolveUrl(evaluation.eval_results_url || evaluation.results_url);
  if (resolvedResultsUrl) {
    return appendQueryParams(resolvedResultsUrl, { include_reasoning: true });
  }
  const statusUrl = resolveUrl(evaluation.eval_status_url || evaluation.status_url);
  if (statusUrl) {
    return appendQueryParams(statusUrl, { include_records: true, include_reasoning: true });
  }
  const evalId = evaluation?.eval_api_response?.evaluation_id || evaluation?.eval_api_response?.id;
  if (evalId) {
    const fallbackUrl = resolveUrl(`/evaluation-results/${evalId}`);
    return appendQueryParams(fallbackUrl, { include_reasoning: true });
  }
  return "";
};

const resolveEvaluationValue = (evaluation, paths = []) => {
  if (!evaluation) return null;
  for (const path of paths) {
    const segments = path.split(".");
    let current = evaluation;
    let found = true;
    for (const segment of segments) {
      if (!current || typeof current !== "object") {
        found = false;
        break;
      }
      current = current[segment];
      if (current === undefined) {
        found = false;
        break;
      }
    }
    if (found && current !== undefined && current !== null && current !== "") {
      return current;
    }
  }
  return null;
};

const formatEvaluationDate = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Avoid browser Date fallbacks that turn time-only/status-ish values into
    // misleading calendar dates.
    if (!/\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|[A-Za-z]{3,}\s+\d{1,2}.*\d{4}/.test(trimmed)) {
      return null;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return null;
  return format(date, "MMM d, h:mm a");
};

const resolveModelUnderTest = (evaluation) =>
  resolveEvaluationValue(evaluation, [
    "model_under_test",
    "eval_api_response.model_under_test",
    "selected_model",
  ]);

const extractEvaluationOutputPreview = (resultJson) => {
  if (!resultJson) return null;
  if (typeof resultJson === "string") {
    return resultJson;
  }

  const extractValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
      return value.trim() || null;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((entry) => {
          if (entry === undefined || entry === null) return null;
          if (typeof entry === "string") return entry.trim() || null;
          if (typeof entry === "object") return JSON.stringify(entry, null, 2);
          return String(entry).trim();
        })
        .filter(Boolean);
      return parts.length ? parts.join("\n") : null;
    }
    if (typeof value === "object") {
      return JSON.stringify(value, null, 2);
    }
    return String(value).trim() || null;
  };

  const candidates = [
    resultJson.output,
    resultJson.answer,
    resultJson.text,
    resultJson.result,
    resultJson.message,
    resultJson.detail,
    resultJson.error,
    resultJson.reason,
    resultJson.failure_reason,
    resultJson.fail_reason,
    resultJson.traceback,
    resultJson.stack,
    resultJson.stacktrace,
    resultJson.logs,
    resultJson.log,
    resultJson.status,
  ];

  for (const candidate of candidates) {
    const extracted = extractValue(candidate);
    if (extracted) return extracted;
  }

  if (Array.isArray(resultJson.results) && resultJson.results.length > 0) {
    const snippets = resultJson.results
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "string") return entry.trim();
        const nestedCandidates = [
          entry.output,
          entry.response,
          entry.summary,
          entry.text,
          entry.message,
          entry.detail,
          entry.error,
        ];
        for (const nested of nestedCandidates) {
          const nestedExtracted = extractValue(nested);
          if (nestedExtracted) return nestedExtracted;
        }
        return JSON.stringify(entry, null, 2);
      })
      .filter(Boolean);
    if (snippets.length) {
      return snippets.join("\n\n---\n\n");
    }
  }

  return null;
};

const STATUS_POLL_BASE_INTERVAL_MS = 5000; // increased from 3000ms
const STATUS_POLL_MAX_INTERVAL_MS = 240_000;
const STATUS_POLL_MAX_ATTEMPTS = 500_000_000;

const hasEvalResultPayload = (body) => {
  if (!body || typeof body !== "object") return false;
  if (isEvalResponseInProgress(body)) return false;
  const downloadUrls = body?.download_urls || body?.downloadUrls || body?.downloads || null;
  if (downloadUrls) {
    const normalized = normalizeDownloadUrls(downloadUrls);
    if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) return true;
  }
  if (body?.summary?.avg_scores && Object.keys(body.summary.avg_scores).length) return true;
  const extracted = extractMetricsFromEvalApiResponse(body);
  return Boolean(extracted?.deepevalMetrics && Object.keys(extracted.deepevalMetrics).length);
};

const fetchEvaluationStatusOnce = async (statusUrl) => {
  if (!statusUrl) throw new Error("Missing status_url for evaluation polling.");
  
  const resolvedUrl = resolveUrl(statusUrl);
  
  // Fetch without credentials, no need to check domain anymore
  const statusResp = await fetch(resolvedUrl);
  const text = await statusResp.text().catch(() => "");
  let body = null;
  if (text && text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  
  return { status: statusResp.status, body, resolvedUrl };
};

const finalizeEvaluationRecord = async ({
  evaluationId,
  resultJson,
  statusCode,
  latestStatusUrl,
  thresholds,
  metrics,
  queryClient,
  onEvaluationUpdate,
  overallThresholdValue,
  preservedMetadata = {},
}) => {
  const allowedMetricIds = new Set(
    Array.isArray(metrics)
      ? metrics
          .map((metricId) => normalizeMetricKey(metricId))
          .filter((metricId) => metricId && DEEPEVAL_METRIC_IDS.has(metricId))
      : []
  );

  const extracted = extractMetricsFromEvalApiResponse(resultJson);
  const deepevalScores = extracted.deepevalMetrics || {};
  const scores = Object.values(deepevalScores)
    .map((m) => Number(m?.score))
    .filter((n) => Number.isFinite(n));
  const overallScore =
    Number(resultJson?.overall_average_score ?? extracted.overallScore) ||
    (scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0);
  let { combinedScore } = computeQualityRiskScores(deepevalScores);
  let effectiveOverallScore = Number.isFinite(combinedScore) ? combinedScore : overallScore;

  const allPassed = Object.entries(deepevalScores).every(([metricId, result]) => {
    if (!result) return false;
    const metric = DEEPEVAL_METRICS.find((m) => m.id === metricId);
    const score = Number(result.score);
    const threshold = Number(result.threshold);
    const effectiveThreshold = Number.isFinite(threshold)
      ? threshold
      : (thresholds?.[metricId] ?? metric?.threshold);
    if (!Number.isFinite(score) || !Number.isFinite(effectiveThreshold)) return false;
    if (metric?.inverse) return score <= effectiveThreshold;
    return score >= effectiveThreshold;
  });

  const overallStatusNormalized = String(resultJson?.overall_status || resultJson?.status || "").toLowerCase();
  const hasPassStatus = overallStatusNormalized === "pass";
  const hasFailStatus = ["fail", "failed", "error"].includes(overallStatusNormalized);
  const isErrorStatus = statusCode >= 400;
  const hasMetrics = Object.keys(deepevalScores).length > 0;
  const computedAvgScores = computeAvgScoresFromEvalResultJson(resultJson, allowedMetricIds);
  const mergedSummary = (() => {
    const existing = resultJson?.summary && typeof resultJson.summary === "object" ? resultJson.summary : null;
    if (!existing && !computedAvgScores) return null;
    const existingAvg =
      existing?.avg_scores && typeof existing.avg_scores === "object" ? existing.avg_scores : {};
    return {
      ...(existing || {}),
      avg_scores: {
        ...existingAvg,
        ...(computedAvgScores || {}),
      },
      ...(computedAvgScores ? { avg_scores_source: "computed_from_results" } : {}),
    };
  })();
  if (mergedSummary?.avg_scores && typeof mergedSummary.avg_scores === "object") {
    const summaryMetricDetails = {};
    Object.entries(mergedSummary.avg_scores).forEach(([metricKey, value]) => {
      const metricId = normalizeMetricKey(metricKey);
      const numeric = Number(value);
      if (!metricId || !DEEPEVAL_METRIC_IDS.has(metricId)) return;
      if (!Number.isFinite(numeric)) return;
      summaryMetricDetails[metricId] = { score: numeric };
    });
    const { combinedScore: combinedFromSummary } = computeQualityRiskScores(summaryMetricDetails);
    if (Number.isFinite(combinedFromSummary)) {
      combinedScore = combinedFromSummary;
      effectiveOverallScore = combinedFromSummary;
    }
  }
  const hasSummaryAvg = Boolean(
    mergedSummary?.avg_scores && typeof mergedSummary.avg_scores === "object" && Object.keys(mergedSummary.avg_scores).length
  );
  const hasResults = hasMetrics || hasSummaryAvg;
  const thresholdValue = Number(overallThresholdValue);
  const passedByThreshold =
    hasResults &&
    Number.isFinite(effectiveOverallScore) &&
    Number.isFinite(thresholdValue) &&
    effectiveOverallScore >= thresholdValue;
  // Source of truth: we treat pass/fail as our threshold comparison (combined score),
  // falling back to per-metric thresholds when needed. Provider "FAIL" can reflect
  // different logic (e.g., all metrics must pass) and should not override this.
  const resolvedPassed = !isErrorStatus && (hasPassStatus || passedByThreshold || (hasResults && allPassed));
  const resolvedStatus = resolvedPassed ? "completed" : "failed";
  const messageFallback =
    extracted.raw && Object.keys(extracted.raw).length
      ? JSON.stringify(extracted.raw, null, 2)
      : JSON.stringify(resultJson ?? {}, null, 2);
  const responseMessage = resultJson?.message || resultJson?.detail || resultJson?.error || messageFallback;
  const outputPreview = extractEvaluationOutputPreview(resultJson);
  const statusOnly =
    typeof outputPreview === "string" &&
    ["failed", "error", "fail", "completed", "success", "passed"].includes(
      outputPreview.trim().toLowerCase()
    );
  const actualOutputText =
    statusOnly && responseMessage && responseMessage !== outputPreview
      ? responseMessage
      : outputPreview || responseMessage;

  const metadataPatch = Object.entries(preservedMetadata || {}).reduce((acc, [key, value]) => {
    if (value !== undefined && value !== null) {
      acc[key] = value;
    }
    return acc;
  }, {});
  const updatePayload = {
    ...metadataPatch,
    // Status should reflect technical success vs failure; provider "FAIL" is not necessarily a transport failure.
    status: isErrorStatus || (hasFailStatus && !hasResults) ? "failed" : "completed",
    actual_output: actualOutputText,
    deepeval_metrics: deepevalScores,
    // Store combined score so existing UI (charts, etc.) can use a single field.
    overall_score: effectiveOverallScore,
    passed: resolvedPassed,
    completed_at: new Date().toISOString(),
    eval_api_response: extracted.raw ?? resultJson,
    eval_status_url: latestStatusUrl || null,
    eval_results_url: resultJson?.results_url || null,
    eval_download_urls: !isErrorStatus ? normalizeDownloadUrls(resultJson?.download_urls ?? null) : null,
    // Back-compat fields: older UIs / schemas may persist these names.
    status_url: latestStatusUrl || null,
    results_url: resultJson?.results_url || null,
    download_urls: !isErrorStatus ? normalizeDownloadUrls(resultJson?.download_urls ?? null) : null,
    summary: mergedSummary,
    eval_overall_status: resultJson?.overall_status || resultJson?.status || null,
    eval_overall_average_score: resultJson?.overall_average_score ?? null,
    eval_pass_rate: resultJson?.pass_rate ?? null,
    eval_fail_rate: resultJson?.fail_rate ?? null,
    eval_summary: mergedSummary,
    eval_results_found: hasResults,
    eval_metrics_passed: resolvedPassed,
    overall_threshold_value:
      Number.isFinite(overallThresholdValue) && overallThresholdValue !== null
        ? overallThresholdValue
        : Number(
            resultJson?.overall_threshold_value ??
              resultJson?.overallThresholdValue ??
              resultJson?.threshold ??
              0.8
          ),
  };

  const patch = {
    ...metadataPatch,
    status: updatePayload.status,
    actual_output: updatePayload.actual_output,
    deepeval_metrics: updatePayload.deepeval_metrics,
    overall_score: updatePayload.overall_score,
    passed: updatePayload.passed,
    completed_at: updatePayload.completed_at,
    eval_api_response: updatePayload.eval_api_response,
    eval_status_url: updatePayload.eval_status_url,
    eval_results_url: updatePayload.eval_results_url,
    eval_download_urls: updatePayload.eval_download_urls,
    status_url: updatePayload.status_url,
    results_url: updatePayload.results_url,
    download_urls: updatePayload.download_urls,
    summary: updatePayload.summary,
    eval_overall_status: updatePayload.eval_overall_status,
    eval_overall_average_score: updatePayload.eval_overall_average_score,
    eval_pass_rate: updatePayload.eval_pass_rate,
    eval_fail_rate: updatePayload.eval_fail_rate,
    eval_summary: updatePayload.eval_summary,
    eval_results_found: updatePayload.eval_results_found,
    eval_metrics_passed: updatePayload.eval_metrics_passed,
    overall_threshold_value: updatePayload.overall_threshold_value,
  };
  updateEvaluationCache(queryClient, evaluationId, updatePayload);
  try {
    await base44.entities.Evaluation.update(evaluationId, updatePayload);
  } catch (updateError) {
    console.error("Failed updating evaluation record:", updateError);
  }
  await queryClient.invalidateQueries({ queryKey: ['evaluations'] });
  if (onEvaluationUpdate) {
    onEvaluationUpdate(evaluationId, patch);
  }
  return updatePayload.passed;
};

const finalizeAgentEvaluationRecord = async ({
  evaluationId,
  resultJson,
  queryClient,
  onEvaluationUpdate,
  preservedMetadata = {},
  fallback = {},
}) => {
  const compactResponse = compactAgentEvalResponse(resultJson, fallback);
  const summary = compactResponse.summary || {};
  const averageScore = Number(summary.average_metric_score);
  const passRate = Number(summary.deepeval_pass_rate);
  const successRate = Number(summary.overall_success_rate);
  const totalCases = Number(summary.total_cases);
  const ingestedAtUnix = Number(compactResponse.ingested_at_unix);
  const completedAt = Number.isFinite(ingestedAtUnix)
    ? new Date(ingestedAtUnix * 1000).toISOString()
    : new Date().toISOString();
  const passed =
    Number.isFinite(passRate)
      ? passRate >= 1
      : Number.isFinite(successRate)
        ? successRate >= 1
        : true;

  const metadataPatch = Object.entries(preservedMetadata || {}).reduce((acc, [key, value]) => {
    if (value !== undefined && value !== null) acc[key] = value;
    return acc;
  }, {});
  const updatePayload = {
    ...metadataPatch,
    status: "completed",
    passed,
    actual_output: `Agent DeepEval completed. ${Number.isFinite(totalCases) ? `${totalCases} case(s). ` : ""}Average score ${formatMetricScore(averageScore)}.`,
    deepeval_metrics: {},
    overall_score: Number.isFinite(averageScore) ? averageScore : null,
    completed_at: completedAt,
    eval_api_response: compactResponse,
    eval_summary: summary,
    summary,
    eval_overall_status: passed ? "pass" : "fail",
    eval_overall_average_score: Number.isFinite(averageScore) ? averageScore : null,
    eval_pass_rate: Number.isFinite(passRate) ? passRate : null,
    eval_fail_rate: Number.isFinite(passRate) ? 1 - passRate : null,
    eval_results_found: true,
    eval_metrics_passed: passed,
    eval_run_id: compactResponse.run_id || fallback.run_id || null,
    output_opensearch_index:
      compactResponse.output_opensearch_index || fallback.output_opensearch_index || "agent_eval_output",
    deepeval_metrics_model:
      compactResponse.deepeval_metrics_model || fallback.deepeval_metrics_model || null,
    deepeval_metrics_framework:
      compactResponse.deepeval_metrics_framework || fallback.deepeval_metrics_framework || null,
  };

  updateEvaluationCache(queryClient, evaluationId, updatePayload);
  try {
    await base44.entities.Evaluation.update(evaluationId, updatePayload);
  } catch (updateError) {
    console.error("Failed updating agent evaluation summary:", updateError);
  }
  await queryClient.invalidateQueries({ queryKey: ['evaluations'] });
  await queryClient.invalidateQueries({ queryKey: ["agent-deepeval-output"] });
  if (onEvaluationUpdate) {
    onEvaluationUpdate(evaluationId, updatePayload);
  }
  return updatePayload.passed;
};

const pollAndFinalizeEvaluation = async ({
  evaluationId,
  statusUrl,
  thresholds,
  metrics,
  queryClient,
  onEvaluationUpdate,
  overallThresholdValue,
  preservedMetadata = {},
}) => {
  if (!statusUrl) {
    console.warn("No status_url provided for polling evaluation status.");
    return;
  }
  let currentUrl = statusUrl;
  let lastStatusUrl = statusUrl;
  let intervalMs = STATUS_POLL_BASE_INTERVAL_MS;
  for (let attempt = 0; attempt < STATUS_POLL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { status, body, resolvedUrl } = await fetchEvaluationStatusOnce(currentUrl);
      const nextStatusUrl = body?.status_url || body?.statusUrl || resolvedUrl;
      if (nextStatusUrl) {
        lastStatusUrl = nextStatusUrl;
      }
      if (status === 202) {
        await delay(intervalMs);
        intervalMs = Math.min(STATUS_POLL_MAX_INTERVAL_MS, intervalMs * 2);
        continue;
      }
      if (isTransientEvalStatus(status, body)) {
        await delay(intervalMs);
        intervalMs = Math.min(STATUS_POLL_MAX_INTERVAL_MS, intervalMs * 2);
        continue;
      }
      if (isEvalResponseInProgress(body) && !hasEvalResultPayload(body)) {
        await delay(intervalMs);
        intervalMs = Math.min(STATUS_POLL_MAX_INTERVAL_MS, intervalMs * 2);
        continue;
      }

      const resultsUrl =
        body?.results_url ||
        body?.resultsUrl ||
        body?.eval_results_url ||
        body?.evalResultsUrl ||
        null;
      if (resultsUrl && currentUrl !== resultsUrl && !hasEvalResultPayload(body)) {
        currentUrl = resultsUrl;
        continue;
      }
      await finalizeEvaluationRecord({
        evaluationId,
        resultJson: body,
        statusCode: status,
        latestStatusUrl: lastStatusUrl,
        thresholds,
        metrics,
        queryClient,
        onEvaluationUpdate,
        overallThresholdValue,
        preservedMetadata,
      });
      return;
    } catch (error) {
      console.error("Error polling evaluation status:", error);
    }
    await delay(intervalMs);
  }
  console.warn("Stopped polling evaluation status after max attempts; job may still be processing.");
};

export default function EvaluationPanel({ tools, agents, workflows }) {
  // States to manage the evaluation form fields in the EvaluationDialog
  const [testScenario, setTestScenario] = useState("");
  const [testInputs, setTestInputs] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");
  const [retrievalContext, setRetrievalContext] = useState("");
  const [selectedMetrics, setSelectedMetrics] = useState(['answer_relevancy', 'faithfulness', 'contextual_relevancy']);
  const [customCriteria, setCustomCriteria] = useState("");
  const [overallThresholdValue, setOverallThresholdValue] = useState(0.8);
  const [evalTopK, setEvalTopK] = useState(50);
  const [uploadedScenarios, setUploadedScenarios] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [emailToNotify, setEmailToNotify] = useState("");
  const [evalUsername, setEvalUsername] = useState("");
  const [evalIndexName, setEvalIndexName] = useState("");
  const [evalExcludeContains, setEvalExcludeContains] = useState("");
  const [evalIndexFilter, setEvalIndexFilter] = useState("");
  const [evalIndexPickerOpen, setEvalIndexPickerOpen] = useState(false);
  const [deepevalFramework, setDeepevalFramework] = useState("openai");
  const [deepevalModel, setDeepevalModel] = useState(FRAMEWORK_MODELS.openai[0]?.value || "");
  const [ragTestFramework, setRagTestFramework] = useState("openai");
  const [ragTestModel, setRagTestModel] = useState(FRAMEWORK_MODELS.openai[0]?.value || "");
  const [goldenFramework, setGoldenFramework] = useState("openai");
  const [goldenModel, setGoldenModel] = useState(FRAMEWORK_MODELS.openai[0]?.value || "");
  const [evalUseCsvUpload, setEvalUseCsvUpload] = useState(false);
  const [evalCsvFile, setEvalCsvFile] = useState(null);
  const [evalCsvUploading, setEvalCsvUploading] = useState(false);
  const [agentGoldenIndexName, setAgentGoldenIndexName] = useState("");
  const [agentUseCsvUpload, setAgentUseCsvUpload] = useState(false);
  const [agentCsvFile, setAgentCsvFile] = useState(null);
  const [agentCsvUploading, setAgentCsvUploading] = useState(false);
  const [agentCsvUploadError, setAgentCsvUploadError] = useState("");
  const [agentCsvUploaded, setAgentCsvUploaded] = useState(false);
  const [agentOutputIndexName, setAgentOutputIndexName] = useState("agent_eval_output");
  const [agentEvaluationMode, setAgentEvaluationMode] = useState("dataset");
  const [agentQuestions, setAgentQuestions] = useState(() => [newAgentGoldenQuestion()]);
  const [savedAgentQuestionIds, setSavedAgentQuestionIds] = useState([]);
  const updateAgentQuestion = (id, field, value) => setAgentQuestions((rows) =>
    rows.map((row) => row.question_id === id ? { ...row, [field]: value } : row)
  );
  const [agentSingleSaving, setAgentSingleSaving] = useState(false);
  const [agentSinglePrefillKey, setAgentSinglePrefillKey] = useState("");

  const parsedEmailRecipients = useMemo(
    () => parseEmailRecipients(emailToNotify),
    [emailToNotify]
  );
  const [evalCsvUploadError, setEvalCsvUploadError] = useState("");
  const [evalCsvUploaded, setEvalCsvUploaded] = useState(false);
  const [showModelSeries, setShowModelSeries] = useState(true);
  const [ragEvaluationMode, setRagEvaluationMode] = useState("dataset");
  const [openEvaluationSections, setOpenEvaluationSections] = useState([]);
  const [modelHistogramTimeframe, setModelHistogramTimeframe] = useState("30d");
  const [showEvalScoreHistogram, setShowEvalScoreHistogram] = useState(true);
  const [showResponseTimeHistogram, setShowResponseTimeHistogram] = useState(true);
	  const [activeHistogramTimeframe, setActiveHistogramTimeframe] = useState("30d");
	  const [timeHistogramTimeframe, setTimeHistogramTimeframe] = useState("30d");
	  const [selectedHistogramMetrics, setSelectedHistogramMetrics] = useState([]);
	  const [localEvaluationState, setLocalEvaluationState] = useState({});
	  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
	  const [detailsModalEvaluationId, setDetailsModalEvaluationId] = useState(null);
	  const [selectedMetricId, setSelectedMetricId] = useState(null);
	  const [reasoningByEvaluationId, setReasoningByEvaluationId] = useState({});
	  const [reasoningLoadingByEvaluationId, setReasoningLoadingByEvaluationId] = useState({});
	  const [reasoningRawByEvaluationId, setReasoningRawByEvaluationId] = useState({});
	  const reasoningFetchAttemptedRef = useRef(new Set());
	  const openDetailsModal = useCallback((evaluation) => {
	    if (!evaluation) return;
	    setDetailsModalEvaluationId(evaluation.id || null);
	    setSelectedMetricId(null);
	    setDetailsModalOpen(true);
	  }, []);

	  const handleLocalEvaluationUpdate = useCallback((evaluationId, patch = {}) => {
    if (!evaluationId) return;
    setLocalEvaluationState((prev) => ({
      ...prev,
      [evaluationId]: {
        ...prev[evaluationId],
        ...patch,
        id: evaluationId,
      },
    }));
  }, []);
  const handleLocalEvaluationRemove = useCallback((evaluationId) => {
    if (!evaluationId) return;
    setLocalEvaluationState((prev) => {
      if (!(evaluationId in prev)) return prev;
      const next = { ...prev };
      delete next[evaluationId];
      return next;
    });
  }, []);

  // States for dialog visibility and items being processed
  const [showEvaluationDialog, setShowEvaluationDialog] = useState(false);
  const [evaluationToRun, setEvaluationToRun] = useState(null); // Stores { type, item } when "Run Evaluation" is clicked
  const [scheduleConfigEditMode, setScheduleConfigEditMode] = useState(false);

  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [evaluationToSchedule, setEvaluationToSchedule] = useState(null); // The evaluation object being scheduled
  const [scheduleConfigSource, setScheduleConfigSource] = useState(null);
  const [showScheduleSnapshotDetails, setShowScheduleSnapshotDetails] = useState(false);
  const [showScheduleConfigDetails, setShowScheduleConfigDetails] = useState(false);
  const defaultMetricThresholds = useMemo(
    () =>
      DEEPEVAL_METRICS.reduce((acc, metric) => {
        acc[metric.id] = metric.threshold;
        return acc;
      }, {}),
    []
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [evaluationToDelete, setEvaluationToDelete] = useState(null);

  const [activeTab, setActiveTab] = useState("agents"); // Initial active tab for the main Tabs component
  const [resultsRange, setResultsRange] = useState("30d"); // 'recent' | '30d'
  const [resultsSubTab, setResultsSubTab] = useState("graphs"); // 'graphs' | 'table'
  const [resultsKind, setResultsKind] = useState("rag"); // 'rag' | 'agent'
  const [selectedAgentVisualKey, setSelectedAgentVisualKey] = useState("");
  const [agentVisualSearch, setAgentVisualSearch] = useState("");
  const [agentListSearch, setAgentListSearch] = useState("");

  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => base44.auth.me(),
    initialData: null,
  });
  const { data: modelConfigs = [] } = useQuery({
    queryKey: ["systemConfigs-model-settings"],
    queryFn: () => base44.entities.SystemConfig.filter({ category: "model_settings" }),
    initialData: [],
  });
  const userFramework = modelConfigs.find((c) => c.key === `user_framework_${currentUser?.email}`)?.value || "openai";
  const availableModels = getAvailableModelsForFramework(userFramework, modelConfigs, currentUser?.email);
  React.useEffect(() => {
    const derivedUsername = deriveUsernameFromEmail(currentUser?.email);
    if (derivedUsername && derivedUsername !== evalUsername) {
      setEvalUsername(derivedUsername);
    }
  }, [
    currentUser?.email,
    evalUsername,
  ]);

  const getFrameworkModelOptions = (frameworkId) =>
    getAvailableModelsForFramework(frameworkId === "ollama" ? "privateai" : frameworkId, modelConfigs, currentUser?.email);
  const [metricThresholds, setMetricThresholds] = useState(
    DEEPEVAL_METRICS.reduce((acc, metric) => {
      acc[metric.id] = metric.threshold;
      return acc;
    }, {})
  );

  const { data: evaluations } = useQuery({
    queryKey: ['evaluations'],
    queryFn: () => base44.entities.Evaluation.list('-created_date'),
    initialData: [],
  });

  const {
    data: agentEvalResultsByAgent = {},
    isFetching: isFetchingAgentEvalResults,
  } = useQuery({
    queryKey: [
      "agent-deepeval-output",
      Array.isArray(agents) ? agents.map((agent) => agent?.id || agent?.name).filter(Boolean).join("|") : "",
    ],
    enabled: ["agents", "results"].includes(activeTab) && Array.isArray(agents) && agents.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        agents.map(async (agent) => {
          const key = agent?.id || agent?.name;
          if (!key) return null;
          try {
            const result = await fetchAgentDeepEvalResults(agent);
            return [key, result];
          } catch (error) {
            console.warn("Failed to fetch agent eval output:", key, error);
            return [key, { status: "error", message: error?.message || "Failed to load agent eval output" }];
          }
        })
      );
      return Object.fromEntries(entries.filter(Boolean));
    },
    initialData: {},
    staleTime: 30 * 1000,
    refetchInterval: ["agents", "results"].includes(activeTab) ? 30 * 1000 : false,
  });

  const agentGoldenIndexForPrefill = String(agentGoldenIndexName || "agent_eval_golden").trim();
  const {
    data: agentGoldenCasePayload = null,
    isFetching: isFetchingAgentGoldenCase,
  } = useQuery({
    queryKey: [
      "agent-golden-case",
      evaluationToRun?.item?.id || "",
      evaluationToRun?.item?.name || "",
      agentGoldenIndexForPrefill,
    ],
    enabled:
      showEvaluationDialog &&
      evaluationToRun?.type === "agent" &&
      agentEvaluationMode === "question" &&
      Boolean(evaluationToRun?.item?.id || evaluationToRun?.item?.name),
    queryFn: () => fetchAgentGoldenCase(evaluationToRun.item, agentGoldenIndexForPrefill),
    initialData: null,
    staleTime: 15 * 1000,
  });

  React.useEffect(() => {
    if (
      !showEvaluationDialog ||
      evaluationToRun?.type !== "agent" ||
      agentEvaluationMode !== "question"
    ) {
      return;
    }
    if (!agentGoldenCasePayload) return;
    const nextPrefillKey = `${evaluationToRun?.item?.id || evaluationToRun?.item?.name || ""}:${agentGoldenIndexForPrefill}`;
    if (agentSinglePrefillKey === nextPrefillKey) return;
    const rows = agentGoldenCasePayload.rows || (agentGoldenCasePayload.row ? [agentGoldenCasePayload.row] : []);
    setAgentQuestions(rows.length ? rows.map((row) => ({ ...row, question_id: row.question_id || crypto.randomUUID() })) : [newAgentGoldenQuestion()]);
    setSavedAgentQuestionIds(rows.map((row) => row.question_id));
    setAgentSinglePrefillKey(nextPrefillKey);
  }, [
    agentEvaluationMode,
    agentGoldenCasePayload,
    agentGoldenIndexForPrefill,
    agentSinglePrefillKey,
    evaluationToRun?.item?.id,
    evaluationToRun?.item?.name,
    evaluationToRun?.type,
    showEvaluationDialog,
  ]);

	  const mergedEvaluations = useMemo(() => {
	    const map = new Map();
	    evaluations.forEach((evaluation) => {
	      if (!evaluation?.id) return;
      map.set(evaluation.id, evaluation);
    });
    Object.entries(localEvaluationState).forEach(([id, override]) => {
      if (!id) return;
      const base = map.get(id) || { id };
      map.set(id, {
        ...base,
        ...override,
      });
	    });
	    return Array.from(map.values());
	  }, [evaluations, localEvaluationState]);

  const agentOutputEvaluations = useMemo(() => {
    if (!Array.isArray(agents) || !agents.length) return [];
    return agents
      .map((agent) => {
        const key = agent?.id || agent?.name;
        const result = key ? agentEvalResultsByAgent[key] : null;
        if (!result || result.status === "error") return null;
        return buildAgentEvaluationGroupFromOutput(agent, result);
      })
      .filter(Boolean);
  }, [agents, agentEvalResultsByAgent]);

  const agentCaseEvaluations = useMemo(() => {
    if (!Array.isArray(agents) || !agents.length) return [];
    return agents.flatMap((agent) => {
      const key = agent?.id || agent?.name;
      const result = key ? agentEvalResultsByAgent[key] : null;
      if (!result || result.status === "error") return [];
      return getAgentEvalResultCases(result)
        .map((item, index) => normalizeAgentEvalCaseToEvaluation(agent, result, item, index))
        .filter(Boolean);
    });
  }, [agents, agentEvalResultsByAgent]);

  const filteredAgents = useMemo(() => {
    const rows = Array.isArray(agents) ? agents : [];
    const query = String(agentListSearch || "").trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((agent) => {
      const searchable = [
        agent?.name,
        agent?.description,
        agent?.id,
        agent?.agent_id,
        agent?.username,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [agents, agentListSearch]);

	  const detailsModalEvaluation = useMemo(() => {
	    if (!detailsModalEvaluationId) return null;
	    return (
        mergedEvaluations.find((evaluation) => evaluation.id === detailsModalEvaluationId) ||
        agentOutputEvaluations.find((evaluation) => evaluation.id === detailsModalEvaluationId) ||
        agentCaseEvaluations.find((evaluation) => evaluation.id === detailsModalEvaluationId) ||
        null
      );
	  }, [agentCaseEvaluations, agentOutputEvaluations, detailsModalEvaluationId, mergedEvaluations]);

	  useEffect(() => {
	    if (!detailsModalOpen || !detailsModalEvaluation) return;
	    const metricDetails = getEvaluationMetricDetails(detailsModalEvaluation);
	    const remoteMetricDetails = reasoningByEvaluationId[detailsModalEvaluation.id] || null;
	    if (remoteMetricDetails) {
	      Object.entries(remoteMetricDetails).forEach(([metricId, result]) => {
	        mergeMetricResult(metricDetails, metricId, result);
	      });
	    }
	    const orderedIds = [
	      ...DEEPEVAL_METRICS.map((m) => m.id),
	      ...Object.keys(metricDetails).filter((id) => !DEEPEVAL_METRICS.some((m) => m.id === id)),
	    ];
	    const firstId = Array.from(new Set(orderedIds)).find((id) => metricDetails[id]);
	    setSelectedMetricId((prev) => (prev && metricDetails[prev] ? prev : firstId || null));
	  }, [detailsModalOpen, detailsModalEvaluation, reasoningByEvaluationId]);

	  const runningEvaluationPollsRef = React.useRef(new Map());
  const failedRecoveryPollAttemptedRef = React.useRef(new Set());
  const refreshDownloadMutation = useMutation({
    mutationFn: async (evaluation) => {
      if (!evaluation?.id) throw new Error("Missing evaluation id.");
      const statusUrl = evaluation?.eval_status_url || evaluation?.status_url;
      const resultsUrl = evaluation?.eval_results_url;
      const candidateUrls = [statusUrl, resultsUrl].filter((u) => typeof u === "string" && u.trim());
      if (!candidateUrls.length) throw new Error("No status/results URL available to refresh downloads.");

      const fetchJson = async (url) => {
        const resp = await fetch(resolveUrl(url));
        const text = await resp.text().catch(() => "");
        let json = null;
        if (text && text.trim()) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }
        return { ok: resp.ok, status: resp.status, json };
      };

      let lastJson = null;
      let bestJson = null;
      for (const url of candidateUrls) {
        const { status, json } = await fetchJson(url);
        lastJson = json;
        if (status === 202) continue;
        if (!json || typeof json !== "object") continue;
        const downloadUrls = json?.download_urls || json?.downloadUrls || json?.downloads || null;
        const normalizedDownloads = normalizeDownloadUrls(downloadUrls);
        if (normalizedDownloads && typeof normalizedDownloads === "object" && !Array.isArray(normalizedDownloads)) {
          bestJson = json;
          break;
        }
        if (!bestJson) bestJson = json;
      }

      const selectedJson = bestJson || lastJson || null;
      const nextResultsUrl =
        selectedJson?.results_url || selectedJson?.resultsUrl || selectedJson?.eval_results_url || null;
      const nextStatusUrl = selectedJson?.status_url || selectedJson?.statusUrl || null;

      let downloadUrls =
        selectedJson?.download_urls ||
        selectedJson?.downloadUrls ||
        selectedJson?.downloads ||
        null;

      if ((!downloadUrls || typeof downloadUrls !== "object" || Array.isArray(downloadUrls)) && nextResultsUrl) {
        const { status, json } = await fetchJson(nextResultsUrl);
        if (status !== 202 && json && typeof json === "object") {
          downloadUrls = json?.download_urls || json?.downloadUrls || json?.downloads || null;
        }
      }

      downloadUrls = normalizeDownloadUrls(downloadUrls);
      if (!downloadUrls || typeof downloadUrls !== "object" || Array.isArray(downloadUrls)) {
        throw new Error("Eval results are not ready yet (download URLs not returned).");
      }

      await base44.entities.Evaluation.update(evaluation.id, {
        eval_download_urls: downloadUrls,
        ...(nextResultsUrl ? { eval_results_url: nextResultsUrl } : {}),
        ...(nextStatusUrl ? { eval_status_url: nextStatusUrl } : {}),
      });
      return true;
    },
    onSuccess: () => {
      toast.success("Download links refreshed");
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error) => {
      toast.error(error?.message || "Unable to refresh download links");
    },
  });
  const deleteEvaluationMutation = useMutation({
    mutationFn: async (evaluationId) => {
      if (!evaluationId) throw new Error("Missing evaluation ID for deletion.");
      return base44.entities.Evaluation.delete(evaluationId);
    },
    onSuccess: (_, evaluationId) => {
      handleLocalEvaluationRemove(evaluationId);
      runningEvaluationPollsRef.current.delete(evaluationId);
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
    },
    onError: (error) => {
      console.error("Failed deleting evaluation:", error);
    },
  });
  const handleConfirmDelete = async () => {
    if (!evaluationToDelete) return;
    try {
      // Best-effort unschedule first so the backend scheduler stops triggering future runs.
      // (Some schedulers don't automatically cancel on record delete.)
      if (evaluationToDelete?.schedule_config) {
        await base44.entities.Evaluation.update(evaluationToDelete.id, {
          schedule_config: null,
          status: "completed",
        }).catch(() => {});
      }
      await deleteEvaluationMutation.mutateAsync(evaluationToDelete.id);
      setShowDeleteDialog(false);
      setEvaluationToDelete(null);
    } catch (error) {
      console.error("Delete request failed:", error);
      alert(`Unable to delete evaluation: ${error?.message || "Unknown error"}`);
    }
  };
  React.useEffect(() => {
    const runningEvalsWithStatus = mergedEvaluations.filter((evaluation) => {
      const normalizedStatus = String(evaluation?.status || "").toLowerCase();
      const isRunning = isEvaluationRecordInProgress(evaluation);
      const statusUrl = evaluation?.eval_status_url || evaluation?.status_url;
      const resultsUrl = evaluation?.eval_results_url;
      const hasResults =
        Boolean(evaluation?.eval_results_found) ||
        (evaluation?.deepeval_metrics && Object.keys(evaluation.deepeval_metrics).length > 0) ||
        (evaluation?.eval_summary?.avg_scores &&
          Object.keys(evaluation.eval_summary.avg_scores).length > 0);
      const missingDownloads =
        !evaluation?.eval_download_urls ||
        (typeof evaluation.eval_download_urls === "object" &&
          Object.keys(evaluation.eval_download_urls).length === 0);
      return (
        evaluation?.id &&
        (isRunning ||
          // Recovery: if we previously marked failed but no results are stored yet,
          // keep polling the status_url since the backend can be eventually-consistent.
          (normalizedStatus === "failed" && (!hasResults || missingDownloads)) ||
          // Sometimes backends mark the job completed before the result document is hydrated.
          (normalizedStatus === "completed" && (!hasResults || missingDownloads))) &&
        typeof (statusUrl || resultsUrl) === "string" &&
        String(statusUrl || resultsUrl).trim()
      );
    });
    runningEvalsWithStatus.forEach((evaluation) => {
      const statusUrl = evaluation?.eval_status_url || evaluation?.status_url || evaluation?.eval_results_url;
      const normalizedStatus = String(evaluation?.status || "").toLowerCase();
      const isRunning = isEvaluationRecordInProgress(evaluation);
      const hasResults =
        Boolean(evaluation?.eval_results_found) ||
        (evaluation?.deepeval_metrics && Object.keys(evaluation.deepeval_metrics).length > 0) ||
        (evaluation?.eval_summary?.avg_scores &&
          Object.keys(evaluation.eval_summary.avg_scores).length > 0);
      const missingDownloads =
        !evaluation?.eval_download_urls ||
        (typeof evaluation.eval_download_urls === "object" &&
          Object.keys(evaluation.eval_download_urls).length === 0);
      if (normalizedStatus === "failed" && (!hasResults || missingDownloads)) {
        if (failedRecoveryPollAttemptedRef.current.has(evaluation.id)) {
          return;
        }
        failedRecoveryPollAttemptedRef.current.add(evaluation.id);
      }
      const existingUrl = runningEvaluationPollsRef.current.get(evaluation.id);
      if (existingUrl && existingUrl === statusUrl) {
        return;
      }
      runningEvaluationPollsRef.current.set(evaluation.id, statusUrl);
      pollAndFinalizeEvaluation({
        evaluationId: evaluation.id,
        statusUrl,
        thresholds: evaluation?.metric_thresholds,
        metrics: evaluation?.selected_metrics ?? evaluation?.selectedMetrics,
        queryClient,
        onEvaluationUpdate: handleLocalEvaluationUpdate,
        overallThresholdValue: evaluation?.overall_threshold_value ?? 0.8,
        preservedMetadata: {
          started_at: evaluation?.started_at ?? evaluation?.created_date,
          executed_by: evaluation?.executed_by,
        },
      })
        .catch((error) => {
          console.error("Background evaluation polling failed:", error);
        })
        .finally(() => {
          runningEvaluationPollsRef.current.delete(evaluation.id);
        });
    });
  }, [mergedEvaluations, queryClient, handleLocalEvaluationUpdate]);

  // Fetch RAG specific entities
  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => base44.entities.DataSource.list(),
      //base44.entities.DataSource.list('-created_date'),
    initialData: [],
  });

  const { data: knowledgeGraphs = [] } = useQuery({
    queryKey: ['knowledgeGraphs'],
    queryFn: () => base44.entities.KnowledgeGraph.list('-created_date'),
    initialData: [],
  });

  const { data: openSearchIndices = [], isFetching: isFetchingOpenSearchIndices } = useQuery({
    queryKey: ['openSearchIndices'],
    queryFn: () => base44.entities.OpenSearchIndex.list('-created_date'),
    initialData: [],
  });

  const cleanUserForIndexPrefix = useMemo(() => {
    const fromCurrentUser = normalizeUsername(currentUser?.email || "");
    const fromEvalUsername = normalizeUsername(evalUsername || "");
    return fromCurrentUser || fromEvalUsername || "";
  }, [currentUser?.email, evalUsername]);

  const shouldPrepareGroundTruthIndices =
    Boolean(cleanUserForIndexPrefix) &&
    Boolean(evaluationToRun?.type?.startsWith("rag_")) &&
    showEvaluationDialog &&
    ragEvaluationMode === "dataset" &&
    !evalUseCsvUpload;

  const { data: openSearchConnections = [], isFetching: isFetchingOpenSearchConnections } = useQuery({
    queryKey: ["openSearchConnections"],
    queryFn: () => base44.entities.OpenSearchConnection.list(),
    initialData: [],
    enabled: shouldPrepareGroundTruthIndices,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const openSearchConnectionIds = useMemo(
    () =>
      (Array.isArray(openSearchConnections) ? openSearchConnections : [])
        .map((connection) => connection?.id)
        .filter(Boolean),
    [openSearchConnections]
  );

  const { data: fetchedGroundTruthIndices = [], isFetching: isFetchingGroundTruthIndices } = useQuery({
    queryKey: ["groundTruthIndices", cleanUserForIndexPrefix, openSearchConnectionIds.join("|")],
    enabled:
      shouldPrepareGroundTruthIndices &&
      openSearchConnectionIds.length > 0,
    queryFn: async () => {
      const email = cleanUserForIndexPrefix;

      const results = await Promise.all(
        openSearchConnectionIds.map(async (connectionId) => {
          try {
            const resp = await fetch(`/opensearchconnections/fetch_indexes/${connectionId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              // backend expects the normalized email as the raw JSON body (string), matching OpenSearchPanel.jsx
              body: JSON.stringify(email),
            });
            if (!resp.ok) return [];
            const data = await resp.json().catch(() => null);
            const indexes = Array.isArray(data?.indexes) ? data.indexes : [];
            return indexes
              .map((name) => String(name || "").trim())
              .filter(Boolean)
              .filter((name) => name.toLowerCase().includes("ground_truth"));
          } catch (e) {
            console.warn("Failed fetching OpenSearch indexes for connection", connectionId, e);
            return [];
          }
        })
      );

      const flattened = results.flat();
      return Array.from(new Set(flattened)).sort((a, b) => a.localeCompare(b));
    },
    initialData: [],
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const groundTruthIndexOptions = useMemo(() => {
    const cleanUser =
      removeSpecialCharacters(String(currentUser?.email || "")) ||
      removeSpecialCharacters(String(evalUsername || "")) ||
      "";

    const fromEntities = (Array.isArray(openSearchIndices) ? openSearchIndices : [])
      .map((idx) =>
        String(
          idx?.index_name ||
            idx?._source?.index_name ||
            idx?.data?.index_name ||
            idx?._source?.data?.index_name ||
            ""
        ).trim()
      )
      .filter(Boolean)
      .filter((name) => name.toLowerCase().includes("ground_truth"));

    const fromConnections = (Array.isArray(fetchedGroundTruthIndices) ? fetchedGroundTruthIndices : [])
      .map((name) => String(name || "").trim())
      .filter(Boolean);

    const names = [...fromEntities, ...fromConnections];

    const userFiltered = cleanUser
      ? names.filter((name) => name.toLowerCase().includes(cleanUser.toLowerCase()))
      : names;

    const final = userFiltered.length ? userFiltered : names;
    return Array.from(new Set(final)).sort((a, b) => a.localeCompare(b));
  }, [openSearchIndices, fetchedGroundTruthIndices, currentUser?.email, evalUsername]);

  const applyEvalIndexName = useCallback(
    (value) => {
      const next = String(value || "");
      setEvalIndexName(next);
    },
    []
  );

  const filteredGroundTruthIndexOptions = useMemo(() => {
    const q = String(evalIndexFilter || "").trim().toLowerCase();
    if (!q) return groundTruthIndexOptions;
    return groundTruthIndexOptions.filter((name) => name.toLowerCase().includes(q));
  }, [groundTruthIndexOptions, evalIndexFilter]);

  const isLoadingGroundTruthOptions =
    shouldPrepareGroundTruthIndices &&
    filteredGroundTruthIndexOptions.length === 0 &&
    (isFetchingOpenSearchIndices || isFetchingOpenSearchConnections || isFetchingGroundTruthIndices);

  React.useEffect(() => {
    if (selectedModel) return;
    if (!availableModels.length) {
      setSelectedModel("");
      return;
    }
    const userPreferredModel = modelConfigs.find((c) => c.key === `user_model_${currentUser?.email}`)?.value;
    const validValues = availableModels.map((m) => m.value);
    if (selectedModel && validValues.includes(selectedModel)) return;
    if (userPreferredModel && validValues.includes(userPreferredModel)) {
      setSelectedModel(userPreferredModel);
      return;
    }
    setSelectedModel(availableModels[0].value);
  }, [availableModels, currentUser?.email, modelConfigs, selectedModel]);


  const runEvaluationMutation = useMutation({
    mutationFn: async ({ type, item, scenario, inputs, expected, context, metrics, criteria, model, thresholds, agentGoldenIndexOverride }) => {
      const user = await base44.auth.me();
      const evalRunId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const effectiveEvalUsername =
        String(evalUsername || "").trim() ||
        deriveUsernameFromEmail(user?.email) ||
        "agentflow_user";
      const baseEvalIndexName = evalUseCsvUpload
        ? (evalCsvFile?.name || evalIndexName)
        : evalIndexName;
      const evalIndexNameWithUser = ensureUserPrefixedIndexName(baseEvalIndexName, effectiveEvalUsername);
      const isRagRun = String(type || "").startsWith("rag_");
      const ragInputMode = ragEvaluationMode === "question" ? "question" : (evalUseCsvUpload ? "csv_upload" : "index_name");
      const effectiveEvalIndexName = isRagRun && ragInputMode === "question" ? "" : evalIndexNameWithUser;
      const effectiveAgentGoldenIndexName = String(agentGoldenIndexOverride || agentGoldenIndexName || "").trim();

      // Create a pending evaluation record first
      const newEvaluation = await base44.entities.Evaluation.create({
        evaluation_type: type,
        item_id: item.id,
        item_name: item.name,
        test_scenario: scenario || (type.startsWith("rag_") ? `RAG Evaluation (${evalIndexName || "index"})` : ""),
        test_inputs: inputs,
        expected_output: expected,
        retrieval_context: isRagRun ? [] : (context ? context.split('\n').filter(c => c.trim()) : []),
        selected_metrics: metrics,
        selected_model: model || null,
        selected_framework: userFramework,
        metric_thresholds: thresholds || {},
        overall_threshold_value: overallThresholdValue,
        ...(type.startsWith("rag_")
          ? {
              eval_run_id: evalRunId,
              email_to_notify: normalizeEmailRecipientsForApi(emailToNotify),
              eval_username: effectiveEvalUsername,
              ...(effectiveEvalIndexName ? { eval_index_name: effectiveEvalIndexName } : {}),
              eval_api_url: getEvalRunApiUrl(),
              eval_input_mode: ragInputMode,
              top_k: Number.isFinite(Number(evalTopK)) ? Number(evalTopK) : 50,
              ...(ragInputMode === "csv_upload" && evalCsvFile?.name ? { eval_csv_filename: evalCsvFile.name } : {}),
            }
          : {}),
        ...(type === "agent"
          ? {
              eval_run_id: evalRunId,
              eval_api_url: getAgentDeepEvalRunApiUrl(),
              eval_index_name: effectiveAgentGoldenIndexName,
              eval_input_mode: agentEvaluationMode === "question" ? "question" : (agentUseCsvUpload ? "csv_upload" : "index_name"),
              ...(agentCsvFile?.name ? { eval_csv_filename: agentCsvFile.name } : {}),
              output_opensearch_index: String(agentOutputIndexName || "").trim() || "agent_eval_output",
              deepeval_metrics_model: deepevalModel || "finance-broker",
              deepeval_metrics_framework: deepevalFramework || "sglang",
            }
          : {}),
        status: 'running',
        started_at: new Date().toISOString(),
        executed_by: user.email
      });

      handleLocalEvaluationUpdate(newEvaluation.id, {
        id: newEvaluation.id,
        evaluation_type: newEvaluation.evaluation_type,
        item_id: newEvaluation.item_id,
        item_name: newEvaluation.item_name,
        test_scenario: newEvaluation.test_scenario,
        started_at: newEvaluation.started_at,
        executed_by: newEvaluation.executed_by,
        status: 'running',
        passed: false,
        actual_output: "",
        deepeval_metrics: {},
        eval_results_found: false,
        eval_download_urls: null,
        eval_overall_status: null,
        eval_api_response: null,
        overall_threshold_value: overallThresholdValue,
      });

      let latestStatusUrl = null;

      try {
        let actualOutput = '';
        let deepevalScores = {};

        if (type === 'agent') {
          const goldenIndex = effectiveAgentGoldenIndexName;
          if (!goldenIndex) {
            throw new Error("Please provide an Agent Golden Index or upload a CSV first.");
          }
          const safeDeepevalFramework = deepevalFramework || "sglang";
          const safeDeepevalModel = deepevalModel || "finance-broker";
          const payload = {
            base_url: getAgentRuntimeBaseUrl(),
            username: user?.email || effectiveEvalUsername,
            agent_id: item.id,
            agent_name: item.name,
            opensearch_golden_index: goldenIndex,
            output_opensearch_index: String(agentOutputIndexName || "").trim() || "agent_eval_output",
            deepeval_metrics_framework: safeDeepevalFramework,
            deepeval_metrics_model: safeDeepevalModel,
            run_id: evalRunId,
          };
          const resp = await fetch(getAgentDeepEvalRunApiUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const responseJson = await resp.json().catch(() => null);
          if (!resp.ok || responseJson?.status === "error") {
            throw new Error(
              responseJson?.message ||
                responseJson?.detail ||
                responseJson?.error ||
                `Agent DeepEval API failed (HTTP ${resp.status})`
            );
          }
          const finalPassed = await finalizeAgentEvaluationRecord({
            evaluationId: newEvaluation.id,
            resultJson: responseJson,
            queryClient,
            onEvaluationUpdate: handleLocalEvaluationUpdate,
            preservedMetadata: {
              started_at: newEvaluation.started_at,
              executed_by: newEvaluation.executed_by,
              eval_api_url: getAgentDeepEvalRunApiUrl(),
              eval_index_name: goldenIndex,
              output_opensearch_index: payload.output_opensearch_index,
              deepeval_metrics_model: safeDeepevalModel,
              deepeval_metrics_framework: safeDeepevalFramework,
            },
            fallback: {
              run_id: evalRunId,
              agent_id: item.id,
              agent_name: item.name,
              username: user?.email || effectiveEvalUsername,
              output_opensearch_index: payload.output_opensearch_index,
              deepeval_metrics_model: safeDeepevalModel,
              deepeval_metrics_framework: safeDeepevalFramework,
            },
          });
          return { evaluation: newEvaluation, passed: finalPassed };
        } else if (type === 'tool') {
          actualOutput = `Tool "${item.name}" executed. Category: ${item.category}. Test completed.`;
        } else if (type === 'workflow') {
          actualOutput = `Workflow "${item.name}" executed with ${item.agent_steps?.length || 0} steps.`;
        } else if (type.startsWith('rag_')) {
          const evalApiUrl = getEvalRunApiUrl();
          const ragMetrics = buildRagMetricsPayload(metrics, thresholds || {});
          const questionValue = String(scenario || inputs || "").trim();
          const expectedValue = String(expected || "").trim();
          const safeDeepevalFramework = deepevalFramework || userFramework || "openai";
          const safeRagTestFramework = ragTestFramework || userFramework || "openai";
          const safeDeepevalModel = deepevalModel || selectedModel || "gpt-4.1";
          const safeRagTestModel = ragTestModel || selectedModel || "gpt-4.1";
          const safeGoldenFramework = goldenFramework || safeDeepevalFramework;
          const safeGoldenModel = goldenModel || safeDeepevalModel;
          const usernameValue = effectiveEvalUsername;
          const emailValue = normalizeEmailRecipientsForApi(emailToNotify);

        const payload = {
          eval_run_id: evalRunId,
          email_to_notify: emailValue,
          deepeval_metrics_model: safeDeepevalModel,
          deepeval_metrics_framework: safeDeepevalFramework,
          model_under_test: safeRagTestModel,
          model_under_test_framework: safeRagTestFramework,
          username: usernameValue,
          rag_metrics: ragMetrics,
          overall_threshold_value: overallThresholdValue,
          top_k: Number.isFinite(Number(evalTopK)) ? Number(evalTopK) : 50,
        };
        const excludeContainsValue = String(evalExcludeContains || "").trim();
        if (excludeContainsValue) {
          payload.excludeContains = excludeContainsValue;
        }
        const needsGoldenTruthForRun = ragInputMode === "question" && !expectedValue;
        if (needsGoldenTruthForRun && safeGoldenModel && safeGoldenFramework) {
            payload.golden_truth_model = safeGoldenModel;
            payload.golden_truth_framework = safeGoldenFramework;
          }

          if (ragInputMode !== "question" && effectiveEvalIndexName) {
            payload.eval_index_name = effectiveEvalIndexName;
          }

        if (ragInputMode === "question") {
          payload.question = questionValue;
          if (expectedValue) {
            payload.expected_output = expectedValue;
          }
        }

          const baseRequestInit = {
            method: "POST"          
          };

          const requestInit =
            evalUseCsvUpload && evalCsvFile && !evalCsvUploaded
              ? (() => {
                  const form = new FormData();
                  form.append("file", evalCsvFile, evalCsvFile.name);
                  for (const [key, value] of Object.entries(payload)) {
                    form.append(key, String(value ?? ""));
                  }
                  return { ...baseRequestInit, body: form };
                })()
              : {
                  ...baseRequestInit,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                };

          const resp = await fetch(evalApiUrl, requestInit);

          const parseResponseJson = async (response) => {
            try {
              const text = await response.text();
              if (!text || !text.trim()) return null;
              return JSON.parse(text);
            } catch {
              return null;
            }
          };

          const initialResponseJson = await parseResponseJson(resp);
          const statusCode = resp.status;
          const headerStatusUrl =
            resp.headers.get("x-status-url") ||
            resp.headers.get("X-Status-Url") ||
            resp.headers.get("location") ||
            resp.headers.get("Location");
          const fallbackStatusUrl = initialResponseJson?.evaluation_id
            ? `/evaluation-status/${initialResponseJson.evaluation_id}`
            : null;
          latestStatusUrl =
            initialResponseJson?.status_url ||
            initialResponseJson?.statusUrl ||
            headerStatusUrl ||
            fallbackStatusUrl ||
            null;
          const initialMessage = initialResponseJson?.message || "Evaluation submitted. Awaiting results...";

          const initialIsTransientError =
            statusCode >= 400 &&
            Boolean(latestStatusUrl) &&
            isTransientEvalStatus(statusCode, initialResponseJson);
          const initialIsInProgress =
            isEvalResponseInProgress(initialResponseJson) && !hasEvalResultPayload(initialResponseJson);

          await base44.entities.Evaluation.update(newEvaluation.id, {
            actual_output: initialMessage,
            eval_status_url: latestStatusUrl,
            eval_results_url: initialResponseJson?.results_url || null,
            // Back-compat fields: persist under common names too.
            status_url: latestStatusUrl,
            results_url: initialResponseJson?.results_url || null,
            download_urls: normalizeDownloadUrls(initialResponseJson?.download_urls || null),
            eval_api_response: initialResponseJson,
            eval_results_found: false,
            overall_threshold_value: overallThresholdValue,
          });
          await queryClient.invalidateQueries({ queryKey: ['evaluations'] });
          updateEvaluationCache(queryClient, newEvaluation.id, {
            status: 'running',
            actual_output: initialMessage,
            eval_status_url: latestStatusUrl,
            eval_results_url: initialResponseJson?.results_url || null,
            eval_download_urls: normalizeDownloadUrls(initialResponseJson?.download_urls || null),
            status_url: latestStatusUrl,
            results_url: initialResponseJson?.results_url || null,
            download_urls: normalizeDownloadUrls(initialResponseJson?.download_urls || null),
            eval_api_response: initialResponseJson,
            eval_results_found: false,
            overall_threshold_value: overallThresholdValue,
            started_at: newEvaluation.started_at,
            executed_by: newEvaluation.executed_by,
          });

          handleLocalEvaluationUpdate(newEvaluation.id, {
            actual_output: initialMessage,
            eval_status_url: latestStatusUrl,
            eval_results_url: initialResponseJson?.results_url || null,
            eval_download_urls: normalizeDownloadUrls(initialResponseJson?.download_urls || null),
            status_url: latestStatusUrl,
            results_url: initialResponseJson?.results_url || null,
            download_urls: normalizeDownloadUrls(initialResponseJson?.download_urls || null),
            eval_api_response: initialResponseJson,
            status: statusCode === 202 || initialIsTransientError || initialIsInProgress ? 'running' : statusCode >= 400 ? 'failed' : 'completed',
            eval_results_found: statusCode >= 200 && statusCode < 300 && statusCode !== 202 && hasEvalResultPayload(initialResponseJson),
            overall_threshold_value: overallThresholdValue,
            started_at: newEvaluation.started_at,
            executed_by: newEvaluation.executed_by,
          });

          if (initialIsInProgress) {
            pollAndFinalizeEvaluation({
              evaluationId: newEvaluation.id,
              statusUrl: latestStatusUrl,
              thresholds,
              metrics,
              queryClient,
              onEvaluationUpdate: handleLocalEvaluationUpdate,
              overallThresholdValue,
              preservedMetadata: {
                started_at: newEvaluation.started_at,
                executed_by: newEvaluation.executed_by,
              },
            }).catch((error) => {
              console.error("Background evaluation polling failed:", error);
            });
            return { evaluation: newEvaluation, passed: false };
          }

          if (statusCode >= 200 && statusCode < 300 && statusCode !== 202) {
            const finalPassed = await finalizeEvaluationRecord({
              evaluationId: newEvaluation.id,
              resultJson: initialResponseJson,
              statusCode,
              latestStatusUrl,
              thresholds,
              metrics,
              queryClient,
              onEvaluationUpdate: handleLocalEvaluationUpdate,
              overallThresholdValue,
              preservedMetadata: {
                started_at: newEvaluation.started_at,
                executed_by: newEvaluation.executed_by,
              },
            });
            return { evaluation: newEvaluation, passed: finalPassed };
          }

          if (statusCode === 202) {
            pollAndFinalizeEvaluation({
              evaluationId: newEvaluation.id,
              statusUrl: latestStatusUrl,
              thresholds,
              metrics,
              queryClient,
              onEvaluationUpdate: handleLocalEvaluationUpdate,
              overallThresholdValue,
              preservedMetadata: {
                started_at: newEvaluation.started_at,
                executed_by: newEvaluation.executed_by,
              },
            }).catch((error) => {
            console.error("Background evaluation polling failed:", error);
            });
            return { evaluation: newEvaluation, passed: false };
          }

          if (statusCode >= 400) {
            if (initialIsTransientError) {
              pollAndFinalizeEvaluation({
                evaluationId: newEvaluation.id,
                statusUrl: latestStatusUrl,
                thresholds,
                metrics,
                queryClient,
                onEvaluationUpdate: handleLocalEvaluationUpdate,
                overallThresholdValue,
                preservedMetadata: {
                  started_at: newEvaluation.started_at,
                  executed_by: newEvaluation.executed_by,
                },
              }).catch((error) => {
                console.error("Background evaluation polling failed:", error);
              });
              return { evaluation: newEvaluation, passed: false };
            }
            const errorMessage =
              initialResponseJson?.message ||
              initialResponseJson?.detail ||
              initialResponseJson?.error ||
              `Evaluation API failed (HTTP ${statusCode})`;
            await finalizeEvaluationRecord({
              evaluationId: newEvaluation.id,
              resultJson: initialResponseJson,
              statusCode,
              latestStatusUrl,
              thresholds,
              metrics,
              queryClient,
              onEvaluationUpdate: handleLocalEvaluationUpdate,
              overallThresholdValue,
              preservedMetadata: {
                started_at: newEvaluation.started_at,
                executed_by: newEvaluation.executed_by,
              },
            });
            throw new Error(errorMessage);
          }

          return { evaluation: newEvaluation, passed: false };
        }


        // Evaluate metrics using LLM calls
        for (const metricId of metrics) {
          const metric = DEEPEVAL_METRICS.find(m => m.id === metricId);
          if (!metric) continue;

          let evaluationPrompt = '';
          
          if (metricId === 'g_eval') {
            // Custom LLM as Judge evaluation
            evaluationPrompt = `You are an expert evaluator. Evaluate the following AI response based on these custom criteria:

Criteria: ${criteria || 'Overall quality, accuracy, and usefulness'}

Input/Question: ${inputs}
${expected ? `Expected Output: ${expected}` : ''}
Actual Output: ${actualOutput}
${context ? `Context: ${context}` : ''}

Evaluate this response on a scale of 0.0 to 1.0 where:
- 1.0 = Perfectly meets all criteria
- 0.8-0.9 = Excellent, minor improvements possible
- 0.6-0.7 = Good, meets most criteria
- 0.4-0.5 = Acceptable, significant improvements needed
- 0.0-0.3 = Poor, fails to meet criteria

Provide a detailed evaluation explaining your score.

Return JSON with:
{
  "score": <number between 0 and 1>,
  "reason": "<detailed explanation of your evaluation>"
}`;
          } else {
            // Standard DeepEval metrics
            evaluationPrompt = `Evaluate the following using DeepEval ${metric.name} metric:

Input/Question: ${inputs}
Expected Output: ${expected || 'N/A'}
Actual Output: ${actualOutput}
${context ? `Context: ${context}` : ''}

Score this on a scale of 0.0 to 1.0 where:
- 1.0 = Perfect ${metric.name}
- 0.0 = Complete failure

Return JSON with:
{
  "score": <number between 0 and 1>,
  "reason": "<detailed explanation>"
}`;
          }

          try {
            const evalResponse = await base44.integrations.Core.InvokeLLM({
              model: model || undefined,
              prompt: evaluationPrompt,
              response_json_schema: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  reason: { type: "string" }
                }
              }
            });

            const metricResult = {
              score: evalResponse.score || 0,
              reason: evalResponse.reason || '',
              threshold: thresholds?.[metricId] ?? metric.threshold
            };
            
            if (metricId === 'g_eval') {
              metricResult.criteria = criteria || 'Overall quality, accuracy, and usefulness';
            }
            
            deepevalScores[metricId] = metricResult;
          } catch (error) {
            console.error(`Error evaluating metric ${metricId}:`, error);
            deepevalScores[metricId] = {
              score: 0,
              reason: `Error evaluating: ${error.message || 'Unknown error'}`,
              threshold: thresholds?.[metricId] ?? metric.threshold
            };
          }
        }

        const scores = Object.values(deepevalScores).map(m => m.score);
        const overallScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

        const allPassed = Object.entries(deepevalScores).every(([metricId, result]) => {
          const metric = DEEPEVAL_METRICS.find(m => m.id === metricId);
          // If metric is not found or result is missing, default to not passed for safety
          if (!metric || !result) return false;
          if (metric.inverse) {
            return result.score <= result.threshold;
          }
          return result.score >= result.threshold;
        });

        // Update the evaluation record with results
        await base44.entities.Evaluation.update(newEvaluation.id, {
          status: 'completed',
          actual_output: actualOutput,
          deepeval_metrics: deepevalScores,
          overall_score: overallScore,
          passed: allPassed,
          completed_at: new Date().toISOString()
        });

        return { evaluation: newEvaluation, passed: allPassed };

      } catch (error) {
        console.error("Evaluation execution failed:", error);
        await base44.entities.Evaluation.update(newEvaluation.id, {
          status: 'failed',
          actual_output: `Error: ${error.message || 'Unknown error'}`,
          passed: false,
          completed_at: new Date().toISOString(),
          eval_api_response: {},
          eval_status_url: latestStatusUrl,
          status_url: latestStatusUrl,
        });
        await queryClient.invalidateQueries({ queryKey: ['evaluations'] });
        handleLocalEvaluationUpdate(newEvaluation.id, {
          status: 'failed',
          actual_output: `Error: ${error.message || 'Unknown error'}`,
          passed: false,
        });
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
      // Reset form fields after successful run
      setTestScenario("");
      setTestInputs("");
      setExpectedOutput("");
      setRetrievalContext("");
      setCustomCriteria("");
      setSelectedMetrics(['answer_relevancy', 'faithfulness', 'contextual_relevancy']); // Reset to default
      setOverallThresholdValue(0.8);
      setShowEvaluationDialog(false); // Close the dialog
      setEvaluationToRun(null);
    },
    onError: (error) => {
        console.error("Failed to run evaluation:", error);
        alert("Failed to run evaluation: " + error.message);
    }
  });

  const updateEvaluationScheduleMutation = useMutation({
    mutationFn: ({ id, scheduleConfig }) =>
      base44.entities.Evaluation.update(id, {
        // When disabling, clear schedule_config entirely so the backend doesn't keep triggering
        // based on cron_expression/eval_target fields that may still be present.
        schedule_config: scheduleConfig && scheduleConfig.enabled ? scheduleConfig : null,
        status: scheduleConfig && scheduleConfig.enabled ? 'scheduled' : 'completed' // Update status based on schedule enabled state
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['evaluations'] });
      setShowScheduleDialog(false);
      setEvaluationToSchedule(null);
    },
    onError: (error) => {
        console.error("Failed to update schedule:", error);
        alert("Failed to update schedule: " + error.message);
    }
  });

  const saveScheduleConfigMutation = useMutation({
    mutationFn: async () => {
      const user = await base44.auth.me();
      const effectiveEvalUsername =
        String(evalUsername || "").trim() ||
        deriveUsernameFromEmail(user?.email) ||
        "agentflow_user";
      const scheduleConfig = scheduleConfigSource?.schedule_config || null;
      const baseScheduleConfig = scheduleConfig || {};
      const scheduleEnabled = Boolean(scheduleConfig?.enabled);
      const type = evaluationToRun?.type;
      const item = evaluationToRun?.item;
      if (!type || !item) {
        throw new Error("Missing evaluation target for scheduled config.");
      }
      if (String(type).startsWith("rag_")) {
        const { emails, invalid } = parseEmailRecipients(emailToNotify);
        if (!emails.length) {
          throw new Error("Please enter at least one valid email recipient before scheduling this evaluation.");
        }
        if (invalid.length) {
          throw new Error(`These email(s) look invalid: ${invalid.join(", ")}`);
        }
      }
      if (type === "agent" && agentEvaluationMode === "question") {
        await uploadAgentGoldenSingleQuestion(agentGoldenIndexForPrefill);
      }
      const evalRunId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();
      const baseEvalIndexName = evalUseCsvUpload
        ? (evalCsvFile?.name || evalIndexName)
        : evalIndexName;
      const evalIndexNameWithUser = ensureUserPrefixedIndexName(baseEvalIndexName, effectiveEvalUsername);
      const scheduleTarget = buildScheduledEvalTarget({
        evaluationType: type,
        selectedMetrics,
        metricThresholds,
        overallThresholdValue,
        evalTopK,
        evalInputMode: ragEvaluationMode === "question" ? "question" : (evalUseCsvUpload ? "csv_upload" : "index_name"),
        evalIndexName: evalIndexNameWithUser,
        evalCsvFilename: evalCsvFile?.name || "",
        testScenario,
        testInputs,
        expectedOutput,
        excludeContains: evalExcludeContains,
        emailToNotify,
        evalUsername: effectiveEvalUsername,
        deepevalModel: deepevalModel || selectedModel || null,
        deepevalFramework: deepevalFramework || userFramework || null,
        ragTestModel: ragTestModel || selectedModel || null,
        ragTestFramework: ragTestFramework || userFramework || null,
        goldenModel: goldenModel || null,
        goldenFramework: goldenFramework || null,
        agentId: item.id,
        agentName: item.name,
        agentGoldenIndexName: agentGoldenIndexName || "agent_eval_golden",
        agentOutputIndexName,
      });
      const scheduleNeedsGoldenTruthModel =
        ragEvaluationMode === "question" && !String(expectedOutput || "").trim();
      const mergedScheduleConfig = scheduleTarget
        ? { ...baseScheduleConfig, ...scheduleTarget }
        : scheduleConfig;
      const payload = {
        evaluation_type: type,
        item_id: item.id,
        item_name: item.name,
        test_scenario: testScenario || (type.startsWith("rag_") ? `RAG Evaluation (${evalIndexName || "index"})` : ""),
        test_inputs: testInputs,
        expected_output: expectedOutput,
        retrieval_context: String(type || "").startsWith("rag_")
          ? []
          : (retrievalContext ? retrievalContext.split("\n").filter(c => c.trim()) : []),
        selected_metrics: selectedMetrics,
        selected_model: selectedModel || null,
        selected_framework: userFramework,
        metric_thresholds: metricThresholds || {},
        overall_threshold_value: overallThresholdValue,
        status: scheduleEnabled ? "scheduled" : "completed",
        schedule_config: scheduleEnabled ? mergedScheduleConfig : null,
        started_at: nowIso,
        executed_by: user.email,
        ...(type.startsWith("rag_")
          ? {
              eval_run_id: evalRunId,
              email_to_notify: normalizeEmailRecipientsForApi(emailToNotify),
              eval_username: effectiveEvalUsername,
              ...(ragEvaluationMode !== "question" && evalIndexNameWithUser ? { eval_index_name: evalIndexNameWithUser } : {}),
              eval_api_url: getEvalRunApiUrl(),
              eval_input_mode: ragEvaluationMode === "question" ? "question" : (evalUseCsvUpload ? "csv_upload" : "index_name"),
              ...(ragEvaluationMode !== "question" && evalUseCsvUpload && evalCsvFile?.name ? { eval_csv_filename: evalCsvFile.name } : {}),
              deepeval_metrics_model: deepevalModel || selectedModel || null,
              deepeval_metrics_framework: deepevalFramework || userFramework || null,
              model_under_test: ragTestModel || selectedModel || null,
              model_under_test_framework: ragTestFramework || userFramework || null,
              ...(scheduleNeedsGoldenTruthModel
                ? {
                    golden_truth_model: goldenModel || null,
                    golden_truth_framework: goldenFramework || null,
                  }
                : {}),
            }
          : type === "agent"
            ? {
                eval_run_id: evalRunId,
                eval_api_url: getAgentDeepEvalRunApiUrl(),
                eval_index_name: String(agentGoldenIndexName || "agent_eval_golden").trim(),
                eval_input_mode: "index_name",
                output_opensearch_index: String(agentOutputIndexName || "agent_eval_output").trim(),
                deepeval_metrics_model: deepevalModel || "finance-broker",
                deepeval_metrics_framework: deepevalFramework || "sglang",
              }
          : {}),
      };
      if (scheduleConfigSource?.id) {
        await base44.entities.Evaluation.update(scheduleConfigSource.id, payload);
        return { ...payload, id: scheduleConfigSource.id };
      }
      const newEvaluation = await base44.entities.Evaluation.create(payload);
      return newEvaluation;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["evaluations"] });
      setScheduleConfigEditMode(false);
      setScheduleConfigSource(null);
      setShowEvaluationDialog(false);
      setEvaluationToRun(null);
    },
    onError: (error) => {
      console.error("Failed to save schedule config:", error);
      alert("Failed to save schedule config: " + error.message);
    }
  });


  // Handler for clicking "Run Evaluation" button on agent/tool/workflow cards
  const handleRunEvaluation = (type, item) => {
    setEvaluationToRun({ type, item });
    setScheduleConfigEditMode(false);
    setScheduleConfigSource(null);
    // Reset form fields for the dialog
    setTestScenario("");
    setTestInputs("");
    setExpectedOutput("");
    setRetrievalContext("");
    setCustomCriteria("");
    setUploadedScenarios([]);
    setEmailToNotify("");
    setEvalUsername("");
    setEvalIndexName("");
    setEvalExcludeContains("");
    setEvalUseCsvUpload(false);
    setEvalCsvFile(null);
    setEvalCsvUploading(false);
    setEvalCsvUploadError("");
    setEvalCsvUploaded(false);
    setAgentGoldenIndexName("");
    setAgentUseCsvUpload(false);
    setAgentCsvFile(null);
    setAgentCsvUploading(false);
    setAgentCsvUploadError("");
    setAgentCsvUploaded(false);
    setAgentOutputIndexName("agent_eval_output");
    setAgentEvaluationMode("dataset");
    setAgentQuestions([newAgentGoldenQuestion()]);
    setSavedAgentQuestionIds([]);
    setAgentSingleSaving(false);
    setAgentSinglePrefillKey("");
    setMetricThresholds(
      DEEPEVAL_METRICS.reduce((acc, metric) => {
        acc[metric.id] = metric.threshold;
        return acc;
      }, {})
    );
    setOverallThresholdValue(0.8);
    setRagEvaluationMode("dataset");
    
    // Default metrics might differ for RAG systems
    if (type.startsWith('rag_')) {
      setSelectedMetrics(['contextual_relevancy', 'contextual_precision', 'contextual_recall', 'faithfulness', 'answer_relevancy']);
    } else if (type === "agent") {
      setSelectedMetrics(['correctness_similarity', 'g_eval']);
      setDeepevalFramework("sglang");
      setDeepevalModel("finance-broker");
      setAgentGoldenIndexName("agent_eval_golden");
    } else {
      setSelectedMetrics(['answer_relevancy', 'faithfulness', 'contextual_relevancy']); // Default for agents/tools/workflows
    }

    setShowEvaluationDialog(true);
  };

  const parseCsvLine = (line) => {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };

  const uploadGroundTruthCsv = async (file, username) => {
    if (!file) {
      throw new Error("Missing CSV file for upload.");
    }
    if (!username) {
      throw new Error("Missing username for CSV upload.");
    }

    const formDataPayload = new FormData();
    formDataPayload.append("files", file, file.name);
    formDataPayload.append("user_email_id", removeSpecialCharacters(username));
    formDataPayload.append("image_extraction", "false");
    formDataPayload.append("pii_anonymize", "false");
    formDataPayload.append("classification", "false");
    formDataPayload.append("pipeline_type", "fast_native");
    formDataPayload.append("add_rapidocr", "false");

    const response = await fetch("/api/upload/document_handler", {
      method: "POST",
      body: formDataPayload,
    });

    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // ignore
      }
      const detail = payload?.detail || payload?.error || payload?.message || response.statusText;
      throw new Error(detail || `CSV upload failed (HTTP ${response.status})`);
    }

    // Some backends return useful metadata (e.g. index name). Return it if present.
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  const deleteGroundTruthIndex = async (indexName, username) => {
    const cleanName = String(indexName || "").trim();
    if (!cleanName) return { ok: false, error: "Missing index name" };
    const cleanUser = removeSpecialCharacters(String(username || ""));
    if (!cleanUser) return { ok: false, error: "Missing username for index deletion" };

    const response = await fetch("/api/upload/delete-document-index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_email_id: cleanUser,
        file_name: cleanName,
      }),
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || payload?.error) {
      return {
        ok: false,
        error:
          payload?.error ||
          payload?.detail ||
          payload?.message ||
          `Index deletion failed with status ${response.status}`,
      };
    }
    return { ok: true, payload };
  };

  const handleEvalCsvUpload = async (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    setEvalCsvUploading(true);
    setEvalCsvUploadError("");

    const userEmailValue = String(currentUser?.email || "").trim();
    const cleanUserEmail = removeSpecialCharacters(userEmailValue) || "agentflow_user";
    const baseCsvName = buildGroundTruthCsvBaseName(file.name);
    const expectedIndexName = `${cleanUserEmail}_${baseCsvName}`;
    const renamedFile = new File([file], baseCsvName, {
      type: file.type || "text/csv",
    });

    try {
      const deleteResult = await deleteGroundTruthIndex(baseCsvName, cleanUserEmail);
      if (!deleteResult.ok) {
        toast.warning(deleteResult.error || "Unable to delete existing index.");
      }
      const uploadPayload = await uploadGroundTruthCsv(renamedFile, cleanUserEmail);
      setEvalCsvFile(renamedFile);
      const createdIndexName =
        uploadPayload?.index_name ||
        uploadPayload?.indexName ||
        uploadPayload?.document_index_name ||
        uploadPayload?.documentIndexName ||
        uploadPayload?.dataset ||
        uploadPayload?.dataset_name ||
        uploadPayload?.datasetName ||
        null;
      setEvalIndexName(createdIndexName || expectedIndexName);
      setEvalCsvUploaded(true);
      // Don't force-set evalUsername here; using email as the index prefix avoids double-prefix naming.
      toast.success("Ground truth CSV uploaded.");
    } catch (error) {
      console.error("Failed to upload ground truth CSV:", error);
      setEvalCsvFile(null);
      setEvalIndexName("");
      setEvalCsvUploaded(false);
      const message = error?.message || "Failed to upload CSV.";
      setEvalCsvUploadError(message);
      toast.error(message);
    } finally {
      setEvalCsvUploading(false);
      event.target.value = "";
    }
  };

  const handleScenarioCsvUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (!lines.length) return;
      const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
      const rows = lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((header, idx) => {
          row[header] = values[idx] ?? "";
        });
        return {
          scenario: row.test_scenario || row.scenario || "",
          inputs: row.test_inputs || row["test_input"] || row.question || "",
          expected: row.expected_output || row.expected || "",
          context: row.retrieval_context || row.context || "",
        };
      });
      setUploadedScenarios(rows);
      if (rows.length > 0) {
        setTestScenario(rows[0].scenario);
        setTestInputs(rows[0].inputs);
        setExpectedOutput(rows[0].expected);
        setRetrievalContext(rows[0].context);
      }
    } finally {
      event.target.value = "";
    }
  };

  const uploadAgentGoldenCsv = async (file, indexName) => {
    if (!file) {
      throw new Error("Missing agent golden CSV file.");
    }
    if (!evaluationToRun?.item?.id) {
      throw new Error("Missing agent for CSV upload.");
    }
    const user = await base44.auth.me();
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("agent_id", evaluationToRun.item.id);
    form.append("agent_name", evaluationToRun.item.name || "");
    form.append("username", user?.email || evalUsername || "");
    form.append("index_name", indexName);
    form.append("replace", "false");

    const response = await fetch(getAgentGoldenCsvUploadApiUrl(), {
      method: "POST",
      body: form,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status === "error") {
      throw new Error(
        payload?.message ||
          payload?.detail ||
          payload?.error ||
          `Agent golden CSV upload failed (HTTP ${response.status})`
      );
    }
    return payload;
  };

  const uploadAgentGoldenSingleQuestion = async (indexName) => {
    if (!evaluationToRun?.item?.id) {
      throw new Error("Missing agent for single question.");
    }
    if (!agentQuestions.length || agentQuestions.some((row) => !String(row.question || "").trim())) {
      throw new Error("Enter a question in every entry, or remove empty entries before saving.");
    }
    if (agentQuestions.length > 100) throw new Error("Use up to 100 questions per agent.");
    const user = await base44.auth.me();
    const response = await fetch(getAgentGoldenCsvUploadApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: evaluationToRun.item.id,
        agent_name: evaluationToRun.item.name || "",
        username: user?.email || evalUsername || "",
        index_name: indexName,
        rows: agentQuestions.map((row) => ({ ...row, question: row.question.trim() })),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status === "error") {
      throw new Error(
        payload?.message ||
          payload?.detail ||
          payload?.error ||
          `Agent golden question save failed (HTTP ${response.status})`
      );
    }
    setSavedAgentQuestionIds(agentQuestions.map((row) => row.question_id));
    return payload;
  };

  const deleteAgentQuestion = async (row) => {
    setAgentSingleSaving(true);
    try {
      if (savedAgentQuestionIds.includes(row.question_id)) {
        const response = await fetch(`${getEvalServiceBaseUrl()}/agent-golden-question`, {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: evaluationToRun.item.id, question_id: row.question_id, index: agentGoldenIndexForPrefill }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.status === "error") throw new Error(payload?.message || "Could not delete question.");
      }
      setAgentQuestions((rows) => rows.filter((item) => item.question_id !== row.question_id));
      setSavedAgentQuestionIds((ids) => ids.filter((id) => id !== row.question_id));
      toast.success("Question deleted");
    } catch (error) { toast.error(error.message); }
    finally { setAgentSingleSaving(false); }
  };

  const saveAgentQuestions = async () => {
    setAgentSingleSaving(true);
    setAgentCsvUploadError("");
    try {
      await uploadAgentGoldenSingleQuestion(agentGoldenIndexForPrefill);
      toast.success("All questions saved");
    } catch (error) { setAgentCsvUploadError(error.message); toast.error(error.message); }
    finally { setAgentSingleSaving(false); }
  };

  const handleAgentGoldenCsvUpload = async (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    const userEmailValue = String(currentUser?.email || evalUsername || "").trim();
    const nextIndexName =
      String(agentGoldenIndexName || "").trim() && agentGoldenIndexName !== "agent_eval_golden"
        ? agentGoldenIndexName
        : buildAgentGoldenIndexName(evaluationToRun?.item, userEmailValue);

    setAgentCsvUploading(true);
    setAgentCsvUploadError("");
    try {
      const payload = await uploadAgentGoldenCsv(file, nextIndexName);
      const createdIndex =
        payload?.opensearch_golden_index ||
        payload?.index_name ||
        nextIndexName;
      setAgentCsvFile(file);
      setAgentGoldenIndexName(createdIndex);
      setAgentCsvUploaded(true);
      toast.success(`Agent golden CSV uploaded to ${createdIndex}`);
    } catch (error) {
      console.error("Failed to upload agent golden CSV:", error);
      setAgentCsvFile(null);
      setAgentCsvUploaded(false);
      const message = error?.message || "Failed to upload agent golden CSV.";
      setAgentCsvUploadError(message);
      toast.error(message);
    } finally {
      setAgentCsvUploading(false);
      event.target.value = "";
    }
  };

  const downloadGroundTruthCsvTemplate = () => {
    const header = "Question,Answer\n";
    const rows = [
      "\"What is the return policy?\",\"You can return items within 30 days of purchase.\"",
      "\"Do you ship internationally?\",\"Yes, we ship to over 50 countries worldwide.\"",
    ];
    const blob = new Blob([header + rows.join("\n") + "\n"], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "ground_truth_template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Handler for confirming the evaluation run from the dialog
  const handleConfirmRunEvaluation = async () => {
    if (selectedMetrics.length === 0) {
      alert('Please select at least one evaluation metric.');
      return;
    }
    
    // Check if G-Eval is selected and criteria is provided
    if (selectedMetrics.includes('g_eval') && evaluationToRun?.type !== "agent" && !customCriteria.trim()) {
      alert('Please provide custom evaluation criteria for G-Eval (LLM as Judge).');
      return;
    }

    if (evaluationToRun?.type === "agent") {
      let effectiveAgentGoldenIndex = String(agentGoldenIndexName || "").trim();
      if (!effectiveAgentGoldenIndex) {
        effectiveAgentGoldenIndex = "agent_eval_golden";
        setAgentGoldenIndexName(effectiveAgentGoldenIndex);
      }
      if (agentEvaluationMode === "question") {
        setAgentSingleSaving(true);
        setAgentCsvUploadError("");
        try {
          const payload = await uploadAgentGoldenSingleQuestion(effectiveAgentGoldenIndex);
          const createdIndex =
            payload?.opensearch_golden_index ||
            payload?.index_name ||
            effectiveAgentGoldenIndex;
          effectiveAgentGoldenIndex = createdIndex;
          setAgentGoldenIndexName(createdIndex);
          toast.success(`Agent golden question saved to ${createdIndex}`);
        } catch (error) {
          console.error("Failed to save agent golden question:", error);
          const message = error?.message || "Failed to save agent golden question.";
          setAgentCsvUploadError(message);
          toast.error(message);
          setAgentSingleSaving(false);
          return;
        } finally {
          setAgentSingleSaving(false);
        }
      } else {
        if (agentUseCsvUpload && !agentCsvUploaded) {
          alert("Please upload the selected agent golden CSV before running evaluation.");
          return;
        }
      }
      await runEvaluationMutation.mutateAsync({
        type: evaluationToRun.type,
        item: evaluationToRun.item,
        scenario:
          agentEvaluationMode === "question"
            ? `Agent DeepEval (${agentQuestions.length} questions)`
            : testScenario || `Agent DeepEval (${effectiveAgentGoldenIndex})`,
        inputs: testInputs || "",
        expected: expectedOutput || "",
        context: "",
        metrics: selectedMetrics,
        criteria: customCriteria,
        model: selectedModel,
        thresholds: metricThresholds,
        agentGoldenIndexOverride: effectiveAgentGoldenIndex,
      });
      return;
    }

    if (isRagEvaluation) {
      const { emails, invalid } = parseEmailRecipients(emailToNotify);
      if (!emails.length) {
        alert("Please enter at least one valid email recipient before running this evaluation.");
        return;
      }
      if (invalid.length) {
        alert(`These email(s) look invalid: ${invalid.join(", ")}`);
        return;
      }

      if (ragEvaluationMode === "dataset") {
        const hasDatasetSource = evalUseCsvUpload
          ? Boolean(evalCsvFile)
          : Boolean(String(evalIndexName || "").trim());
        if (!hasDatasetSource) {
          alert("Please provide an Eval Index Name or upload a CSV when using the dataset mode.");
          return;
        }
      } else {
        const hasManualQuestion = Boolean(String(testInputs || testScenario || "").trim());
        if (!hasManualQuestion) {
          alert("Please describe a test question or input when using the test scenario mode.");
          return;
        }
      }
      await runEvaluationMutation.mutateAsync({
        type: evaluationToRun.type,
        item: evaluationToRun.item,
        scenario: testScenario || "",
        inputs: testInputs || "",
        expected: expectedOutput || "",
        context: "",
        metrics: selectedMetrics,
        criteria: customCriteria,
        model: selectedModel,
        thresholds: metricThresholds,
      });
      return;
    }

    const scenariosToRun = uploadedScenarios.length > 0
      ? uploadedScenarios
      : [{ scenario: testScenario, inputs: testInputs, expected: expectedOutput, context: retrievalContext }];

    for (const scenarioRow of scenariosToRun) {
      await runEvaluationMutation.mutateAsync({
        type: evaluationToRun.type,
        item: evaluationToRun.item,
        scenario: scenarioRow.scenario || "",
        inputs: scenarioRow.inputs || "",
        expected: scenarioRow.expected || "",
        context: scenarioRow.context || "",
        metrics: selectedMetrics,
        criteria: customCriteria,
        model: selectedModel,
        thresholds: metricThresholds,
      });
    }
  };

  // Handler for clicking "Schedule" button on an evaluation result card
  const handleScheduleEvaluation = (evaluation) => {
    setEvaluationToSchedule(evaluation);
    setShowScheduleDialog(true);
  };

  // Handler for saving the schedule configuration from the SchedulerConfigurator dialog
  const handleSaveSchedule = (scheduleConfig) => {
    if (evaluationToSchedule) {
      if (scheduleConfig && scheduleConfig.enabled === false) {
        updateEvaluationScheduleMutation.mutate({
          id: evaluationToSchedule.id,
          scheduleConfig: null,
        });
        return;
      }
      if (String(evaluationToSchedule?.evaluation_type || "").startsWith("rag_")) {
        const scheduleEmailValue =
          evaluationToSchedule?.email_to_notify ||
          evaluationToSchedule?.eval_api_response?.email_to_notify ||
          "";
        const { emails, invalid } = parseEmailRecipients(scheduleEmailValue);
        if (!emails.length) {
          alert("Please set at least one valid email recipient before scheduling this evaluation.");
          return;
        }
        if (invalid.length) {
          alert(`These email(s) look invalid: ${invalid.join(", ")}`);
          return;
        }
      }

      const scheduleTarget = buildScheduledEvalTargetFromEvaluation(evaluationToSchedule);
      const mergedScheduleConfig = scheduleTarget
        ? { ...scheduleConfig, ...scheduleTarget }
        : scheduleConfig;
      updateEvaluationScheduleMutation.mutate({
        id: evaluationToSchedule.id,
        scheduleConfig: mergedScheduleConfig
      });
    }
  };

  const resolveScheduledItem = useCallback(
    (evaluation) => {
      if (!evaluation) return null;
      switch (evaluation.evaluation_type) {
        case "agent":
          return agents.find((agent) => agent.id === evaluation.item_id) || null;
        case "tool":
          return tools.find((tool) => tool.id === evaluation.item_id) || null;
        case "workflow":
          return workflows.find((workflow) => workflow.id === evaluation.item_id) || null;
        case "rag_system":
          return {
            id: "rag_system",
            name: evaluation.item_name || "Entire RAG System",
            type: "rag_system",
          };
        case "rag_datasource":
          return dataSources.find((source) => source.id === evaluation.item_id) || null;
        case "rag_graph":
          return knowledgeGraphs.find((graph) => graph.id === evaluation.item_id) || null;
        case "rag_index":
          return openSearchIndices.find((index) => index.id === evaluation.item_id) || null;
        default:
          return null;
      }
    },
    [agents, tools, workflows, dataSources, knowledgeGraphs, openSearchIndices]
  );

  const buildScheduleInputSummary = useCallback((evaluation) => {
    if (!evaluation) return { indexName: "N/A", modeLabel: "N/A", scenarioSummary: "" };
    const evalApi = evaluation.eval_api_response && typeof evaluation.eval_api_response === "object"
      ? evaluation.eval_api_response
      : null;
    const evalInputMode = evaluation.eval_input_mode || evalApi?.eval_input_mode || "";
    const rawIndexName = resolveEvaluationValue(evaluation, [
      "eval_index_name",
      "eval_api_response.eval_index_name",
      "eval_api_response.index_name",
      "eval_api_response.eval_index",
      "eval_api_response.dataset",
      "eval_api_response.dataset_name",
    ]);
    const indexName = rawIndexName && String(rawIndexName).trim()
      ? String(rawIndexName).trim()
      : evalApi?.eval_csv_filename || evaluation.eval_csv_filename || "N/A";
    const scenarioParts = [
      evaluation.test_scenario,
      evaluation.test_inputs,
      evaluation.expected_output,
      Array.isArray(evaluation.retrieval_context) ? evaluation.retrieval_context.join("\n") : evaluation.retrieval_context,
      evalApi?.question,
      evalApi?.input,
    ]
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter(Boolean);
    const scenarioSummary = scenarioParts.length
      ? scenarioParts.join(" · ").slice(0, 180)
      : "";
    const inferredMode = evalInputMode || (rawIndexName ? "index_name" : scenarioSummary ? "question" : "");
    const modeLabel = inferredMode === "csv_upload"
      ? "CSV Upload"
      : inferredMode === "index_name"
        ? "Index Name"
        : inferredMode === "question"
          ? "Test Scenario"
          : "N/A";
    if (inferredMode === "index_name" || inferredMode === "csv_upload") {
      return { indexName, modeLabel, scenarioSummary: "" };
    }
    return { indexName: "N/A", modeLabel, scenarioSummary };
  }, []);

  const applyEvaluationConfigToForm = useCallback(
    (evaluation) => {
      if (!evaluation) return;
      const scheduleParams =
        evaluation?.schedule_config?.eval_target_params &&
        typeof evaluation.schedule_config.eval_target_params === "object"
          ? evaluation.schedule_config.eval_target_params
          : {};
      const evalApi =
        evaluation?.eval_api_response && typeof evaluation.eval_api_response === "object"
          ? evaluation.eval_api_response
          : {};
      const savedInputMode =
        evaluation?.schedule_config?.eval_target_input_mode ||
        evaluation?.eval_input_mode ||
        evalApi?.eval_input_mode ||
        "";

      setTestScenario(evaluation.test_scenario || scheduleParams.question || "");
      setTestInputs(evaluation.test_inputs || scheduleParams.question || "");
      setExpectedOutput(evaluation.expected_output || scheduleParams.expected_output || "");
      setRetrievalContext(
        Array.isArray(evaluation.retrieval_context)
          ? evaluation.retrieval_context.join("\n")
          : evaluation.retrieval_context || scheduleParams.context || ""
      );
      setCustomCriteria(evaluation.custom_criteria || "");
      setUploadedScenarios([]);
      setEmailToNotify(evaluation.email_to_notify || scheduleParams.email_to_notify || "");
      setEvalUsername(evaluation.eval_username || scheduleParams.username || "");
      setEvalIndexName(evaluation.eval_index_name || scheduleParams.eval_index_name || "");
      setEvalExcludeContains(scheduleParams.excludeContains || scheduleParams.exclude_contains || "");
      setEvalUseCsvUpload(savedInputMode === "csv_upload");
      setEvalCsvFile(null);
      setEvalCsvUploaded(false);
      const thresholdsFromScheduleMetrics = Array.isArray(scheduleParams.rag_metrics)
        ? scheduleParams.rag_metrics.reduce((acc, metric) => {
            const metricId = normalizeMetricKey(metric?.name || metric?.metric || metric?.id);
            const threshold = Number(metric?.threshold);
            if (metricId && DEEPEVAL_METRIC_IDS.has(metricId) && Number.isFinite(threshold)) {
              acc[metricId] = threshold;
            }
            return acc;
          }, {})
        : {};
      setMetricThresholds({
        ...defaultMetricThresholds,
        ...(evaluation.metric_thresholds || {}),
        ...thresholdsFromScheduleMetrics,
      });
      setOverallThresholdValue(
        Number.isFinite(Number(scheduleParams.overall_threshold_value ?? evaluation.overall_threshold_value))
          ? Number(scheduleParams.overall_threshold_value ?? evaluation.overall_threshold_value)
          : 0.8
      );
      const topKValue = Number(
        scheduleParams.top_k ??
          evaluation.top_k ??
          evaluation.eval_top_k ??
          evalApi?.top_k ??
          evalApi?.eval_top_k ??
          50
      );
      setEvalTopK(Number.isFinite(topKValue) ? Math.max(1, Math.round(topKValue)) : 50);

      const selectedMetricsValue = normalizeSelectedMetrics(
        scheduleParams.rag_metrics ||
          evaluation.selected_metrics ||
          evaluation.selectedMetrics ||
          []
      );
      setSelectedMetrics(
        selectedMetricsValue.length
          ? selectedMetricsValue
          : ['answer_relevancy', 'faithfulness', 'contextual_relevancy']
      );

      const modelValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.model_under_test",
        "selected_model",
        "model_under_test",
        "eval_api_response.model_under_test",
      ]);
      if (modelValue) {
        setSelectedModel(modelValue);
        setRagTestModel(modelValue);
      }

      const frameworkValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.model_under_test_framework",
        "selected_framework",
        "model_under_test_framework",
        "eval_api_response.model_under_test_framework",
      ]);
      if (frameworkValue) {
        setRagTestFramework(frameworkValue);
      }

      const deepevalModelValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.deepeval_metrics_model",
        "deepeval_metrics_model",
        "eval_api_response.deepeval_metrics_model",
      ]);
      if (deepevalModelValue) setDeepevalModel(deepevalModelValue);

      const deepevalFrameworkValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.deepeval_metrics_framework",
        "deepeval_metrics_framework",
        "eval_api_response.deepeval_metrics_framework",
      ]);
      if (deepevalFrameworkValue) setDeepevalFramework(deepevalFrameworkValue);

      const goldenModelValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.golden_truth_model",
        "golden_truth_model",
        "eval_api_response.golden_truth_model",
      ]);
      if (goldenModelValue) setGoldenModel(goldenModelValue);

      const goldenFrameworkValue = resolveEvaluationValue(evaluation, [
        "schedule_config.eval_target_params.golden_truth_framework",
        "golden_truth_framework",
        "eval_api_response.golden_truth_framework",
      ]);
      if (goldenFrameworkValue) setGoldenFramework(goldenFrameworkValue);

      const hasQuestionInputs =
        String(evaluation.test_scenario || "").trim() ||
        String(evaluation.test_inputs || "").trim() ||
        String(evaluation.expected_output || "").trim() ||
        (Array.isArray(evaluation.retrieval_context) && evaluation.retrieval_context.length);
      const hasDatasetConfig =
        String(evaluation.eval_index_name || "").trim() ||
        evaluation.eval_input_mode === "csv_upload" ||
        evaluation.eval_csv_filename;
      if (String(evaluation.evaluation_type || "").startsWith("rag_")) {
        setRagEvaluationMode(
          savedInputMode === "question"
            ? "question"
            : hasDatasetConfig
              ? "dataset"
              : hasQuestionInputs
                ? "question"
                : "dataset"
        );
      } else if (evaluation.evaluation_type === "agent") {
        setAgentEvaluationMode("dataset");
        setAgentGoldenIndexName(
          scheduleParams.opensearch_golden_index ||
            evaluation.eval_index_name ||
            evalApi?.opensearch_golden_index ||
            "agent_eval_golden"
        );
        setAgentOutputIndexName(
          scheduleParams.output_opensearch_index ||
            evaluation.output_opensearch_index ||
            evalApi?.output_opensearch_index ||
            "agent_eval_output"
        );
      }
    },
    [defaultMetricThresholds]
  );

  const handleEditScheduleConfig = useCallback(() => {
    if (!evaluationToSchedule) return;
    const item = resolveScheduledItem(evaluationToSchedule);
    if (!item) {
      alert("This item is no longer available. Please run a new evaluation.");
      return;
    }
    setScheduleConfigEditMode(true);
    setScheduleConfigSource(evaluationToSchedule);
    setEvaluationToRun({ type: evaluationToSchedule.evaluation_type, item });
    applyEvaluationConfigToForm(evaluationToSchedule);
    setOpenEvaluationSections([]);
    setShowScheduleDialog(false);
    setShowEvaluationDialog(true);
  }, [evaluationToSchedule, resolveScheduledItem, applyEvaluationConfigToForm]);

  useEffect(() => {
    if (showEvaluationDialog && scheduleConfigEditMode) {
      setOpenEvaluationSections([]);
    }
  }, [showEvaluationDialog, scheduleConfigEditMode, scheduleConfigSource?.id]);

  const findScheduleSourceEvaluation = useCallback(
    (evaluationType, itemId) => {
      const candidates = evaluations
        .filter((e) => e.evaluation_type === evaluationType && e.item_id === itemId)
        .filter((e) => !isEvaluationRecordInProgress(e));
      if (!candidates.length) return null;
      const scheduled = candidates.find((e) => e.schedule_config?.enabled);
      if (scheduled) return scheduled;
      return [...candidates].sort((a, b) => getEvalTimestamp(b) - getEvalTimestamp(a))[0] || null;
    },
    [evaluations]
  );

  // Handler for toggling metrics in the EvaluationDialog
  const toggleMetric = (metricId) => {
    const normalizedMetricId = normalizeMetricKey(metricId);
    if (!normalizedMetricId || !DEEPEVAL_METRIC_IDS.has(normalizedMetricId)) return;
    setSelectedMetrics((prev) => {
      const normalizedPrev = normalizeSelectedMetrics(prev);
      return normalizedPrev.includes(normalizedMetricId)
        ? normalizedPrev.filter((id) => id !== normalizedMetricId)
        : [...normalizedPrev, normalizedMetricId];
    });
  };

  const isRagEvaluation = evaluationToRun?.type?.startsWith('rag_');
  const needsGoldenTruthModel =
    Boolean(isRagEvaluation) &&
    ragEvaluationMode === "question" &&
    !String(expectedOutput || "").trim();
  const ragModelsMissing =
    Boolean(isRagEvaluation) &&
    (!String(deepevalFramework || "").trim() ||
      !String(deepevalModel || "").trim() ||
      !String(ragTestFramework || "").trim() ||
      !String(ragTestModel || "").trim() ||
      (needsGoldenTruthModel &&
        (!String(goldenFramework || "").trim() ||
          !String(goldenModel || "").trim())));

  // Derived data for display
  const isScheduledEvaluation = useCallback((evaluation) => {
    if (!evaluation) return false;
    const normalizedStatus = String(evaluation?.status || "").toLowerCase();
    if (normalizedStatus === "scheduled") return true;
    if (evaluation?.schedule_config && typeof evaluation.schedule_config === "object") {
      return evaluation.schedule_config.enabled === true;
    }
    return false;
  }, []);

  const getEvalTimestamp = (evaluation) => {
    const raw =
      evaluation?.started_at ||
      evaluation?.startedAt ||
      evaluation?.eval_api_response?.started_at ||
      evaluation?.eval_api_response?.created_at ||
      evaluation?.created_date ||
      evaluation?.created_at ||
      evaluation?.createdAt ||
      evaluation?.completed_at;
    const ts = raw ? new Date(raw).getTime() : 0;
    if (Number.isFinite(ts) && ts > 0) return ts;
    const fallbackFromRunId =
      extractTimestampFromEvalRunId(evaluation?.eval_run_id) ||
      extractTimestampFromEvalRunId(evaluation?.evalRunId);
    return Number.isFinite(fallbackFromRunId) ? fallbackFromRunId : 0;
  };
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const sortedEvaluations = useMemo(() => {
    return [...mergedEvaluations].sort((a, b) => getEvalTimestamp(b) - getEvalTimestamp(a));
  }, [mergedEvaluations]);
  const scheduledEvaluations = useMemo(
    () => sortedEvaluations.filter((e) => isScheduledEvaluation(e)),
    [sortedEvaluations, isScheduledEvaluation]
  );
  const nonScheduledEvaluations = useMemo(
    () => sortedEvaluations.filter((e) => !isScheduledEvaluation(e) && e?.evaluation_type !== "agent"),
    [sortedEvaluations, isScheduledEvaluation]
  );
  const sortedAgentOutputEvaluations = useMemo(
    () => [...agentOutputEvaluations].sort((a, b) => getEvalTimestamp(b) - getEvalTimestamp(a)),
    [agentOutputEvaluations]
  );
  const sortedAgentCaseEvaluations = useMemo(
    () => [...agentCaseEvaluations].sort((a, b) => getEvalTimestamp(b) - getEvalTimestamp(a)),
    [agentCaseEvaluations]
  );
  const last30RagEvaluations = nonScheduledEvaluations.filter((e) => getEvalTimestamp(e) >= thirtyDaysAgo);
  const agentResultEvaluations = useMemo(() => {
    if (resultsRange !== "30d") return sortedAgentOutputEvaluations;
    return sortedAgentOutputEvaluations
      .map((evaluation) => {
        const cases = Array.isArray(evaluation.eval_api_response?.case_rows)
          ? evaluation.eval_api_response.case_rows
          : [];
        const filteredCases = cases.filter((item) => getEvalTimestamp(item) >= thirtyDaysAgo);
        return rebuildAgentEvaluationGroupWithCases(evaluation, filteredCases);
      })
      .filter((evaluation) => {
        const totalCases = Number(evaluation?.eval_summary?.total_cases);
        return Number.isFinite(totalCases) && totalCases > 0;
      });
  }, [resultsRange, sortedAgentOutputEvaluations, thirtyDaysAgo]);
  const agentVisualOptions = useMemo(() => {
    const map = new Map();
    sortedAgentOutputEvaluations.forEach((evaluation) => {
      const key = getAgentVisualKey(evaluation);
      if (!key) return;
      const response = evaluation.eval_api_response || {};
      const caseCount = Number(evaluation.eval_summary?.total_cases);
      map.set(key, {
        key,
        name: evaluation.item_name || response.agent_name || key,
        agentId: evaluation.item_id || response.agent_id || key,
        cases: Number.isFinite(caseCount) ? caseCount : 0,
        latestAt: getEvalTimestamp(evaluation),
      });
    });
    sortedAgentCaseEvaluations.forEach((evaluation) => {
      const key = getAgentVisualKey(evaluation);
      if (!key) return;
      const response = evaluation.eval_api_response || {};
      const existing = map.get(key);
      if (existing) {
        existing.latestAt = Math.max(existing.latestAt || 0, getEvalTimestamp(evaluation));
        if (!existing.cases) existing.cases = 1;
        return;
      }
      map.set(key, {
        key,
        name: evaluation.item_name || response.agent_name || key,
        agentId: evaluation.item_id || response.agent_id || key,
        cases: 1,
        latestAt: getEvalTimestamp(evaluation),
      });
    });
    return Array.from(map.values()).sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
  }, [sortedAgentCaseEvaluations, sortedAgentOutputEvaluations]);

  const filteredAgentVisualOptions = useMemo(() => {
    const query = String(agentVisualSearch || "").trim().toLowerCase();
    if (!query) return agentVisualOptions;
    return agentVisualOptions.filter((option) =>
      `${option.name} ${option.agentId}`.toLowerCase().includes(query)
    );
  }, [agentVisualOptions, agentVisualSearch]);

  useEffect(() => {
    if (resultsKind !== "agent") return;
    if (!agentVisualOptions.length) {
      if (selectedAgentVisualKey) setSelectedAgentVisualKey("");
      return;
    }
    const hasSelected = agentVisualOptions.some((option) => option.key === selectedAgentVisualKey);
    if (!hasSelected) {
      setSelectedAgentVisualKey(agentVisualOptions[0].key);
    }
  }, [agentVisualOptions, resultsKind, selectedAgentVisualKey]);

  const activeResultEvaluations =
    resultsKind === "agent" ? agentResultEvaluations : nonScheduledEvaluations;
  const recentEvaluations = activeResultEvaluations.slice(0, 10);
  const last30DaysEvaluations =
    resultsKind === "agent"
      ? activeResultEvaluations
      : activeResultEvaluations.filter((e) => getEvalTimestamp(e) >= thirtyDaysAgo);
  const displayedEvaluations = resultsRange === "30d" ? last30DaysEvaluations : recentEvaluations;
  const last30ScheduledCount = scheduledEvaluations.filter((e) => getEvalTimestamp(e) >= thirtyDaysAgo).length;
  const evaluationRunningCount = nonScheduledEvaluations.filter((e) => isEvaluationRecordInProgress(e)).length;
  const last30RunningCount = last30RagEvaluations.filter((e) => isEvaluationRecordInProgress(e)).length;
  const totalEvaluationsCount = nonScheduledEvaluations.length;
  const last30TotalEvaluationsCount = last30RagEvaluations.length;
  const scheduledCount = scheduledEvaluations.length;
  const evaluationsForScoreStats = nonScheduledEvaluations.filter((e) => !isEvaluationRecordInProgress(e));
  const getResolvedMetricDetails = useCallback((evaluation) => {
    const metricDetails = getEvaluationMetricDetails(evaluation);
    const remoteMetricDetails = reasoningByEvaluationId[evaluation?.id] || null;
    if (remoteMetricDetails) {
      Object.entries(remoteMetricDetails).forEach(([metricId, result]) => {
        mergeMetricResult(metricDetails, metricId, result);
      });
    }
    return metricDetails;
  }, [reasoningByEvaluationId]);
  const getResolvedOverallScore = useCallback((evaluation) => {
    const storedScore = Number(evaluation?.overall_score);
    if (resultsKind === "agent" && Number.isFinite(storedScore)) {
      return Math.min(1, Math.max(0, storedScore));
    }
    const { combinedScore } = computeQualityRiskScores(getResolvedMetricDetails(evaluation));
    if (Number.isFinite(combinedScore)) {
      return Math.min(1, Math.max(0, Number(combinedScore)));
    }
    if (Number.isFinite(storedScore)) {
      return Math.min(1, Math.max(0, storedScore));
    }
    return null;
  }, [getResolvedMetricDetails, resultsKind]);
  const getResolvedMetricScores = useCallback((evaluation) => {
    if (resultsKind === "agent") {
      const response = evaluation?.eval_api_response || {};
      const checks = response.checks || {};
      const boolScore = (value) => (typeof value === "boolean" ? (value ? 1 : 0) : null);
      const scores = {};
      const successScore = boolScore(evaluation?.passed);
      const statusScore = boolScore(getAgentCheckValue(checks, "status"));
      const toolScore = boolScore(getAgentCheckValue(checks, "expected_tool"));
      const containsScore = boolScore(getAgentCheckValue(checks, "expected_tool_output"));
      const timeScore = boolScore(getAgentCheckValue(checks, "time"));
      if (Number.isFinite(successScore)) scores.success = successScore;
      if (Number.isFinite(statusScore)) scores.status = statusScore;
      if (Number.isFinite(toolScore)) scores.expected_tool = toolScore;
      if (Number.isFinite(containsScore)) scores.expected_tool_output = containsScore;
      if (Number.isFinite(timeScore)) scores.time = timeScore;

      const deepEvalMetrics = Array.isArray(response.deepeval?.metrics) ? response.deepeval.metrics : [];
      deepEvalMetrics.forEach((metric) => {
        const metricId = normalizeAgentMetricKey(metric?.name || metric?.metric || metric?.id);
        if (!metricId || !AGENT_CASE_METRIC_IDS.has(metricId)) return;
        const passedScore = boolScore(metric?.passed);
        const metricScore = Number(metric?.score);
        if (Number.isFinite(passedScore)) {
          scores[metricId] = passedScore;
        } else if (Number.isFinite(metricScore)) {
          scores[metricId] = Math.min(1, Math.max(0, metricScore));
        }
      });

      if (!Number.isFinite(scores.time)) {
        const agentSeconds = Number(response.agent_seconds);
        const humanMinutes = Number(response.human_time_minutes);
        if (Number.isFinite(agentSeconds) && Number.isFinite(humanMinutes)) {
          scores.time = agentSeconds / 60.0 <= humanMinutes ? 1 : 0;
        }
      }
      return scores;
    }
    const scores = {};
    Object.entries(getResolvedMetricDetails(evaluation)).forEach(([metricId, result]) => {
      const score = Number(result?.score);
      if (Number.isFinite(score)) scores[metricId] = score;
    });
    return scores;
  }, [getResolvedMetricDetails, resultsKind]);
  const nowTimestamp = Date.now();
  const last30Window = evaluationsForScoreStats.filter(
    (e) => getEvalTimestamp(e) >= nowTimestamp - 30 * MS_PER_DAY
  );
  const prev30Window = evaluationsForScoreStats.filter((e) => {
    const ts = getEvalTimestamp(e);
    return ts >= nowTimestamp - 60 * MS_PER_DAY && ts < nowTimestamp - 30 * MS_PER_DAY;
  });
  const resolvePassedForStats = useCallback((evaluation) => {
    if (!evaluation) return null;
    // Fallback: compute from scores if we can.
    const metricDetails = getResolvedMetricDetails(evaluation);
    const { combinedScore } = computeQualityRiskScores(metricDetails);
    const threshold = Number(evaluation?.overall_threshold_value ?? 0.8);
    if (Number.isFinite(combinedScore) && Number.isFinite(threshold)) {
      return combinedScore >= threshold;
    }
    if (typeof evaluation.passed === "boolean") return evaluation.passed;
    // Last resort: provider status string.
    const normalized = String(evaluation?.eval_overall_status || "").toLowerCase();
    if (normalized.includes("pass")) return true;
    if (normalized.includes("fail") || normalized.includes("error")) return false;
    return null;
  }, [getResolvedMetricDetails]);

  const evaluationsForCounts = nonScheduledEvaluations.filter((e) => !isEvaluationRecordInProgress(e));
  const last30EvaluationsForCounts = last30RagEvaluations.filter((e) => !isEvaluationRecordInProgress(e));
  const successCount = evaluationsForCounts.filter((e) => resolvePassedForStats(e) === true).length;
  const failureCount = evaluationsForCounts.filter((e) => resolvePassedForStats(e) === false).length;
  const last30SuccessCount = last30EvaluationsForCounts.filter((e) => resolvePassedForStats(e) === true).length;
  const last30FailureCount = last30EvaluationsForCounts.filter((e) => resolvePassedForStats(e) === false).length;
  const calculatePassRate = (evaluations) => {
    const outcomes = evaluations
      .map((evaluation) => resolvePassedForStats(evaluation))
      .filter((outcome) => typeof outcome === "boolean");
    if (!outcomes.length) return null;
    return outcomes.filter(Boolean).length / outcomes.length;
  };
  const passRateValue = calculatePassRate(evaluationsForCounts);
  const last30PassRateValue = calculatePassRate(last30Window);
  const prev30PassRateValue = calculatePassRate(prev30Window);
  const passRate = formatPercentage(passRateValue) || "0.0%";
  const last30PassRate = formatPercentage(last30PassRateValue) || "0.0%";
  const passRatePercent = Number.isFinite(passRateValue) ? passRateValue * 100 : 0;
  const passRateTrend =
    Number.isFinite(last30PassRateValue) && Number.isFinite(prev30PassRateValue)
      ? last30PassRateValue - prev30PassRateValue
      : null;
  const graphEvaluations = (
    resultsKind === "agent"
      ? sortedAgentCaseEvaluations.filter(
          (e) =>
            Boolean(selectedAgentVisualKey) &&
            getAgentVisualKey(e) === selectedAgentVisualKey &&
            getEvalTimestamp(e) >= thirtyDaysAgo
        )
      : last30DaysEvaluations
  ).filter((e) => !isEvaluationRecordInProgress(e));

  useEffect(() => {
    if (!evaluationsForCounts.length) return;
    evaluationsForCounts.forEach((evaluation) => {
      if (!evaluation?.id) return;
      if (
        reasoningByEvaluationId[evaluation.id] ||
        reasoningRawByEvaluationId[evaluation.id] ||
        reasoningLoadingByEvaluationId[evaluation.id]
      ) {
        return;
      }
      if (reasoningFetchAttemptedRef.current.has(evaluation.id)) return;
      if (isEvaluationRecordInProgress(evaluation)) return;
      const reasoningUrl = buildReasoningFetchUrl(evaluation);
      const evalCsvUrl = resolveUrl(evaluation.eval_download_urls?.eval_csv);
      if (!reasoningUrl && !evalCsvUrl) return;

      reasoningFetchAttemptedRef.current.add(evaluation.id);
      setReasoningLoadingByEvaluationId((prev) => ({ ...prev, [evaluation.id]: true }));
      const reasoningRequest = reasoningUrl
        ? fetch(reasoningUrl)
            .then((resp) => (resp.ok ? resp.json() : null))
            .catch(() => null)
        : Promise.resolve(null);
      const csvRequest = evalCsvUrl
        ? fetch(evalCsvUrl)
            .then((resp) => (resp.ok ? resp.text() : ""))
            .catch(() => "")
        : Promise.resolve("");

      Promise.all([reasoningRequest, csvRequest])
        .then(([json, csvText]) => {
          const csvRecords = parseCsvRecords(csvText);
          setReasoningRawByEvaluationId((prev) => ({
            ...prev,
            [evaluation.id]: csvRecords.length ? { records: csvRecords } : json,
          }));
          const extracted = extractMetricDetailsFromResponse(json);
          const computedAvgScores = computeAvgScoresFromEvalResultJson(
            csvRecords.length ? { records: csvRecords } : json
          );
          if (computedAvgScores) {
            Object.entries(computedAvgScores).forEach(([metricId, value]) => {
              mergeMetricResult(extracted, metricId, value);
            });
          }
          if (Object.keys(extracted).length) {
            setReasoningByEvaluationId((prev) => ({
              ...prev,
              [evaluation.id]: extracted,
            }));
          }
        })
        .catch((error) => {
          console.warn("Failed to fetch reasoning details:", error);
        })
        .finally(() => {
          setReasoningLoadingByEvaluationId((prev) => ({
            ...prev,
            [evaluation.id]: false,
          }));
        });
    });
  }, [
    evaluationsForCounts,
    reasoningByEvaluationId,
    reasoningLoadingByEvaluationId,
    reasoningRawByEvaluationId,
  ]);

  const modelDailySeriesData = useMemo(() => {
    const groups = new Map();
    graphEvaluations.forEach((evaluation) => {
      const modelLabel =
        resultsKind === "agent"
          ? evaluation.item_name || evaluation.eval_api_response?.agent_name || "Agent"
          : resolveModelUnderTest(evaluation);
      if (!modelLabel) return;
      const score =
        resultsKind === "agent"
          ? evaluation?.passed === true
            ? 1
            : evaluation?.passed === false
              ? 0
              : null
          : getResolvedOverallScore(evaluation);
      if (!Number.isFinite(score)) return;
      const timestamp = getEvalTimestamp(evaluation);
      if (!timestamp) return;
      const dayKey = formatLocalDayKey(timestamp);
      if (!dayKey) return;
      const dayDate = parseLocalDayKey(dayKey);
      if (!dayDate) return;

      if (!groups.has(modelLabel)) groups.set(modelLabel, new Map());
      const dayBuckets = groups.get(modelLabel);
      if (!dayBuckets.has(dayKey)) {
        dayBuckets.set(dayKey, { total: 0, count: 0, dayKey, dayDate });
      }
      const bucket = dayBuckets.get(dayKey);
      bucket.total += Math.min(1, Math.max(0, Number(score)));
      bucket.count += 1;
    });
    return Array.from(groups.entries())
      .map(([model, dayBuckets]) => ({
        model,
        data: Array.from(dayBuckets.values())
          .map((bucket) => ({
            rawDate: bucket.dayKey,
            label: format(bucket.dayDate, "MMM d"),
            score: bucket.count ? bucket.total / bucket.count : null,
          }))
          .filter((row) => row.score !== null)
          .sort((a, b) => {
            const aDate = parseLocalDayKey(a.rawDate);
            const bDate = parseLocalDayKey(b.rawDate);
            return (aDate?.getTime() ?? 0) - (bDate?.getTime() ?? 0);
          }),
      }))
      .filter((series) => series.data.length > 0);
  }, [graphEvaluations, getResolvedOverallScore, resultsKind]);

  const availableModelTimeframes = useMemo(() => {
    if (!modelDailySeriesData.length) return [];
    const now = Date.now();
    return HISTOGRAM_TIMEFRAMES.map((timeframe) => {
      const { start, end } = getTimeframeRange(timeframe.id, now);
      const hasData = modelDailySeriesData.some((series) =>
        series.data.some((point) => {
          const pointTime = parseLocalDayKey(point.rawDate)?.getTime();
          if (!Number.isFinite(pointTime)) return false;
          return pointTime >= start && pointTime < end;
        })
      );
      return {
        timeframe,
        hasData,
        rangeLabel: formatTimeframeRangeLabel(timeframe.id, start, end),
      };
    }).filter((entry) => entry.hasData);
  }, [modelDailySeriesData]);

  useEffect(() => {
    if (!availableModelTimeframes.length) return;
    const hasActive = availableModelTimeframes.some(
      (entry) => entry.timeframe.id === modelHistogramTimeframe
    );
    if (!hasActive) {
      setModelHistogramTimeframe(availableModelTimeframes[0].timeframe.id);
    }
  }, [availableModelTimeframes, modelHistogramTimeframe]);

  const activeModelMeta = useMemo(() => {
    return availableModelTimeframes.find((entry) => entry.timeframe.id === modelHistogramTimeframe) || null;
  }, [availableModelTimeframes, modelHistogramTimeframe]);

  const activeModelSeriesData = useMemo(() => {
    if (!modelDailySeriesData.length) return [];
    const { start, end } = getTimeframeRange(modelHistogramTimeframe);
    return modelDailySeriesData
      .map((series) => ({
        ...series,
        data: series.data
          .filter((point) => {
            const pointTime = parseLocalDayKey(point.rawDate)?.getTime();
            if (!Number.isFinite(pointTime)) return false;
            return pointTime >= start && pointTime < end;
          })
          .sort((a, b) => {
            const aDate = parseLocalDayKey(a.rawDate);
            const bDate = parseLocalDayKey(b.rawDate);
            return (aDate?.getTime() ?? 0) - (bDate?.getTime() ?? 0);
          }),
      }))
      .filter((series) => series.data.length > 0);
  }, [modelDailySeriesData, modelHistogramTimeframe]);

  const resolveExecutionTimeMs = useCallback((evaluation) => {
    if (!evaluation) return null;
    const candidates = [
      { value: evaluation.eval_api_response?.agent_seconds, multiplier: 1000 },
      { value: evaluation.eval_api_response?.agent_minutes, multiplier: 60000 },
      { value: evaluation.eval_api_response?.avg_total_seconds, multiplier: 1000 },
      { value: evaluation.eval_api_response?.total_seconds, multiplier: 1000 },
      { value: evaluation.eval_api_response?.total_time_seconds, multiplier: 1000 },
      { value: evaluation.eval_api_response?.total_time, multiplier: 1000 },
      { value: evaluation.eval_api_response?.duration_seconds, multiplier: 1000 },
      { value: evaluation.metrics?.execution_time_ms, multiplier: 1 },
      { value: evaluation.metrics?.total_execution_time_ms, multiplier: 1 },
      { value: evaluation.metrics?.response_time_ms, multiplier: 1 },
      { value: evaluation.metrics?.total_execution_time, multiplier: 1 },
      { value: evaluation.eval_summary?.avg_response_time_ms, multiplier: 1 },
      { value: evaluation.eval_summary?.avg_response_time, multiplier: 1 },
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate.value);
      if (Number.isFinite(numeric)) {
        return numeric * candidate.multiplier;
      }
    }
    return null;
  }, []);

  const scoreMetricCatalog = resultsKind === "agent" ? AGENT_CASE_METRICS : DEEPEVAL_METRICS;

  const dailyHistogramData = useMemo(() => {
    if (!graphEvaluations.length) return [];
    const buckets = new Map();
    graphEvaluations.forEach((evaluation) => {
      const timestamp = getEvalTimestamp(evaluation);
      if (!timestamp) return;
      const dayKey = formatLocalDayKey(timestamp);
      if (!dayKey) return;
      const dayDate = parseLocalDayKey(dayKey);
      if (!dayDate) return;
      if (!buckets.has(dayKey)) {
        buckets.set(dayKey, {
          dayKey,
          label: format(dayDate, "MMM d"),
          metrics: {},
        });
      }
      const bucket = buckets.get(dayKey);
      const metricScores = getResolvedMetricScores(evaluation);
      scoreMetricCatalog.forEach((metric) => {
        const value = getMetricDisplayScore(metric, metricScores[metric.id]);
        if (!Number.isFinite(value)) return;
        const stats = bucket.metrics[metric.id] || { total: 0, count: 0 };
        stats.total += value;
        stats.count += 1;
        bucket.metrics[metric.id] = stats;
      });
    });

    return Array.from(buckets.values())
      .map((bucket) => {
        const row = {
          rawDate: bucket.dayKey,
          label: bucket.label,
        };
        let hasValues = false;
        Object.entries(bucket.metrics).forEach(([metricId, stats]) => {
          if (stats.count) {
            row[metricId] = Math.min(100, (stats.total / stats.count) * 100);
            hasValues = true;
          }
        });
        return hasValues ? row : null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aDate = parseLocalDayKey(a.rawDate);
        const bDate = parseLocalDayKey(b.rawDate);
        return (aDate?.getTime() ?? 0) - (bDate?.getTime() ?? 0);
      });
  }, [graphEvaluations, getResolvedMetricScores, scoreMetricCatalog]);

  const timeframeHistogramData = useMemo(() => {
    if (!dailyHistogramData.length) return new Map();
    const now = Date.now();
    const map = new Map();
    HISTOGRAM_TIMEFRAMES.forEach((timeframe) => {
      const { start, end } = getTimeframeRange(timeframe.id, now);
      const rows = dailyHistogramData
        .filter((row) => {
          const rowTime = parseLocalDayKey(row.rawDate)?.getTime();
          if (!Number.isFinite(rowTime)) return false;
          return rowTime >= start && rowTime < end;
        })
        .map((row) => ({
          ...row,
          timeframeId: timeframe.id,
        }));
      if (!rows.length) return;
      map.set(timeframe.id, {
        rows,
        rangeLabel: formatTimeframeRangeLabel(timeframe.id, start, end),
      });
    });
    return map;
  }, [dailyHistogramData]);

  const dailyResponseTimeData = useMemo(() => {
    if (!graphEvaluations.length) return [];
    const buckets = new Map();
    graphEvaluations.forEach((evaluation) => {
      const timestamp = getEvalTimestamp(evaluation);
      const responseTime = resolveExecutionTimeMs(evaluation);
      if (!timestamp || !Number.isFinite(responseTime)) return;
      const humanMinutes = Number(evaluation?.eval_api_response?.human_time_minutes);
      const humanTimeMs =
        resultsKind === "agent" && Number.isFinite(humanMinutes)
          ? humanMinutes * 60 * 1000
          : null;
      const dayKey = formatLocalDayKey(timestamp);
      if (!dayKey) return;
      const dayDate = parseLocalDayKey(dayKey);
      if (!dayDate) return;
      if (!buckets.has(dayKey)) {
        buckets.set(dayKey, {
          total: 0,
          count: 0,
          humanTotal: 0,
          humanCount: 0,
          dayKey,
          dayDate,
        });
      }
      const bucket = buckets.get(dayKey);
      bucket.total += responseTime;
      bucket.count += 1;
      if (Number.isFinite(humanTimeMs)) {
        bucket.humanTotal += humanTimeMs;
        bucket.humanCount += 1;
      }
    });

    return Array.from(buckets.values())
      .map((bucket) => ({
        rawDate: bucket.dayKey,
        label: format(bucket.dayDate, "MMM d"),
        runs: bucket.count,
        avgResponseTimeMs: bucket.count ? bucket.total / bucket.count : null,
        avgHumanTimeMs: bucket.humanCount ? bucket.humanTotal / bucket.humanCount : null,
        agentSeconds: bucket.count ? bucket.total / bucket.count / 1000 : null,
        humanSeconds: bucket.humanCount ? bucket.humanTotal / bucket.humanCount / 1000 : null,
        savedSeconds:
          bucket.humanCount && bucket.count
            ? Math.max(0, bucket.humanTotal / bucket.humanCount / 1000 - bucket.total / bucket.count / 1000)
            : null,
      }))
    .filter((row) => row.avgResponseTimeMs !== null)
    .sort((a, b) => {
      const aDate = parseLocalDayKey(a.rawDate);
      const bDate = parseLocalDayKey(b.rawDate);
      return (aDate?.getTime() ?? 0) - (bDate?.getTime() ?? 0);
    });
  }, [graphEvaluations, resolveExecutionTimeMs, resultsKind]);

  const timeframeResponseTimeAverages = useMemo(() => {
    const now = Date.now();
    const map = new Map();
    HISTOGRAM_TIMEFRAMES.forEach((timeframe) => {
      const { start, end } = getTimeframeRange(timeframe.id, now);
      let total = 0;
      let count = 0;
      let humanTotal = 0;
      let humanCount = 0;
      graphEvaluations.forEach((evaluation) => {
        const timestamp = getEvalTimestamp(evaluation);
        if (!timestamp || timestamp < start || timestamp >= end) return;
        const responseTime = resolveExecutionTimeMs(evaluation);
        if (!Number.isFinite(responseTime)) return;
        total += responseTime;
        count += 1;
        const humanMinutes = Number(evaluation?.eval_api_response?.human_time_minutes);
        if (resultsKind === "agent" && Number.isFinite(humanMinutes)) {
          humanTotal += humanMinutes * 60 * 1000;
          humanCount += 1;
        }
      });
      map.set(timeframe.id, {
        averageMs: count ? total / count : null,
        averageHumanMs: humanCount ? humanTotal / humanCount : null,
        count,
      });
    });
    return map;
  }, [graphEvaluations, resolveExecutionTimeMs, resultsKind]);

  const availableResponseTimeTimeframes = useMemo(() => {
    return HISTOGRAM_TIMEFRAMES.map((timeframe) => ({
      timeframe,
      stats: timeframeResponseTimeAverages.get(timeframe.id),
    })).filter(({ stats }) => stats?.count);
  }, [timeframeResponseTimeAverages]);

  useEffect(() => {
    if (!availableResponseTimeTimeframes.length) return;
    const hasActive = availableResponseTimeTimeframes.some(
      (entry) => entry.timeframe.id === timeHistogramTimeframe
    );
    if (!hasActive) {
      setTimeHistogramTimeframe(availableResponseTimeTimeframes[0].timeframe.id);
    }
  }, [availableResponseTimeTimeframes, timeHistogramTimeframe]);

  const activeResponseTimeData = useMemo(() => {
    if (!dailyResponseTimeData.length) return [];
    const { start, end } = getTimeframeRange(timeHistogramTimeframe);
    const byDayKey = new Map(dailyResponseTimeData.map((row) => [row.rawDate, row]));
    const rows = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    const endCursor = new Date(Math.max(start, end - 1));
    endCursor.setHours(0, 0, 0, 0);
    const maxDays = 180;
    let days = 0;

    while (cursor.getTime() <= endCursor.getTime() && days < maxDays) {
      const dayKey = formatLocalDayKey(cursor.getTime());
      if (dayKey) {
        const existing = byDayKey.get(dayKey);
        rows.push(
          existing ?? {
            rawDate: dayKey,
            label: format(cursor, "MMM d"),
            runs: 0,
            avgResponseTimeMs: null,
            avgHumanTimeMs: null,
            agentSeconds: null,
            humanSeconds: null,
            savedSeconds: null,
          }
        );
      }
      cursor.setDate(cursor.getDate() + 1);
      days += 1;
    }

    return rows;
  }, [dailyResponseTimeData, timeHistogramTimeframe]);

  const timeframeMetricStats = useMemo(() => {
    const now = Date.now();
    const map = new Map();
    HISTOGRAM_TIMEFRAMES.forEach((timeframe) => {
      const { start, end } = getTimeframeRange(timeframe.id, now);
      const stats = {
        totalRuns: 0,
        metrics: {},
      };
      graphEvaluations.forEach((evaluation) => {
        const timestamp = getEvalTimestamp(evaluation);
        if (!timestamp || timestamp < start || timestamp >= end) return;
        const metricScores = getResolvedMetricScores(evaluation);
        stats.totalRuns += 1;
        scoreMetricCatalog.forEach((metric) => {
          const value = getMetricDisplayScore(metric, metricScores[metric.id]);
          if (!Number.isFinite(value)) return;
          const metricStats = stats.metrics[metric.id] || { total: 0, count: 0 };
          metricStats.total += value;
          metricStats.count += 1;
          stats.metrics[metric.id] = metricStats;
        });
      });
      map.set(timeframe.id, stats);
    });
    return map;
  }, [graphEvaluations, getResolvedMetricScores, scoreMetricCatalog]);

  const timeframeMetricAverages = useMemo(() => {
    const map = new Map();
    timeframeMetricStats.forEach((stats, timeframeId) => {
      const averages = {};
      Object.entries(stats.metrics).forEach(([metricId, metricStats]) => {
        if (!metricStats.count) return;
        averages[metricId] = Math.min(100, (metricStats.total / metricStats.count) * 100);
      });
      map.set(timeframeId, {
        averages,
        totalRuns: stats.totalRuns,
      });
    });
    return map;
  }, [timeframeMetricStats]);

  const histogramMetricOptions = useMemo(() => {
    if (!dailyHistogramData.length) return [];
    const seen = new Set();
    dailyHistogramData.forEach((row) => {
      Object.keys(row).forEach((key) => {
        if (key !== "label" && key !== "rawDate") {
          seen.add(key);
        }
      });
    });
    return scoreMetricCatalog.filter((metric) => seen.has(metric.id));
  }, [dailyHistogramData, scoreMetricCatalog]);

  useEffect(() => {
    if (!histogramMetricOptions.length) return;
    const optionIds = new Set(histogramMetricOptions.map((metric) => metric.id));
    const hasStaleSelection = selectedHistogramMetrics.some((metricId) => !optionIds.has(metricId));
    if (!selectedHistogramMetrics.length || hasStaleSelection) {
      setSelectedHistogramMetrics(histogramMetricOptions.map((metric) => metric.id));
    }
  }, [histogramMetricOptions, selectedHistogramMetrics]);

  const metricsToPlot = useMemo(() => {
    if (!histogramMetricOptions.length) return [];
    if (!selectedHistogramMetrics.length) return histogramMetricOptions;
    return histogramMetricOptions.filter((metric) => selectedHistogramMetrics.includes(metric.id));
  }, [histogramMetricOptions, selectedHistogramMetrics]);

  const availableHistogramTimeframes = useMemo(() => {
    return HISTOGRAM_TIMEFRAMES.map((timeframe) => ({
      timeframe,
      meta: timeframeHistogramData.get(timeframe.id),
      stats: timeframeMetricAverages.get(timeframe.id),
    })).filter(({ meta }) => meta?.rows?.length);
  }, [timeframeHistogramData, timeframeMetricAverages]);

  const activeHistogramTimeframeEntry = availableHistogramTimeframes.find(
    (entry) => entry.timeframe.id === activeHistogramTimeframe
  );

  useEffect(() => {
    if (!availableHistogramTimeframes.length) return;
    const hasActive =
      availableHistogramTimeframes.some((entry) => entry.timeframe.id === activeHistogramTimeframe);
    if (!hasActive) {
      setActiveHistogramTimeframe(availableHistogramTimeframes[0].timeframe.id);
    }
  }, [availableHistogramTimeframes, activeHistogramTimeframe]);

  const activeHistogramMeta = timeframeHistogramData.get(activeHistogramTimeframe);
  const activeHistogramRows = activeHistogramMeta?.rows ?? [];
  const activeTimeframeStats = timeframeMetricAverages.get(activeHistogramTimeframe);
  const isShortEvalScoreBarView = ["daily", "yesterday"].includes(activeHistogramTimeframe);

  const averageResponseTimeMs = useMemo(() => {
    const { start, end } = getTimeframeRange(timeHistogramTimeframe);
    const values = graphEvaluations
      .filter((evaluation) => {
        const timestamp = getEvalTimestamp(evaluation);
        return timestamp >= start && timestamp < end;
      })
      .map((evaluation) => resolveExecutionTimeMs(evaluation))
      .filter((value) => Number.isFinite(value));
    if (!values.length) return null;
    const total = values.reduce((sum, next) => sum + next, 0);
    return total / values.length;
  }, [graphEvaluations, resolveExecutionTimeMs, timeHistogramTimeframe]);

  const activeTimeRangeLabel = useMemo(() => {
    const { start, end } = getTimeframeRange(timeHistogramTimeframe);
    return formatTimeframeRangeLabel(timeHistogramTimeframe, start, end);
  }, [timeHistogramTimeframe]);

  const formatDurationLabel = (ms) => {
    if (!Number.isFinite(ms)) {
      return "N/A";
    }
    const seconds = ms / 1000;
    if (seconds >= 60) {
      const minutes = Math.floor(seconds / 60);
      const remainderSeconds = (seconds % 60).toFixed(0).padStart(2, "0");
      return `${minutes}m ${remainderSeconds}s (${Math.round(ms)} ms)`;
    }
    return `${seconds.toFixed(2)}s (${Math.round(ms)} ms)`;
  };

  const formatMetricAverageLabel = (value) =>
    Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";

  return (
    <div className="space-y-6">
      <Alert className="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
        <Brain className="w-4 h-4 text-blue-600" />
        <AlertDescription className="text-blue-900 dark:text-blue-100">
          <strong>Evaluation Integration:</strong> This evaluation system uses Eval metrics to comprehensively assess AI agent and workflow performance across multiple dimensions including relevancy, faithfulness, bias, and hallucination detection.
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Evaluations</p>
              <p className="text-2xl font-bold">{totalEvaluationsCount}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                Last 30 days: {last30TotalEvaluationsCount}
              </p>
            </div>
            <ClipboardList className="w-8 h-8 text-purple-600 dark:text-purple-400" />
          </div>
        </Card>

        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Scheduled</p>
              <p className="text-2xl font-bold text-purple-600">{scheduledCount}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                Last 30 days: {last30ScheduledCount}
              </p>
            </div>
            <Clock className="w-8 h-8 text-purple-600 dark:text-purple-400" />
          </div>
        </Card>

        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Pass Rate</p>
              <p
                className={`text-2xl font-bold ${
                  passRatePercent < 80 ? "text-red-600" : "text-green-600"
                }`}
              >
                {passRate}
              </p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                Last 30 days: {last30PassRate}
              </p>
            </div>
            {passRateTrend === null ? (
              <TrendingUp className="w-8 h-8 text-gray-400" />
            ) : passRateTrend >= 0 ? (
              <TrendingUp
                className={`w-8 h-8 ${passRatePercent < 80 ? "text-red-600" : "text-green-600"}`}
              />
            ) : (
              <TrendingDown
                className={`w-8 h-8 ${passRatePercent < 80 ? "text-red-600" : "text-green-600"}`}
              />
            )}
          </div>
        </Card>

        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Running</p>
              <p className="text-2xl font-bold">
                {evaluationRunningCount}
              </p>
            </div>
            {evaluationRunningCount ? (
              <Loader2
                className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin"
                aria-hidden="true"
              />
            ) : null}
          </div>
        </Card>

        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Successful Evaluations</p>
              <p className="text-2xl font-bold text-green-600">{successCount}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                Last 30 days: {last30SuccessCount}
              </p>
            </div>
            <CheckCircle2 className="w-8 h-8 text-green-600" />
          </div>
        </Card>

        <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed Evaluations</p>
              <p className="text-2xl font-bold text-red-600">{failureCount}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                Last 30 days: {last30FailureCount}
              </p>
            </div>
            <XCircle className="w-8 h-8 text-red-600" />
          </div>
        </Card>
      </div>

      {/* Main Tabs for Agents, Tools, Workflows, RAG, and Results */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="agents">
            <Bot className="w-4 h-4 mr-2" />
            Agents
          </TabsTrigger>
          <TabsTrigger value="tools">
            <Package className="w-4 h-4 mr-2" />
            Tools
          </TabsTrigger>
          <TabsTrigger value="workflows">
            <WorkflowIcon className="w-4 h-4 mr-2" />
            Workflows
          </TabsTrigger>
          <TabsTrigger value="rag">
            <Brain className="w-4 h-4 mr-2" />
            RAG Systems
          </TabsTrigger>
          <TabsTrigger value="results">
            <ClipboardList className="w-4 h-4 mr-2" />
            Results
          </TabsTrigger>
        </TabsList>

        <TabsContent value="agents">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="font-bold text-lg">Evaluate Agents</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Showing {filteredAgents.length} of {Array.isArray(agents) ? agents.length : 0} agents.
              </p>
            </div>
            <div className="relative w-full md:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                value={agentListSearch}
                onChange={(event) => setAgentListSearch(event.target.value)}
                placeholder="Search agents by name, description, or id"
                className="h-10 pl-9"
              />
            </div>
          </div>
          <div className="space-y-4">
            {(!Array.isArray(agents) || agents.length === 0) && (
              <p className="text-gray-500 dark:text-gray-400">No agents available for evaluation.</p>
            )}
            {Array.isArray(agents) && agents.length > 0 && filteredAgents.length === 0 && (
              <Card className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No agents match this search.
                </p>
              </Card>
            )}
            {filteredAgents.map((agent, index) => {
              const resultKey = agent.id || agent.name;
              const agentEvalResult = resultKey ? agentEvalResultsByAgent[resultKey] : null;
              const agentEvalError = agentEvalResult?.status === "error" ? agentEvalResult : null;
              return (
                <Card key={agent.id || `agent-${agent.name || index}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h4 className="font-semibold text-lg flex items-center gap-2">
                        <Bot className="w-5 h-5 text-purple-600" />
                        {agent.name}
                      </h4>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{agent.description}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleRunEvaluation('agent', agent)}
                      className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                    >
                      <Play className="w-4 h-4 mr-2" />
                      Run Evaluation
                    </Button>
                    <Button
                      onClick={() => {
                        const existingEval = findScheduleSourceEvaluation('agent', agent.id);
                        if (existingEval) {
                          handleScheduleEvaluation(existingEval);
                        } else {
                          alert('Please run at least one evaluation first before scheduling recurring tests for this agent.');
                        }
                      }}
                      variant="outline"
                      className="md-ripple"
                    >
                      <Clock className="w-4 h-4 mr-2" />
                      Schedule
                    </Button>
                  </div>
                  <AgentEvalOutputPanel
                    agent={agent}
                    result={agentEvalResult}
                    isLoading={isFetchingAgentEvalResults && !agentEvalResult}
                    error={agentEvalError}
                  />
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="tools">
          <h3 className="font-bold text-lg mb-4">Evaluate Tools</h3>
          <div className="space-y-4">
            {tools.length === 0 && (
              <p className="text-gray-500 dark:text-gray-400">No tools available for evaluation.</p>
            )}
            {tools.map((tool, index) => (
              <Card key={tool.id || `tool-${tool.name || index}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h4 className="font-semibold text-lg flex items-center gap-2">
                      <Package className="w-5 h-5 text-blue-600" />
                      {tool.name}
                    </h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{tool.description}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => handleRunEvaluation('tool', tool)}
                    className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Run Evaluation
                  </Button>
                  <Button
                    onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('tool', tool.id);
                      if (existingEval) {
                        handleScheduleEvaluation(existingEval);
                      } else {
                        alert('Please run at least one evaluation first before scheduling recurring tests for this tool.');
                      }
                    }}
                    variant="outline"
                    className="md-ripple"
                  >
                    <Clock className="w-4 h-4 mr-2" />
                    Schedule
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="workflows">
          <h3 className="font-bold text-lg mb-4">Evaluate Workflows</h3>
          <div className="space-y-4">
            {workflows.length === 0 && (
              <p className="text-gray-500 dark:text-gray-400">No workflows available for evaluation.</p>
            )}
            {workflows.map((workflow, index) => (
              <Card key={workflow.id || `workflow-${workflow.name || index}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h4 className="font-semibold text-lg flex items-center gap-2">
                      <WorkflowIcon className="w-5 h-5 text-orange-600" />
                      {workflow.name}
                    </h4>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{workflow.description}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => handleRunEvaluation('workflow', workflow)}
                    className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Run Evaluation
                  </Button>
                  <Button
                    onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('workflow', workflow.id);
                      if (existingEval) {
                        handleScheduleEvaluation(existingEval);
                      } else {
                        alert('Please run at least one evaluation first before scheduling recurring tests for this workflow.');
                      }
                    }}
                    variant="outline"
                    className="md-ripple"
                  >
                    <Clock className="w-4 h-4 mr-2" />
                    Schedule
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>

	        <TabsContent value="rag">
	          <h3 className="font-bold text-lg mb-4">Evaluate RAG Systems</h3>
	          <div className="space-y-4">
	            <Card className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
	              <div className="flex justify-between items-start mb-4">
	                <div>
	                  <h4 className="font-semibold text-lg flex items-center gap-2">
	                    <Brain className="w-5 h-5 text-teal-600" />
	                    Entire RAG System
	                  </h4>
	                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
	                    Run evaluation across your overall RAG setup (not tied to one specific source).
	                  </p>
	                </div>
	              </div>
	              <div className="flex gap-2">
	                <Button
	                  onClick={() => handleRunEvaluation('rag_system', {
	                    id: 'rag_system',
	                    name: 'Entire RAG System',
	                    type: 'rag_system',
	                  })}
	                  className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
	                >
	                  <Play className="w-4 h-4 mr-2" />
	                  Evaluate Entire RAG
	                </Button>
	                <Button
	                  onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('rag_system', 'rag_system');
	                    if (existingEval) {
	                      handleScheduleEvaluation(existingEval);
	                    } else {
	                      alert('Please run at least one evaluation first before scheduling recurring tests for the entire RAG system.');
	                    }
	                  }}
	                  variant="outline"
	                  className="md-ripple"
	                >
	                  <Clock className="w-4 h-4 mr-2" />
	                  Schedule
	                </Button>
	              </div>
	            </Card>

	            {/* Data Sources */}
	            {dataSources.length > 0 && (
	              <div className="space-y-3">
	                <h4 className="font-semibold text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2">
	                  <Database className="w-4 h-4 text-blue-600" />
	                  Data Sources ({dataSources.length})
	                </h4>
                {dataSources.map((source, index) => (
                  <Card key={source.id || `datasource-${source.name || index}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h4 className="font-semibold text-lg flex items-center gap-2">
                          <Database className="w-5 h-5 text-blue-600" />
                          {source.name}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          Type: {source.type?.replace(/_/g, ' ')} • {source.file_count || 0} files
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleRunEvaluation('rag_datasource', { 
                          id: source.id, 
                          name: source.name,
                          type: 'data_source',
                          data_source_type: source.type
                        })}
                        className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                      >
                        <Play className="w-4 h-4 mr-2" />
                        Evaluate RAG
                      </Button>
                      <Button
                        onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('rag_datasource', source.id);
                          if (existingEval) {
                            handleScheduleEvaluation(existingEval);
                          } else {
                            alert('Please run at least one evaluation first before scheduling recurring tests for this data source.');
                          }
                        }}
                        variant="outline"
                        className="md-ripple"
                      >
                        <Clock className="w-4 h-4 mr-2" />
                        Schedule
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* Knowledge Graphs */}
            {knowledgeGraphs.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2 mt-6">
                  <Network className="w-4 h-4 text-purple-600" />
                  Knowledge Graphs ({knowledgeGraphs.length})
                </h4>
                {knowledgeGraphs.map((graph, index) => (
                  <Card key={graph.id || `knowledge-graph-${graph.name || index}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h4 className="font-semibold text-lg flex items-center gap-2">
                          <Network className="w-5 h-5 text-purple-600" />
                          {graph.name}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          {graph.node_count || 0} nodes • {graph.relationship_count || 0} relationships
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleRunEvaluation('rag_graph', { 
                          id: graph.id, 
                          name: graph.name,
                          type: 'knowledge_graph'
                        })}
                        className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                      >
                        <Play className="w-4 h-4 mr-2" />
                        Evaluate GraphRAG
                      </Button>
                      <Button
                        onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('rag_graph', graph.id);
                          if (existingEval) {
                            handleScheduleEvaluation(existingEval);
                          } else {
                            alert('Please run at least one evaluation first before scheduling recurring tests for this knowledge graph.');
                          }
                        }}
                        variant="outline"
                        className="md-ripple"
                      >
                        <Clock className="w-4 h-4 mr-2" />
                        Schedule
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* OpenSearch Indices */}
            {openSearchIndices.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2 mt-6">
                  <Search className="w-4 h-4 text-orange-600" />
                  OpenSearch Indices ({openSearchIndices.length})
                </h4>
                {openSearchIndices.map((index, itemIndex) => (
                  <Card key={index.id || `opensearch-index-${index.name || itemIndex}`} className="bg-[rgb(var(--md-surface))] p-6 md-elevation-2">
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h4 className="font-semibold text-lg flex items-center gap-2">
                          <Search className="w-5 h-5 text-orange-600" />
                          {index.index_name}
                        </h4>
                        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          Type: {index.index_type} • {index.document_count || 0} documents
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleRunEvaluation('rag_index', { 
                          id: index.id, 
                          name: index.index_name,
                          type: 'opensearchindex'
                        })}
                        className="bg-teal-600 hover:bg-teal-700 text-white md-ripple"
                      >
                        <Play className="w-4 h-4 mr-2" />
                        Evaluate Index
                      </Button>
                      <Button
                        onClick={() => {
                      const existingEval = findScheduleSourceEvaluation('rag_index', index.id);
                          if (existingEval) {
                            handleScheduleEvaluation(existingEval);
                          } else {
                            alert('Please run at least one evaluation first before scheduling recurring tests for this index.');
                          }
                        }}
                        variant="outline"
                        className="md-ripple"
                      >
                        <Clock className="w-4 h-4 mr-2" />
                        Schedule
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {dataSources.length === 0 && knowledgeGraphs.length === 0 && openSearchIndices.length === 0 && (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                <Brain className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium mb-2">No RAG Systems Available</p>
                <p className="text-sm">Create data sources, knowledge graphs, or OpenSearch indices to evaluate RAG performance.</p>
              </div>
            )}
          </div>
        </TabsContent>


        <TabsContent value="results">
          <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2 mb-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                  Result source
                </p>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Choose the output index to inspect
                </p>
              </div>
              <RadioGroup
                value={resultsKind}
                onValueChange={setResultsKind}
                className="grid gap-2 sm:grid-cols-2"
              >
                <Label
                  htmlFor="results-kind-rag"
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    resultsKind === "rag"
                      ? "border-teal-400 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/30 dark:text-teal-100"
                      : "border-gray-200 bg-white/70 text-gray-700 dark:border-gray-800 dark:bg-gray-950/20 dark:text-gray-200"
                  }`}
                >
                  <RadioGroupItem id="results-kind-rag" value="rag" />
                  RAG Result
                </Label>
                <Label
                  htmlFor="results-kind-agent"
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    resultsKind === "agent"
                      ? "border-purple-400 bg-purple-50 text-purple-800 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-100"
                      : "border-gray-200 bg-white/70 text-gray-700 dark:border-gray-800 dark:bg-gray-950/20 dark:text-gray-200"
                  }`}
                >
                  <RadioGroupItem id="results-kind-agent" value="agent" />
                  Agent Evaluation
                </Label>
              </RadioGroup>
            </div>
            {resultsKind === "agent" && (
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                Showing case-level rows from <code>agent_eval_output</code>, grouped by agent and run id.
              </p>
            )}
          </Card>

          {resultsKind === "rag" && scheduledEvaluations.length ? (
            <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2 mb-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                    Scheduled evaluations
                  </p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {scheduledEvaluations.length} scheduled
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {scheduledEvaluations.slice(0, 5).map((evaluation, index) => (
                  <div
                    key={evaluation.id || `scheduled-evaluation-${evaluation.eval_run_id || evaluation.item_id || index}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-purple-200 dark:border-purple-800 bg-purple-50/70 dark:bg-purple-900/20 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-purple-900 dark:text-purple-200 truncate">
                        {evaluation.item_name || "Scheduled evaluation"}
                      </p>
                      <p className="text-[11px] text-purple-700 dark:text-purple-300 truncate">
                        {evaluation.schedule_config?.cron_expression
                          ? `${evaluation.schedule_config.cron_expression} (${evaluation.schedule_config.timezone || "UTC"})`
                          : "Schedule config"}
                      </p>
                    </div>
                    <div className="text-[11px] text-purple-700 dark:text-purple-300">
                      {(() => {
                        const nextRun =
                          evaluation.schedule_config?.next_run_at
                            ? new Date(evaluation.schedule_config.next_run_at)
                            : computeNextRunAtFromCron(evaluation.schedule_config?.cron_expression);
                        return nextRun && Number.isFinite(nextRun.getTime())
                          ? `Next: ${nextRun.toLocaleString()}`
                          : "Next: —";
                      })()}
                    </div>
                  </div>
                ))}
                {scheduledEvaluations.length > 5 ? (
                  <p className="text-[11px] text-gray-500 dark:text-gray-400">
                    Showing 5 of {scheduledEvaluations.length}. Use search/filter to find others.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}
          <Tabs value={resultsSubTab} onValueChange={setResultsSubTab} className="space-y-6">
            <TabsList className="grid w-full grid-cols-2 rounded-2xl border border-gray-200/80 bg-white/70 dark:bg-gray-900/60">
              <TabsTrigger value="graphs" className="text-sm font-semibold">
                Visuals
              </TabsTrigger>
              <TabsTrigger value="table" className="text-sm font-semibold">
                Details
              </TabsTrigger>
            </TabsList>

            <TabsContent value="graphs">
              <div className="space-y-6">
                {resultsKind === "agent" && (
                  <Card className="bg-[rgb(var(--md-surface))] p-4 md-elevation-2">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                          Agent visuals
                        </p>
                        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          Choose one agent to plot
                        </p>
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          Graphs below only use the selected agent id/name to keep rendering fast.
                        </p>
                      </div>
                      <div className="grid w-full gap-2 sm:grid-cols-[minmax(220px,300px)_minmax(260px,380px)] lg:w-auto">
                        <div>
                          <Label className="text-[11px] text-gray-500 dark:text-gray-400">
                            Type agent name or id
                          </Label>
                          <Input
                            value={agentVisualSearch}
                            onChange={(event) => setAgentVisualSearch(event.target.value)}
                            placeholder="Search agent..."
                            className="mt-1 h-9"
                          />
                        </div>
                        <div>
                          <Label className="text-[11px] text-gray-500 dark:text-gray-400">
                            Agent
                          </Label>
                          <Select
                            value={selectedAgentVisualKey}
                            onValueChange={setSelectedAgentVisualKey}
                            disabled={!agentVisualOptions.length}
                          >
                            <SelectTrigger className="mt-1 h-9">
                              <SelectValue placeholder="Select agent" />
                            </SelectTrigger>
                            <SelectContent>
                              {(() => {
                                const selectedOption = agentVisualOptions.find(
                                  (option) => option.key === selectedAgentVisualKey
                                );
                                const optionsToRender = [
                                  ...(selectedOption ? [selectedOption] : []),
                                  ...filteredAgentVisualOptions.filter(
                                    (option) => option.key !== selectedAgentVisualKey
                                  ),
                                ];
                                if (!optionsToRender.length) {
                                  return (
                                    <SelectItem value="__no_agent_match__" disabled>
                                      No matching agent
                                    </SelectItem>
                                  );
                                }
                                return optionsToRender.map((option) => (
                                  <SelectItem key={option.key} value={option.key}>
                                    {option.name} | {option.cases || 0} cases | {option.agentId}
                                  </SelectItem>
                                ));
                              })()}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </Card>
                )}
          <div className="mb-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                {resultsKind === "agent" ? "Success rate" : "Model scores"}
              </p>
              <p className="text-l font-semibold text-gray-900 dark:text-gray-100">
                {resultsKind === "agent" ? "Agent Success Rate by Day" : "Performance by Model Under Test"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setShowModelSeries((prev) => !prev)}
            >
              {showModelSeries ? "Collapse" : "Expand"}
            </Button>
          </div>
          {!showModelSeries ? null : (
            <div className="flex flex-wrap gap-2 items-center w-full">
              <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                Timeframe
              </p>
              {HISTOGRAM_TIMEFRAMES.map((timeframe) => {
                const isActive = timeframe.id === modelHistogramTimeframe;
                return (
                  <Button
                    key={`timeframe-model-${timeframe.id}`}
                    variant="outline"
                    className={`text-[11px] ${isActive ? "border-purple-500 bg-purple-50 text-purple-700" : ""}`}
                    onClick={() => setModelHistogramTimeframe(timeframe.id)}
                  >
                    {timeframe.label}
                  </Button>
                );
              })}
              {activeModelMeta && (
                <span className="text-[11px] text-gray-500 dark:text-gray-400 ml-auto">
                  {activeModelMeta.rangeLabel}
                </span>
              )}
            </div>
          )}
          {!showModelSeries ? null : modelDailySeriesData.length === 0 ? (
            <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {resultsKind === "agent"
                  ? "Run more agent evaluations so we can build day-wise score histories."
                  : "Run more evaluations so we can build score histories for each model under test."}
              </p>
            </Card>
          ) : activeModelSeriesData.length === 0 ? (
            <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                No runs found for the selected timeframe.
              </p>
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {activeModelSeriesData.map((series, index) => (
                <Card
                  key={series.model || `model-series-${index}`}
                  className="p-3 bg-[rgb(var(--md-surface))] border border-gray-100 dark:border-gray-800 shadow-none"
                >
                  <p className="text-[9px] uppercase tracking-[0.2em] text-gray-500">{series.model}</p>
                  <div className="w-full h-[220px] mt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={series.data}
                        margin={{ top: 8, right: 12, left: -10, bottom: 24 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis
                          dataKey="label"
                          interval={0}
                          tick={{ fontSize: 9, fill: "#475467" }}
                          angle={-45}
                          textAnchor="end"
                          height={38}
                        />
                        <YAxis
                          domain={[0, 1]}
                          tickFormatter={(value) =>
                            resultsKind === "agent" ? `${Math.round(Number(value) * 100)}%` : value.toFixed(2)
                          }
                          tickCount={5}
                          tick={{ fontSize: 10, fill: "#475467" }}
                        />
                        <RechartsTooltip
                          formatter={(value) =>
                            resultsKind === "agent"
                              ? [`${Math.round(Number(value) * 100)}%`, "Success rate"]
                              : Number(value).toFixed(3)
                          }
                          contentStyle={{ fontSize: "9px" }}
                        />
                        <Line
                          type="monotone"
                          stroke="#7c3aed"
                          dataKey="score"
                          strokeWidth={2}
                          dot={{ r: 3, stroke: "#7c3aed", strokeWidth: 2 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>


          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">Evaluation Metrics</p>
                <p className="text-l font-semibold text-gray-900 dark:text-gray-100">
                  {resultsKind === "agent" ? "Agent Evaluation Scores" : "Performance by Eval Scores"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setShowEvalScoreHistogram((prev) => !prev)}
              >
                {showEvalScoreHistogram ? "Collapse" : "Expand"}
              </Button>
            </div>
            {!showEvalScoreHistogram ? null : (
              <>
                <div className="flex flex-wrap gap-2 items-center w-full">
                  <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                    Timeframe
                  </p>
                  {HISTOGRAM_TIMEFRAMES.map((timeframe) => {
                    const isActive = timeframe.id === activeHistogramTimeframe;
                    return (
                      <Button
                        key={timeframe.id}
                        variant="outline"
                        className={`text-[11px] ${isActive ? "border-purple-500 bg-purple-50 text-purple-700" : ""}`}
                        onClick={() => setActiveHistogramTimeframe(timeframe.id)}
                      >
                        {timeframe.label}
                      </Button>
                    );
                  })}
                  {activeHistogramMeta && (
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 ml-auto">
                      {activeHistogramMeta.rangeLabel}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                    Metric filters
                  </p>
                  {histogramMetricOptions.map((metric) => {
                    const isSelected = selectedHistogramMetrics.includes(metric.id);
                    return (
                      <button
                        key={metric.id}
                        type="button"
                        onClick={() => {
                          setSelectedHistogramMetrics((prev) =>
                            prev.includes(metric.id)
                              ? prev.filter((id) => id !== metric.id)
                              : [...prev, metric.id]
                          );
                        }}
                        className={`px-3 py-1 text-[11px] rounded-full border ${
                          isSelected
                            ? "bg-purple-500 text-white border-transparent"
                            : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300"
                        }`}
                      >
                        {metric.name}
                      </button>
                    );
                  })}
                </div>
                {metricsToPlot.length > 0 && (
                  <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/40 p-3">
                    <p className="text-[10px] uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                      Score meanings
                    </p>
                    <div className="mt-2 grid gap-1.5 text-[11px] text-gray-600 dark:text-gray-300">
                      {metricsToPlot.map((metric) => (
                        <div key={`metric-meaning-${metric.id}`} className="flex items-start gap-2">
                          <span className="font-semibold text-gray-700 dark:text-gray-100">
                            {metric.name}:
                          </span>
                          <span>{metric.description || "No description available."}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {availableHistogramTimeframes.length === 0 ? (
                  <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Daily distributions appear once we have metrics across multiple runs.
                    </p>
                  </Card>
                ) : metricsToPlot.length === 0 ? (
                  <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Select at least one metric to render the histogram.
                    </p>
                  </Card>
                ) : (
                  <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                          {activeHistogramMeta ? activeHistogramMeta.rangeLabel : "Selected timeframe"}
                        </p>
                        <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                          {activeHistogramTimeframe && (
                            HISTOGRAM_TIMEFRAMES.find((tf) => tf.id === activeHistogramTimeframe)?.label || ""
                          )}
                        </p>
                        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                          {activeTimeframeStats?.totalRuns
                            ? `Avg across ${activeTimeframeStats.totalRuns} run${activeTimeframeStats.totalRuns === 1 ? "" : "s"}`
                            : "No runs available for this timeframe yet."}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                        {metricsToPlot.map((metric) => (
                          <span
                            key={`summary-${metric.id}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/60"
                          >
                            <span className="font-semibold text-gray-700 dark:text-gray-100">{metric.name}</span>
                            <span>{formatMetricAverageLabel(activeTimeframeStats?.averages?.[metric.id])}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    {activeHistogramRows.length ? (
                      <div className="h-[320px] mt-4">
                        <ResponsiveContainer width="100%" height="100%">
                          {isShortEvalScoreBarView ? (
                            <BarChart
                              data={activeHistogramRows}
                              margin={{ top: 8, right: 12, left: -10, bottom: 20 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                              <XAxis
                                dataKey="label"
                                interval={0}
                                tick={{ fontSize: 10, fill: "#475467" }}
                                angle={-45}
                                textAnchor="end"
                                height={38}
                              />
                              <YAxis
                                domain={[0, 100]}
                                tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                                tick={{ fontSize: 10, fill: "#475467" }}
                              />
                              <RechartsTooltip
                                formatter={(value) => `${Number(value).toFixed(1)}%`}
                                contentStyle={{ fontSize: "10px" }}
                              />
                              <Legend wrapperStyle={{ fontSize: "11px" }} />
                              {metricsToPlot.map((metric) => (
                                <Bar
                                  key={`line-${metric.id}`}
                                  dataKey={metric.id}
                                  name={metric.name}
                                  fill={metric.chartColor}
                                  radius={[4, 4, 0, 0]}
                                />
                              ))}
                            </BarChart>
                          ) : (
                            <LineChart
                              data={activeHistogramRows}
                              margin={{ top: 8, right: 12, left: -10, bottom: 20 }}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                              <XAxis
                                dataKey="label"
                                interval={0}
                                tick={{ fontSize: 10, fill: "#475467" }}
                                angle={-45}
                                textAnchor="end"
                                height={38}
                              />
                              <YAxis
                                domain={[0, 100]}
                                tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                                tick={{ fontSize: 10, fill: "#475467" }}
                              />
                              <RechartsTooltip
                                formatter={(value) => `${Number(value).toFixed(1)}%`}
                                contentStyle={{ fontSize: "10px" }}
                              />
                              <Legend wrapperStyle={{ fontSize: "11px" }} />
                              {metricsToPlot.map((metric) => (
                                <Line
                                  key={`line-${metric.id}`}
                                  type="monotone"
                                  dataKey={metric.id}
                                  name={metric.name}
                                  stroke={metric.chartColor}
                                  strokeWidth={2}
                                  dot={{ r: 2 }}
                                />
                              ))}
                            </LineChart>
                          )}
                        </ResponsiveContainer>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
                        Daily average trend will appear once at least two runs exist for this timeframe.
                      </p>
                    )}
                  </Card>
                )}
              </>
            )}
          </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                        Time taken
                      </p>
                      <p className="text-l font-semibold text-gray-900 dark:text-gray-100">
                        {resultsKind === "agent" ? "Agent vs Human Time Per Day" : "Avg Response Time Per Day"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {!showResponseTimeHistogram ? null : (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Calculated from the same runs shown in the graph view.
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => setShowResponseTimeHistogram((prev) => !prev)}
                      >
                        {showResponseTimeHistogram ? "Collapse" : "Expand"}
                      </Button>
                    </div>
                  </div>
                  {!showResponseTimeHistogram ? null : (
                    <>
                      <div className="flex flex-wrap gap-2 items-center">
                        <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                          Timeframe
                        </p>
                        {HISTOGRAM_TIMEFRAMES.map((timeframe) => {
                          const isActive = timeframe.id === timeHistogramTimeframe;
                          return (
                            <Button
                              key={`timeframe-time-${timeframe.id}`}
                              variant="outline"
                              className={`text-[11px] ${isActive ? "border-purple-500 bg-purple-50 text-purple-700" : ""}`}
                              onClick={() => setTimeHistogramTimeframe(timeframe.id)}
                            >
                              {timeframe.label}
                            </Button>
                          );
                        })}
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                        {HISTOGRAM_TIMEFRAMES.map((timeframe) => {
                          const stats = timeframeResponseTimeAverages.get(timeframe.id);
                          return (
                            <Card
                              key={`timeframe-avg-${timeframe.id}`}
                              className="p-3 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800"
                            >
                              <p className="text-[10px] uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                                {timeframe.label}
                              </p>
                              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 mt-1">
                                {formatDurationLabel(stats?.averageMs)}
                              </p>
                              <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                {stats?.count ? `${stats.count} run${stats.count === 1 ? "" : "s"}` : "No runs"}
                              </p>
                              {resultsKind === "agent" && Number.isFinite(stats?.averageHumanMs) && (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                  Human {formatDurationLabel(stats.averageHumanMs)}
                                </p>
                              )}
                            </Card>
                          );
                        })}
                      </div>
                      {activeResponseTimeData.length === 0 ? (
                        <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            Daily time taken averages appear once we have recorded timing data for the selected timeframe.
                          </p>
                        </Card>
                      ) : (
                        <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                          <div className="h-[220px]">
	                            <ResponsiveContainer width="100%" height="100%">
	                              <LineChart
	                                data={activeResponseTimeData}
	                                margin={{ top: 8, right: 18, left: -6, bottom: 20 }}
	                              >
	                                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
	                                <XAxis
	                                  dataKey="label"
                                  interval={0}
                                  tick={{ fontSize: 10, fill: "#475467" }}
                                  angle={-45}
                                  textAnchor="end"
	                                  height={38}
	                                />
	                                <YAxis
	                                  domain={[0, (dataMax) => Math.max(Number(dataMax) || 0, 1)]}
	                                  tickFormatter={(value) => `${Number(value).toFixed(0)}s`}
	                                  tick={{ fontSize: 10, fill: "#475467" }}
	                                />
	                                <Legend wrapperStyle={{ fontSize: "11px" }} />
                                <RechartsTooltip
                                  content={({ active, payload }) => {
                                    if (!active || !payload?.length) return null;
	                                    const row = payload[0]?.payload;
	                                    const runs = Number.isFinite(row?.runs) ? row.runs : null;
	                                    const hasData = Boolean(runs);
	                                    return (
                                      <div className="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 shadow-sm">
                                        <div className="font-semibold text-gray-900 dark:text-gray-100">
                                          {row?.rawDate ?? row?.label ?? ""}
	                                        </div>
	                                        <div>
	                                          Agent:{" "}
	                                          {hasData && Number.isFinite(row?.agentSeconds)
	                                            ? `${Number(row.agentSeconds).toFixed(2)}s`
	                                            : "— (no data)"}
	                                        </div>
	                                        {resultsKind === "agent" && (
	                                          <>
	                                            <div>
	                                              Human:{" "}
	                                              {hasData && Number.isFinite(row?.humanSeconds)
	                                                ? `${Number(row.humanSeconds).toFixed(2)}s`
	                                                : "—"}
	                                            </div>
	                                            <div>
	                                              Saved:{" "}
	                                              {hasData && Number.isFinite(row?.savedSeconds)
	                                                ? `${Number(row.savedSeconds).toFixed(2)}s`
	                                                : "—"}
	                                            </div>
	                                          </>
	                                        )}
	                                        <div>Runs: {runs ?? "—"}</div>
	                                      </div>
                                    );
	                                  }}
	                                />
	                                {resultsKind === "agent" && (
	                                  <Line
	                                    type="monotone"
	                                    dataKey="humanSeconds"
	                                    name="Human baseline"
	                                    stroke="#0ea5e9"
	                                    strokeWidth={2}
	                                    connectNulls={false}
	                                    dot={{ r: 3, strokeWidth: 2 }}
	                                  />
	                                )}
	                                <Line
	                                  type="monotone"
	                                  dataKey="agentSeconds"
	                                  name={resultsKind === "agent" ? "Agent time" : "Response time"}
	                                  stroke="#5b21b6"
	                                  strokeWidth={2}
	                                  connectNulls={false}
	                                  dot={{ r: 3, strokeWidth: 2 }}
	                                />
	                                {resultsKind === "agent" && (
	                                  <Line
	                                    type="monotone"
	                                    dataKey="savedSeconds"
	                                    name="Time saved"
	                                    stroke="#16a34a"
	                                    strokeWidth={2}
	                                    connectNulls={false}
	                                    dot={{ r: 3, strokeWidth: 2 }}
	                                  />
	                                )}
	                              </LineChart>
	                            </ResponsiveContainer>
                          </div>
                          <p className="text-xs text-gray-500 mt-3">
                            {resultsKind === "agent"
                              ? `Daily agent runtime compared with human baseline over ${activeTimeRangeLabel ?? "the selected timeframe"}.`
                              : `Daily average response time over ${activeTimeRangeLabel ?? "the selected timeframe"}.`}
                          </p>
                        </Card>
                      )}
                    </>
                  )}
                </div>

                {!showResponseTimeHistogram ? null : (
                  <Card className="p-4 bg-[rgb(var(--md-surface))] border border-gray-200 dark:border-gray-800">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-gray-400 dark:text-gray-500">
                          Avg response time
                        </p>
                        <p className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
                          {formatDurationLabel(averageResponseTimeMs)}
                        </p>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Calculated over the selected timeframe.
                      </p>
                    </div>
                  </Card>
                )}
              </div>
            </TabsContent>

            <TabsContent value="table">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <Clock className="w-5 h-5 text-blue-600" />
            {resultsKind === "agent"
              ? resultsRange === "30d"
                ? "Agent Evaluation Results (Last 30 Days)"
                : "Recent Agent Evaluations"
              : resultsRange === "30d"
                ? "Evaluation Results (Last 30 Days)"
                : "Recent Evaluations"}
          </h3>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-gray-600 dark:text-gray-400">View</Label>
            <Select value={resultsRange} onValueChange={setResultsRange}>
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Most recent (10)</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <ScrollArea className="h-[640px] pr-2">
            <div className="space-y-3 pr-4">
              {displayedEvaluations.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                  <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>
                    {resultsRange === "30d"
                      ? resultsKind === "agent"
                        ? "No agent evaluation cases in the last 30 days."
                        : "No evaluations in the last 30 days."
                      : resultsKind === "agent"
                        ? "No agent evaluation cases yet."
                        : "No evaluations yet. Run your first DeepEval test!"}
                  </p>
                </div>
              ) : (
                displayedEvaluations.map((evaluation, index) => {
                const normalizedStatus = String(evaluation.status || "completed").toLowerCase();
                const isAgentEvaluation = evaluation.evaluation_type === "agent";
                const isAgentOutputRow = String(evaluation.id || "").startsWith("agent-output:");
                const agentSummary = isAgentEvaluation ? getAgentEvalSummary(evaluation) : {};
                const hasAgentSummary = isAgentEvaluation && Object.keys(agentSummary).length > 0;
                const agentCompletedRunCount = isAgentEvaluation
                  ? displayedEvaluations.filter(
                      (item) =>
                        item.evaluation_type === "agent" &&
                        item.item_id === evaluation.item_id &&
                        String(item.status || "").toLowerCase() === "completed"
                    ).length
                  : null;
                const isRunning = isEvaluationRecordInProgress(evaluation);
                const deepEvalRaw = evaluation.eval_overall_status || evaluation.eval_status;
                const deepEvalNormalized = deepEvalRaw ? String(deepEvalRaw).toLowerCase() : "";
                const hasResults =
                  !isRunning &&
                  (Boolean(evaluation.eval_results_found) ||
                    (evaluation.deepeval_metrics && Object.keys(evaluation.deepeval_metrics).length > 0) ||
                    (evaluation.eval_summary?.avg_scores &&
                      Object.keys(evaluation.eval_summary.avg_scores).length > 0) ||
                    hasAgentSummary ||
                    (evaluation.eval_api_response &&
                      typeof evaluation.eval_api_response === "object" &&
                      Object.keys(extractMetricDetailsFromResponse(evaluation.eval_api_response)).length > 0));
                const isJobFailed = ["failed", "error"].includes(normalizedStatus) && !hasResults;
                const thresholdForOutcome = Number(evaluation?.overall_threshold_value ?? 0.8);
                const localMetricDetailsForOutcome = getEvaluationMetricDetails(evaluation);
                const remoteMetricDetailsForOutcome = reasoningByEvaluationId[evaluation.id] || null;
                if (remoteMetricDetailsForOutcome) {
                  Object.entries(remoteMetricDetailsForOutcome).forEach(([metricId, result]) => {
                    mergeMetricResult(localMetricDetailsForOutcome, metricId, result);
                  });
                }
                const { combinedScore: combinedOutcomeScore } =
                  computeQualityRiskScores(localMetricDetailsForOutcome);
                const computedPassedByScore =
                  !isAgentOutputRow &&
                  hasResults &&
                  Number.isFinite(combinedOutcomeScore) &&
                  Number.isFinite(thresholdForOutcome)
                    ? combinedOutcomeScore >= thresholdForOutcome
                    : null;
                const computedPassed =
                  computedPassedByScore !== null
                    ? computedPassedByScore
                    : typeof evaluation.passed === "boolean"
                      ? evaluation.passed
                      : null;
                const isDeepEvalPass = ["pass", "passed", "success"].includes(deepEvalNormalized);
                const isDeepEvalFail = ["fail", "failed", "error"].includes(deepEvalNormalized);
                const isDeepEvalPending = isRunning || !hasResults || deepEvalNormalized === "processing";
                const deepEvalStatusLabel = isAgentEvaluation
                  ? ""
                  : isDeepEvalPending
                    ? "Pending"
                    : computedPassed === true
                    ? "Pass"
                    : computedPassed === false && hasResults
                      ? "Fail"
                      : isDeepEvalFail
                        ? "Fail"
                        : isDeepEvalPass
                          ? "Pass"
                          : "";
                const deepEvalBadgeClass =
                  deepEvalStatusLabel === "Fail"
                    ? "bg-red-100 text-red-700"
                    : deepEvalStatusLabel === "Pass"
                      ? "bg-green-100 text-green-700"
                      : deepEvalStatusLabel === "Pending"
                        ? "bg-amber-100 text-amber-800"
                      : "bg-gray-100 text-gray-700";
                const jobBadgeClass = isRunning
                  ? "bg-blue-100 text-blue-700"
                  : isJobFailed
                    ? "bg-red-100 text-red-700"
                    : "bg-gray-100 text-gray-700";

	                const startedAtValue = resolveEvaluationValue(evaluation, [
	                  "started_at",
	                  "eval_api_response.started_at",
	                  "eval_api_response.created_at",
	                  "created_date",
	                ]);
	                const endedAtValue = resolveEvaluationValue(evaluation, [
	                  "ended_at",
	                  "finished_at",
	                  "completed_at",
	                  "eval_api_response.ended_at",
	                  "eval_api_response.finished_at",
	                  "eval_api_response.completed_at",
	                  "eval_api_response.updated_at",
	                  "updated_date",
	                ]);
	                const formattedStartedAt = formatEvaluationDate(startedAtValue);
	                const formattedEndedAt = formatEvaluationDate(endedAtValue);
	                const modelUnderTestValue = resolveEvaluationValue(evaluation, [
	                  "model_under_test",
	                  "eval_api_response.model_under_test",
	                ]);
                const modelUnderTestFrameworkValue = resolveEvaluationValue(evaluation, [
                  "model_under_test_framework",
                  "eval_api_response.model_under_test_framework",
                ]);
                const deepevalModelValue = resolveEvaluationValue(evaluation, [
                  "deepeval_metrics_model",
                  "eval_api_response.deepeval_metrics_model",
                ]);
                const goldenModelValue = resolveEvaluationValue(evaluation, [
                  "golden_truth_model",
                  "eval_api_response.golden_truth_model",
                ]);
                const evalInputModeForDetails = resolveEvaluationValue(evaluation, [
                  "eval_input_mode",
                  "eval_api_response.eval_input_mode",
                ]);
                const hideGoldenModelForDataset =
                  Boolean(String(evaluation?.eval_index_name || "").trim()) ||
                  ["csv_upload", "index_name"].includes(String(evalInputModeForDetails || "").toLowerCase());
                const overallThresholdRaw = evaluation?.overall_threshold_value ?? 0.8;
                const overallThresholdNumeric = Number(overallThresholdRaw);
                const overallThresholdDisplay = Number.isFinite(overallThresholdNumeric)
                  ? overallThresholdNumeric.toFixed(2)
                  : "0.80";
                const underTestDisplay = modelUnderTestValue
                  ? `${modelUnderTestValue}${
                      modelUnderTestFrameworkValue ? ` (${modelUnderTestFrameworkValue})` : ""
                    }`
                  : null;
                const evalApiResponseObject =
                  evaluation.eval_api_response && typeof evaluation.eval_api_response === "object"
                    ? evaluation.eval_api_response
                    : null;
                const isEvalOutputDuplicateText =
                  typeof evaluation.actual_output === "string" &&
                  typeof evaluation.eval_api_response === "string" &&
                  evaluation.actual_output.trim() === evaluation.eval_api_response.trim();
                const showEvalResponseDetails =
                  evalApiResponseObject &&
                  !isRunning &&
                  !isEvalOutputDuplicateText;
                const metricDetails = getEvaluationMetricDetails(evaluation);
                const remoteMetricDetails = reasoningByEvaluationId[evaluation.id] || null;
                if (remoteMetricDetails) {
                  Object.entries(remoteMetricDetails).forEach(([metricId, result]) => {
                    mergeMetricResult(metricDetails, metricId, result);
                  });
                }
                const { qualityScore, riskScore, combinedScore } = computeQualityRiskScores(metricDetails);
                const qualityMetricNames = DEEPEVAL_METRICS
                  .filter((metric) => !metric.inverse)
                  .map((metric) => metric.name)
                  .join(", ");
                const riskMetricNames = DEEPEVAL_METRICS
                  .filter((metric) => metric.inverse)
                  .map((metric) => metric.name)
                  .join(", ");
	                const hasMetricDetails = !isRunning && !isAgentEvaluation && Object.keys(metricDetails).length > 0;
                const missingDownloads =
                  !evaluation?.eval_download_urls ||
                  (typeof evaluation.eval_download_urls === "object" &&
                    Object.keys(evaluation.eval_download_urls).length === 0);
	                const hasRefreshableResultsUrl = Boolean(
	                  (evaluation?.eval_status_url || evaluation?.status_url || evaluation?.eval_results_url) &&
        !isRunning
	                );
		                const hasAnyResults =
		                  !isRunning &&
		                  (hasMetricDetails ||
		                    hasAgentSummary ||
		                    Boolean(evaluation?.eval_results_found) ||
		                    (evaluation?.eval_summary?.avg_scores &&
		                      Object.keys(evaluation.eval_summary.avg_scores).length > 0));
	                const isReasoningLoading = Boolean(reasoningLoadingByEvaluationId[evaluation.id]);
	                const executionTimeMs = resolveExecutionTimeMs(evaluation);
	                const runtimeLabel = formatDurationLabel(executionTimeMs);

	                return (
	                  <Card
	                    key={evaluation.id || `evaluation-${evaluation.eval_run_id || evaluation.item_id || index}`}
	                    className="group relative overflow-hidden rounded-2xl border border-gray-200/70 dark:border-gray-800 bg-white/80 dark:bg-gray-900/40 backdrop-blur p-4 shadow-sm transition-shadow hover:shadow-md"
	                  >
	                    <div className="flex items-start justify-between gap-3">
	                      <button
	                        type="button"
	                        className="flex-1 text-left outline-none"
	                      >
	                        <div className="flex items-start justify-between gap-3">
	                          <div className="min-w-0 flex-1">
	                            <div className="flex items-center gap-2">
	                              {evaluation.evaluation_type === "tool" && <Package className="w-4 h-4 text-blue-600" />}
	                              {evaluation.evaluation_type === "agent" && <Bot className="w-4 h-4 text-purple-600" />}
	                              {evaluation.evaluation_type === "workflow" && (
	                                <WorkflowIcon className="w-4 h-4 text-teal-600" />
	                              )}
	                              {evaluation.evaluation_type === "rag_system" && (
	                                <Brain className="w-4 h-4 text-teal-600" />
	                              )}
	                              {evaluation.evaluation_type === "rag_datasource" && (
	                                <Database className="w-4 h-4 text-blue-600" />
	                              )}
	                              {evaluation.evaluation_type === "rag_graph" && (
	                                <Network className="w-4 h-4 text-purple-600" />
	                              )}
	                              {evaluation.evaluation_type === "rag_index" && (
	                                <Search className="w-4 h-4 text-orange-600" />
	                              )}
	                              <span className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
	                                {evaluation.item_name || "Evaluation"}
	                              </span>
	                            </div>
	                          </div>
	                        </div>

	                        <div className="mt-2 flex flex-wrap items-center gap-2">
	                          {isRunning ? (
	                            <Badge
	                              variant="secondary"
	                              className={`${jobBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
	                            >
	                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
	                              Running
	                            </Badge>
	                          ) : (
	                            <Badge
	                              variant="secondary"
	                              className={`${jobBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
	                            >
	                              {isJobFailed ? (
	                                <XCircle className="w-3 h-3 mr-1" />
	                              ) : (
	                                <CheckCircle2 className="w-3 h-3 mr-1" />
	                              )}
	                              {isJobFailed ? "Job Failed" : "Completed"}
	                            </Badge>
	                          )}
	                          {deepEvalStatusLabel && (
	                            <Badge
	                              variant="secondary"
	                              className={`${deepEvalBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
	                            >
	                              {deepEvalStatusLabel === "Fail" ? (
	                                <XCircle className="w-3 h-3 mr-1" />
	                              ) : (
	                                <CheckCircle2 className="w-3 h-3 mr-1" />
	                              )}
	                              {deepEvalStatusLabel}
	                            </Badge>
	                          )}
	                          <span className="whitespace-nowrap inline-flex items-center gap-1 rounded-full border border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-950/40 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300">
	                            <PlayCircle className="w-3 h-3 text-gray-400" />
	                            <span className="uppercase tracking-wide text-[10px] text-gray-500 dark:text-gray-400">
	                              Start
	                            </span>
	                            <span className="font-semibold text-gray-800 dark:text-gray-100">
	                              {formattedStartedAt || "—"}
	                            </span>
	                          </span>
	                          <span className="whitespace-nowrap inline-flex items-center gap-1 rounded-full border border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-950/40 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300">
	                            {isJobFailed ? (
	                              <XCircle className="w-3 h-3 text-red-500" />
	                            ) : (
	                              <CheckCircle2 className="w-3 h-3 text-green-600" />
	                            )}
	                            <span className="uppercase tracking-wide text-[10px] text-gray-500 dark:text-gray-400">
	                              End
	                            </span>
	                            <span className="font-semibold text-gray-800 dark:text-gray-100">
	                              {formattedEndedAt || "—"}
	                            </span>
	                          </span>
	                          <span className="whitespace-nowrap inline-flex items-center gap-1 rounded-full border border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-950/40 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300">
	                            <Clock className="w-3 h-3" />
	                            <span className="uppercase tracking-wide text-[10px] text-gray-500 dark:text-gray-400">
	                              Avg Response Time
	                            </span>
	                            <span className="font-semibold text-gray-800 dark:text-gray-100">{runtimeLabel}</span>
	                          </span>
	                        </div>
	                      </button>
	                      <div className="flex items-center gap-1">
	                        <TooltipProvider delayDuration={0}>
		                          <UiTooltip>
		                            <TooltipTrigger asChild>
		                              <Button
		                                type="button"
		                                variant="ghost"
		                                className="h-8 w-8 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
		                                onClick={() => openDetailsModal(evaluation)}
		                                aria-label="View details"
		                              >
		                                <Eye className="w-4 h-4" />
		                              </Button>
		                            </TooltipTrigger>
		                            <TooltipContent className="text-xs">
		                              View Details
		                            </TooltipContent>
		                          </UiTooltip>

                            {!isAgentOutputRow && (
	                            <UiTooltip>
	                              <TooltipTrigger asChild>
	                                <Button
	                                  type="button"
	                                  variant="ghost"
	                                  className="h-8 w-8 rounded-full text-gray-500 hover:text-red-600 hover:bg-red-100/70 dark:hover:bg-red-900/20"
	                                  onClick={() => {
	                                    setEvaluationToDelete(evaluation);
	                                    setShowDeleteDialog(true);
	                                  }}
	                                  aria-label="Delete evaluation"
	                                  disabled={deleteEvaluationMutation.isLoading && evaluationToDelete?.id === evaluation.id}
	                                >
	                                  <Trash2 className="w-4 h-4" />
	                                </Button>
	                              </TooltipTrigger>
	                              <TooltipContent className="text-xs">
	                                Delete
	                              </TooltipContent>
	                            </UiTooltip>
                            )}
	                        </TooltipProvider>
	                      </div>
	                    </div>
                    {isAgentEvaluation && hasAgentSummary && !isRunning && (
                      <AgentEvaluationSummaryCard
                        evaluation={evaluation}
                        completedRunCount={agentCompletedRunCount}
                        compact
                      />
                    )}
                    {isAgentEvaluation && Array.isArray(evaluation.eval_api_response?.case_rows) && (
                      <AgentEvalCasesList cases={evaluation.eval_api_response.case_rows} />
                    )}
                    {false && (
                      <div className="mt-3">
                        {String(evaluation.evaluation_type || "").startsWith("rag_") && (
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            {evaluation.eval_index_name ? `Eval Index: ${evaluation.eval_index_name}` : null}
                            {evaluation.eval_username ? ` • User: ${evaluation.eval_username}` : null}
                            {evaluation.eval_run_id ? ` • Run: ${evaluation.eval_run_id}` : null}
                          </div>
                        )}

                        <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
                          {evaluation.test_scenario}
                        </p>
                        {(underTestDisplay || deepevalModelValue || (goldenModelValue && !hideGoldenModelForDataset)) && (
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-2">
                            {underTestDisplay && (
                              <div className="rounded border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900/60 p-3">
                                <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
                                  Model Under Test
                                </p>
                                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                                  {underTestDisplay}
                                </p>
                              </div>
                            )}
                            {deepevalModelValue && (
                              <div className="rounded border border-dashed border-blue-200 dark:border-blue-800 bg-blue-50/80 dark:bg-blue-900/30 p-3">
                                <p className="text-[10px] uppercase tracking-wide text-blue-600 dark:text-blue-200 mb-1">
                                  Eval Model
                                </p>
                                <p className="text-sm font-semibold text-blue-900 dark:text-blue-50">
                                  {deepevalModelValue}
                                </p>
                              </div>
                            )}
                            {goldenModelValue && !hideGoldenModelForDataset && (
                              <div className="rounded border border-dashed border-amber-200 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-900/30 p-3">
                                <p className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-200 mb-1">
                                  Golden Model
                                </p>
                                <p className="text-sm font-semibold text-amber-900 dark:text-amber-50">
                                  {goldenModelValue}
                                </p>
                              </div>
                            )}
                          </div>
                        )}

	                        {!isRunning && (hasMetricDetails || evaluation.overall_score !== undefined) && (() => {
                          const overallNumeric = Number.isFinite(combinedScore)
                            ? Number(combinedScore)
                            : Number.isFinite(qualityScore)
                              ? Number(qualityScore)
                              : NaN;
                          const passFail =
                            Number.isFinite(overallNumeric) && Number.isFinite(overallThresholdNumeric)
                              ? overallNumeric >= overallThresholdNumeric
                              : null;
                          const passPill = passFail === true
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200"
                            : passFail === false
                              ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-900/20 dark:text-rose-200"
                              : "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200";

                          return (
                            <div className="mt-3 space-y-3">
			                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                <div className="rounded-xl border border-purple-200/70 dark:border-purple-900/40 bg-purple-50/60 dark:bg-purple-950/20 p-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-2">
                                      <Sparkles className="w-4 h-4 text-purple-600" />
                                      <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                        Overall
                                      </p>
                                    </div>
                                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${passPill}`}>
                                      {passFail === true ? "Pass" : passFail === false ? "Below threshold" : "—"}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex items-end justify-between gap-2">
                                    <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                                      {formatMetricScore(overallNumeric)}
                                    </p>
                                    <TooltipProvider>
                                      <UiTooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="text-gray-400 hover:text-gray-600"
                                            aria-label="Overall score info"
                                            onClick={(event) => event.stopPropagation()}
                                          >
                                            <Info className="w-3 h-3" />
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-[280px] text-xs">
                                          Overall quality (with safety). Threshold: {overallThresholdDisplay}
                                        </TooltipContent>
                                      </UiTooltip>
                                    </TooltipProvider>
                                  </div>
                                  <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                    Threshold {overallThresholdDisplay}
                                  </p>
                                </div>

                                <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-950/15 p-3">
                                  <div className="flex items-center gap-2">
                                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                                    <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                      Quality
                                    </p>
                                    <TooltipProvider>
                                      <UiTooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="ml-auto text-gray-400 hover:text-gray-600"
                                            aria-label="Quality score metrics info"
                                            onClick={(event) => event.stopPropagation()}
                                          >
                                            <Info className="w-3 h-3" />
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-[320px] text-xs">
                                          Average of: {qualityMetricNames}
                                        </TooltipContent>
                                      </UiTooltip>
                                    </TooltipProvider>
                                  </div>
                                  <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                                    {formatMetricScore(qualityScore)}
                                  </p>
                                  <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                    Higher is better
                                  </p>
                                </div>

                                <div className="rounded-xl border border-amber-200/70 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-950/15 p-3">
                                  <div className="flex items-center gap-2">
                                    <Shield className="w-4 h-4 text-orange-600" />
                                    <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                      Safety Risk
                                    </p>
                                    <TooltipProvider>
                                      <UiTooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="ml-auto text-gray-400 hover:text-gray-600"
                                            aria-label="Risk score metrics info"
                                            onClick={(event) => event.stopPropagation()}
                                          >
                                            <Info className="w-3 h-3" />
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-[340px] text-xs">
                                          Safety checks averaged (lower is better): {riskMetricNames}
                                        </TooltipContent>
                                      </UiTooltip>
                                    </TooltipProvider>
                                  </div>
                                  <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                                    {formatMetricScore(riskScore)}
                                  </p>
                                  <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                                    Lower is better
                                  </p>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {hasMetricDetails && (
                          <div className="mt-3 rounded-xl border border-gray-200/70 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-950/20 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <ClipboardList className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                                  Metrics
                                </p>
                              </div>
                              {isReasoningLoading && (
                                <span className="text-[11px] text-gray-400 dark:text-gray-500">
                                  Fetching reasoning…
                                </span>
                              )}
                            </div>

                            <div className="mt-2 space-y-2">
                              {(() => {
                                const orderedIds = [
                                  ...DEEPEVAL_METRICS.map((m) => m.id),
                                  ...Object.keys(metricDetails).filter(
                                    (id) => !DEEPEVAL_METRICS.some((m) => m.id === id)
                                  ),
                                ];
                                const uniqueOrdered = Array.from(new Set(orderedIds)).filter(
                                  (id) => metricDetails[id]
                                );
                                return uniqueOrdered.map((metricId) => {
                                  const result = metricDetails[metricId] || {};
                                  const metric = DEEPEVAL_METRICS.find((m) => m.id === metricId);
                                  const Icon = metric?.icon || Target;
                                  const scoreNumeric = Number(result.score);
                                  const remoteEntry = remoteMetricDetails?.[metricId];
                                  const shouldHideScore =
                                    remoteEntry?.reason &&
                                    !Number.isFinite(Number(remoteEntry?.score));
                                  const showScore = Number.isFinite(scoreNumeric) && !shouldHideScore;
                                  const health = getMetricHealth(metric, scoreNumeric);
                                  const scorePillClasses = getHealthPillClasses(health);
                                  const barPct = showScore ? clamp01(scoreNumeric) * 100 : 0;

                                  return (
                                    <div
                                      key={metricId}
                                      className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-white/70 dark:bg-gray-900/30 p-2"
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-2">
                                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200">
                                              <Icon className="w-4 h-4" />
                                            </span>
		                                            <div className="min-w-0">
		                                              <p
		                                                className="text-[12px] font-semibold text-gray-900 dark:text-gray-100 line-clamp-2"
		                                                title={metric?.name || metricId}
		                                              >
		                                                {metric?.name || metricId}
		                                              </p>
                                              {metric?.description && (
                                                <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">
                                                  {metric.description}
                                                </p>
                                              )}
                                            </div>
                                          </div>
                                        </div>

                                        <div className="flex flex-col items-end gap-1">
                                          <span
                                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${scorePillClasses}`}
                                            title={metric?.threshold != null ? `Threshold ${metric.threshold}` : undefined}
                                          >
                                            {showScore ? formatMetricScore(scoreNumeric) : "—"}
                                          </span>
                                          {showScore && (
                                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                                              <div
                                                className={`h-full ${health === false ? "bg-rose-500" : "bg-emerald-500"}`}
                                                style={{ width: `${barPct}%` }}
                                              />
                                            </div>
                                          )}
                                        </div>
                                      </div>

                                      {result.reason && (
                                        <details className="mt-2">
                                          <summary className="cursor-pointer text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                                            Why this score
                                          </summary>
                                          <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
                                            {String(result.reason)}
                                          </p>
                                        </details>
                                      )}
                                    </div>
                                  );
                                });
                              })()}
                            </div>

                          </div>
                        )}

                        {!isRunning && !hasAnyResults && (
                          <p className="text-xs uppercase text-orange-500 font-semibold mt-2 tracking-wide">
                            {missingDownloads && hasRefreshableResultsUrl
                              ? "RESULTS PENDING (REFRESH LINKS)"
                              : "RESULTS NOT FOUND"}
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          {[
                            {
                              key: "eval_csv",
                              label: "Download Eval CSV",
                              borderClass: "border-blue-200 hover:bg-blue-50 text-blue-600",
                            },
                            {
                              key: "rag_csv",
                              label: "Download RAG CSV",
                              borderClass: "border-teal-200 hover:bg-teal-50 text-teal-600",
                            },
                          ].map((link) => {
                            const url = resolveUrl(evaluation.eval_download_urls?.[link.key]);
                            const isReady = Boolean(url) && !isRunning;
                            const baseClass = `inline-flex items-center px-2 py-1 rounded border ${link.borderClass}`;
                            return isReady && url ? (
                              <a
                                key={link.key}
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className={`${baseClass}`}
                                onClick={(event) => event.stopPropagation()}
                              >
                                {link.label}
                              </a>
                            ) : (
                              <span
                                key={link.key}
                                className="inline-flex items-center px-2 py-1 rounded border border-gray-200 text-gray-400 cursor-not-allowed opacity-50"
                              >
                                {link.label}
                              </span>
                            );
                          })}
                          <TooltipProvider>
                            <UiTooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  className="h-7 w-7 p-0"
                                  aria-label="Refresh download links"
                                  disabled={isRunning || refreshDownloadMutation.isPending}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    refreshDownloadMutation.mutate(evaluation);
                                  }}
                                >
                                  <RefreshCw
                                    className={`w-4 h-4 ${refreshDownloadMutation.isPending ? "animate-spin" : ""}`}
                                  />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">
                                Refresh download links
                              </TooltipContent>
                            </UiTooltip>
                          </TooltipProvider>
                        </div>

                        {(() => {
                          if (!evaluation.actual_output) return null;
                          const detailsLabel =
                            evaluation.status === "failed" && !hasAnyResults
                              ? "Failure Details"
                              : "View Output & Details";
                          return (
                            <details className="mt-2" onClick={(event) => event.stopPropagation()}>
                              <summary className="text-xs text-purple-600 dark:text-purple-400 cursor-pointer hover:underline">
                                {detailsLabel}
                              </summary>
                              <pre className="text-xs bg-white dark:bg-gray-900 p-2 rounded mt-2 whitespace-pre-wrap">
                                {evaluation.actual_output}
                              </pre>
                              {showEvalResponseDetails && (
                                <pre className="text-[10px] bg-gray-100 dark:bg-gray-900/20 p-2 rounded mt-2 whitespace-pre-wrap">
                                  {JSON.stringify(evalApiResponseObject, null, 2)}
                                </pre>
                              )}
                            </details>
                          );
                        })()}

                        {evaluation.schedule_config?.enabled && (
                          <div className="mt-3 p-2 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-200 dark:border-purple-800">
                            <p className="text-xs text-purple-900 dark:text-purple-200 flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              Scheduled: {evaluation.schedule_config.cron_expression} ({evaluation.schedule_config.timezone})
                            </p>
                            {evaluation.schedule_config.next_run_at && (
                              <p className="text-xs text-purple-700 dark:text-purple-300 mt-1">
                                Next run: {new Date(evaluation.schedule_config.next_run_at).toLocaleString()}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    </Card>
                  );
                })
              )}
            </div>
          </ScrollArea>

            </TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
      {/* Evaluation Dialog - gathers inputs for a single run */}
      <Dialog
        open={showEvaluationDialog}
        onOpenChange={(open) => {
          setShowEvaluationDialog(open);
          if (!open) {
            setScheduleConfigEditMode(false);
            setScheduleConfigSource(null);
            setOpenEvaluationSections([]);
          }
        }}
      >
        <DialogContent className="flex w-[calc(100vw-1.5rem)] max-w-[720px] max-h-[88vh] min-h-0 flex-col gap-3 overflow-hidden p-4 sm:p-5">
          <DialogHeader className="shrink-0">
            <DialogTitle>Run Evaluation — {evaluationToRun?.item?.name}</DialogTitle>
            <DialogDescription>
              Choose what to evaluate, where the report should go, and the pass criteria. Advanced settings are optional.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 sm:pr-3">
            <div className="space-y-3 py-2">
              {!isRagEvaluation && evaluationToRun?.type !== "agent" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label>Framework</Label>
                    <Input value={userFramework.toUpperCase()} readOnly className="mt-2 bg-gray-50 dark:bg-gray-800" />
                  </div>
                  <div>
                    <Label>Model</Label>
                    <EvaluationModelPicker key={userFramework} value={selectedModel} onChange={setSelectedModel} options={availableModels} />
                  </div>
                </div>
              )}

              {isRagEvaluation ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-white/80 dark:bg-gray-900/60 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.22em] text-gray-500 dark:text-gray-400">
                          Quick Setup
                        </p>
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                          RAG Evaluation
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Step 1) Input, Step 2) Report delivery, Step 3) Models & reference, Step 4) Pass criteria & scorecard.
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-xs">
                        {evaluationToRun?.type || "rag_eval"}
                      </Badge>
                    </div>
                    {String(evalIndexName || "").trim() && ragEvaluationMode === "dataset" && !evalUseCsvUpload && (
                      <div className="mt-3 rounded-md border border-purple-100 bg-purple-50/70 px-3 py-2 text-xs text-purple-900 dark:border-purple-900/40 dark:bg-purple-950/20 dark:text-purple-100">
                        <span className="font-semibold">Evaluating index:</span>{" "}
                        <span className="font-mono break-all">{evalIndexName}</span>
                      </div>
                    )}
                    {ragEvaluationMode === "dataset" && evalUseCsvUpload && (
                      <div className="mt-3 rounded-md border border-purple-100 bg-purple-50/70 px-3 py-2 text-xs text-purple-900 dark:border-purple-900/40 dark:bg-purple-950/20 dark:text-purple-100">
                        <span className="font-semibold">Evaluating CSV:</span>{" "}
                        <span className="font-mono break-all">{evalCsvFile?.name || evalIndexName || "Uploaded ground truth CSV"}</span>
                      </div>
                    )}
                  </div>

                  <Accordion
                    type="multiple"
                    value={openEvaluationSections}
                    onValueChange={setOpenEvaluationSections}
                    className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-white/80 dark:bg-gray-900/60 shadow-sm"
                  >
                    <AccordionItem value="input" className="px-4">
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center justify-between w-full pr-2">
                          <span>Step 1 — What Are You Evaluating?</span>
                          <span className="text-xs text-muted-foreground">
                            {ragEvaluationMode === "dataset" ? "Dataset" : "Single question"}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-1">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <Label className="text-sm font-semibold">Input Type</Label>
                              <p className="text-xs text-gray-500">
                                Use a dataset (index/CSV) for batch scoring, or a single question for a quick check.
                              </p>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                className={`px-3 text-xs h-8 transition ${ragEvaluationMode === "dataset" ? "bg-purple-600 border-purple-600 text-white hover:bg-purple-700" : ""}`}
                                onClick={() => setRagEvaluationMode("dataset")}
                              >
                                Dataset
                              </Button>
                              <Button
                                variant="outline"
                                className={`px-3 text-xs h-8 transition ${ragEvaluationMode === "question" ? "bg-purple-600 border-purple-600 text-white hover:bg-purple-700" : ""}`}
                                onClick={() => setRagEvaluationMode("question")}
                              >
                                Single Question
                              </Button>
                            </div>
                          </div>

                          {ragEvaluationMode === "dataset" ? (
                            <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <Label>Upload CSV Instead</Label>
                                <Switch
                                  checked={evalUseCsvUpload}
                                  onCheckedChange={(checked) => {
                                    setEvalUseCsvUpload(checked);
                                    setEvalCsvFile(null);
                                    setEvalCsvUploading(false);
                                    setEvalCsvUploadError("");
                                    setEvalCsvUploaded(false);
                                  }}
                                />
                              </div>
                              {!evalUseCsvUpload ? (
                                <>
                                 {/* === EVAL INDEX NAME DROPDOWN === */}
                                <div className="space-y-2">
                                  <Label>Eval Index Name (Ground Truth)</Label>
                                  <Select
                                    value={evalIndexName}
                                    onValueChange={applyEvalIndexName}
                                    open={evalIndexPickerOpen}
                                    onOpenChange={(open) => {
                                      setEvalIndexPickerOpen(open);
                                      if (open) {
                                        setEvalIndexFilter("");
                                      }
                                    }}
                                  >
                                    <SelectTrigger className="mt-1">
                                      <SelectValue placeholder="Select a ground truth index or type new name" />
                                      {isLoadingGroundTruthOptions && (
                                        <Loader2 className="ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-purple-600" />
                                      )}
                                    </SelectTrigger>
                                    <SelectContent>
                                      {/* Searchable filter inside SelectContent */}
                                      <div className="p-2 sticky top-0 bg-white dark:bg-gray-900 z-10 border-b">
                                        <Input
                                          placeholder="Filter indices..."
                                          value={evalIndexFilter}
                                          onChange={(e) => setEvalIndexFilter(e.target.value)}
                                          className="h-8 text-sm"
                                        />
                                      </div>

                                      {isLoadingGroundTruthOptions ? (
                                        <div className="space-y-2 px-3 py-3">
                                          <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-600" />
                                            Loading ground truth indices
                                          </div>
                                          {[0, 1, 2].map((row) => (
                                            <div key={row} className="flex items-center gap-2 rounded-md px-1 py-1">
                                              <Skeleton className="h-4 w-4 rounded" />
                                              <Skeleton className="h-4 flex-1" />
                                            </div>
                                          ))}
                                        </div>
                                      ) : filteredGroundTruthIndexOptions.length > 0 ? (
                                        filteredGroundTruthIndexOptions.map((name) => (
                                          <SelectItem key={name} value={name}>
                                            <div className="font-mono text-sm break-all">{name}</div>
                                          </SelectItem>
                                        ))
                                      ) : (
                                        <div className="px-4 py-6 text-center text-sm text-gray-500">
                                          No matching ground truth indices found.
                                          <br />
                                          <span className="text-xs">You can still type a new index name below.</span>
                                        </div>
                                      )}

                                      {evalIndexName &&
                                        !filteredGroundTruthIndexOptions.includes(evalIndexName) &&
                                        !evalIndexFilter && (
                                          <SelectItem value={evalIndexName}>
                                            <div className="font-mono text-sm break-all">{evalIndexName}</div>
                                          </SelectItem>
                                        )}

                                      {/* Allow creating new index name */}
                                      {evalIndexFilter && !filteredGroundTruthIndexOptions.includes(evalIndexFilter) && (
                                        <SelectItem value={evalIndexFilter} className="text-purple-600 font-medium">
                                          + Use new index: <span className="font-mono">{evalIndexFilter}</span>
                                        </SelectItem>
                                      )}
                                    </SelectContent>
                                  </Select>


                                  <p className="text-xs text-gray-500 mt-1">
                                    {isLoadingGroundTruthOptions
                                      ? "Loading available ground-truth indices. Cached results appear immediately when available."
                                      : "Pick an existing ground-truth index, or type a new index name if you already know it."}
                                  </p>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <Label>Upload Ground Truth CSV</Label>
                                  <p className="text-xs text-gray-500 mt-1">
                                    Tip: the CSV filename should include <code>ground_truth</code> (example:{" "}
                                    <code>my_ground_truth.csv</code>).
                                  </p>
                                  <Input
                                    type="file"
                                    accept=".csv"
                                    className="mt-2"
                                    onChange={handleEvalCsvUpload}
                                    disabled={evalCsvUploading}
                                  />
                                  <div className="text-xs text-gray-500 mt-2 space-y-1">
                                    <p>CSV format: include columns <code>Question</code> and <code>Answer</code>.</p>
                                    <button
                                      type="button"
                                      onClick={downloadGroundTruthCsvTemplate}
                                      className="text-purple-600 hover:text-purple-700 underline"
                                    >
                                      Download CSV template
                                    </button>
                                  </div>
                                  {evalCsvUploading && (
                                    <p className="text-xs text-gray-500 mt-1">Uploading CSV...</p>
                                  )}
                                  {evalCsvUploadError && !evalCsvUploading && (
                                    <p className="text-xs text-red-600 mt-1">{evalCsvUploadError}</p>
                                  )}
                                  {evalCsvFile?.name && (
                                    <p className="text-xs text-gray-500 mt-1">
                                      Using index name: <code>{evalCsvFile.name}</code>
                                    </p>
                                  )}
                                </>
                              )}
                              <p className="text-xs text-gray-500 mt-1">
                                Endpoint: <code>{getEvalRunApiUrl()}</code>
                              </p>
                            </div>
                          ) : (
                            <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20 space-y-3">
                              <div>
                                <Label htmlFor="testInputs">Question</Label>
                                <Textarea
                                  id="testInputs"
                                  placeholder="Enter the question you asked the assistant..."
                                  value={testInputs ?? ""}
                                  onChange={(e) => setTestInputs(e.target.value)}
                                  rows={3}
                                  className="mt-2"
                                />
                              </div>
                              <div>
                                <Label htmlFor="expectedOutput">Expected Answer (Optional)</Label>
                                <Textarea
                                  id="expectedOutput"
                                  placeholder="If you have a gold/expected answer, paste it here..."
                                  value={expectedOutput ?? ""}
                                  onChange={(e) => setExpectedOutput(e.target.value)}
                                  rows={3}
                                  className="mt-2"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="delivery" className="px-4">
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center justify-between w-full pr-2">
                          <span>Step 2 — Where Should We Send The Report?</span>
                          <span className="text-xs text-muted-foreground">
                            {parsedEmailRecipients.emails.length ? `${parsedEmailRecipients.emails.length} email(s)` : "Not set"}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-1">
                        <div className="grid grid-cols-1 gap-3">
                          <div>
                            <Label>
                              Email Recipients <span className="text-red-500">*</span>
                            </Label>
                            <Input
                              type="text"
                              value={emailToNotify ?? ""}
                              onChange={(e) => setEmailToNotify(e.target.value)}
                              placeholder="name@company.com, second@company.com"
                              className="mt-2"
                            />
                            <p className="text-xs text-gray-500 mt-1">
                              Add one or more emails separated by commas.
                            </p>
                            {(parsedEmailRecipients.emails.length || parsedEmailRecipients.invalid.length) ? (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {parsedEmailRecipients.emails.map((email) => (
                                  <Badge key={email} variant="secondary" className="bg-green-100 text-green-700">
                                    {email}
                                  </Badge>
                                ))}
                                {parsedEmailRecipients.invalid.map((token) => (
                                  <Badge key={token} variant="secondary" className="bg-red-100 text-red-700">
                                    {token}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>

                    <AccordionItem value="advanced" className="px-4">
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex items-center justify-between w-full pr-2">
                          <span>Step 3 — Models & Reference Settings</span>
                          <span className="text-xs text-muted-foreground">
                            {ragModelsMissing ? "Required" : "Ready"}
                          </span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pt-1">
                        <div className="space-y-4">
                          {ragModelsMissing && (
                            <Alert className="bg-amber-50/70 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
                              <AlertDescription className="text-xs text-amber-900 dark:text-amber-100">
                                {needsGoldenTruthModel
                                  ? "Select the Scoring Model, System Under Review, and Reference Model to run this evaluation."
                                  : "Select the Scoring Model and System Under Review to run this evaluation."}
                              </AlertDescription>
                            </Alert>
                          )}
                          <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20">
                            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                              Scoring Model (calculates the metrics)
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              This model acts as the evaluator/judge for the selected metrics.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                              <div>
                                <Label>Framework</Label>
                                <Select value={deepevalFramework} onValueChange={(value) => {
                                  setDeepevalFramework(value || "");
                                  setDeepevalModel(getFrameworkModelOptions(value)[0]?.value || "");
                                }}>
                                  <SelectTrigger className="mt-2">
                                    <SelectValue placeholder="Select framework" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {FRAMEWORK_OPTIONS.map((option) => (
                                      <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>Model</Label>
                                <EvaluationModelPicker key={deepevalFramework} value={deepevalModel} onChange={setDeepevalModel} options={getFrameworkModelOptions(deepevalFramework)} />
                              </div>
                            </div>
                          </div>

                          <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20">
                            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                              System Under Review (the model you are testing)
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                              <div>
                                <Label>Framework</Label>
                                <Select value={ragTestFramework} onValueChange={(value) => {
                                  setRagTestFramework(value || "");
                                  setRagTestModel(getFrameworkModelOptions(value)[0]?.value || "");
                                }}>
                                  <SelectTrigger className="mt-2">
                                    <SelectValue placeholder="Select framework" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {FRAMEWORK_OPTIONS.map((option) => (
                                      <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div>
                                <Label>Model</Label>
                                <EvaluationModelPicker key={ragTestFramework} value={ragTestModel} onChange={setRagTestModel} options={getFrameworkModelOptions(ragTestFramework)} />
                              </div>
                            </div>
                          </div>

                          {needsGoldenTruthModel && (
                            <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                                  Reference Model (golden-truth fallback)
                                </p>
                                <Badge variant="secondary" className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-200">
                                  Required
                                </Badge>
                              </div>
                              <p className="text-xs text-gray-500 mt-1">
                                Used when a single question has no expected answer, or a dataset row has no Answer column.
                              </p>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                                <div>
                                  <Label>Framework</Label>
                                  <Select value={goldenFramework} onValueChange={(value) => {
                                  setGoldenFramework(value || "");
                                  setGoldenModel(getFrameworkModelOptions(value)[0]?.value || "");
                                }}>
                                    <SelectTrigger className="mt-2">
                                      <SelectValue placeholder="Select framework" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {FRAMEWORK_OPTIONS.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                          {option.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div>
                                  <Label>Model</Label>
                                  <EvaluationModelPicker key={goldenFramework} value={goldenModel} onChange={setGoldenModel} options={getFrameworkModelOptions(goldenFramework)} />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="scorecard" className="px-4">
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center justify-between w-full pr-2">
                        <span>Step 4 — Pass Criteria & Scorecard</span>
                        <span className="text-xs text-muted-foreground">
                          {selectedMetrics?.length ? `${selectedMetrics.length} metric(s)` : "No metrics"}
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pt-1">
                      <div className="space-y-4">
                        <div className="border rounded-lg p-4 bg-gray-50/60 dark:bg-gray-900/20 space-y-4">
                          <div className="grid gap-4 md:grid-cols-2 items-start">
                            <div className="flex flex-col gap-1">
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                                Pass Threshold
                              </p>
                              <Input
                                type="number"
                                min="0"
                                max="1"
                                step="0.01"
                                value={overallThresholdValue ?? 0.8}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  const raw = parseFloat(e.target.value);
                                  if (Number.isNaN(raw)) {
                                    setOverallThresholdValue(0.8);
                                    return;
                                  }
                                  const clamped = Math.min(1, Math.max(0, raw));
                                  setOverallThresholdValue(clamped);
                                }}
                                className="h-10 text-sm font-medium border-purple-200"
                              />
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                Used as the pass/fail cut-off for the overall score (0.0-1.0).
                              </p>
                            </div>
                            <div className="flex flex-col gap-1">
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                                Context Documents (Top K)
                              </p>
                              <Input
                                type="text"
                                value={evalTopK ?? 50}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  const raw = parseInt(e.target.value, 10);
                                  if (Number.isNaN(raw)) {
                                    setEvalTopK(e.target.value);
                                    return;
                                  }
                                  setEvalTopK(Math.max(1, raw));
                                }}
                                className="h-10 text-sm font-medium border-purple-200"
                              />
                              <p className="text-xs leading-snug text-gray-500 dark:text-gray-400">
                                Documents to retrieve for each question. Default 50.
                              </p>
                            </div>
                            <div className="flex flex-col gap-1 md:col-span-2">
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                                Exclude Contains
                              </p>
                              <Input
                                type="text"
                                value={evalExcludeContains ?? ""}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setEvalExcludeContains(e.target.value)}
                                placeholder="Optional text filter"
                                className="h-10 text-sm font-medium border-purple-200"
                              />
                              <p className="text-xs leading-snug text-gray-500 dark:text-gray-400">
                                Optional text to exclude from retrieved context or dataset rows.
                              </p>
                            </div>
                          </div>

                          <ScrollArea className="h-[330px] border rounded-2xl bg-white/70 dark:bg-gray-900/20 p-3">
                            <div className="space-y-3">
                              {DEEPEVAL_METRICS.map((metric) => {
                                const MetricIcon = metric.icon;
                                return (
                                  <div
                                    key={metric.id}
                                    className="flex flex-col gap-1 rounded-xl border border-gray-100 bg-white/90 dark:border-gray-800 dark:bg-gray-900/40 p-3 transition hover:shadow-lg"
                                  >
                                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-100">
                                      <MetricIcon className={`w-4 h-4 ${metric.color}`} />
                                      {metric.name}
                                      <Badge variant="outline" className="text-[11px]">
                                        Threshold: {(metricThresholds[metric.id] ?? metric.threshold)}
                                      </Badge>
                                      {metric.description && (
                                        <UiTooltip>
                                          <TooltipTrigger asChild>
                                            <button
                                              type="button"
                                              className="ml-auto inline-flex items-center justify-center rounded-full h-7 w-7 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <Info className="w-4 h-4" />
                                            </button>
                                          </TooltipTrigger>
                                          <TooltipContent className="max-w-xs text-xs">
                                            {metric.description}
                                          </TooltipContent>
                                        </UiTooltip>
                                      )}
                                    </div>
                                    <div className="flex items-center justify-between mt-2">
                                      <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                                        <Checkbox
                                          checked={selectedMetrics.includes(metric.id)}
                                          onCheckedChange={() => toggleMetric(metric.id)}
                                        />
                                        Include in scorecard
                                      </label>
                                      <div className="w-24">
                                        <Input
                                          type="number"
                                          min="0"
                                          max="1"
                                          step="0.01"
                                          value={metricThresholds[metric.id] ?? metric.threshold}
                                          onClick={(e) => e.stopPropagation()}
                                          onChange={(e) =>
                                            setMetricThresholds((prev) => ({
                                              ...prev,
                                              [metric.id]: Number.isNaN(parseFloat(e.target.value))
                                                ? metric.threshold
                                                : parseFloat(e.target.value),
                                            }))
                                          }
                                          className="mt-1 h-9 text-xs border-purple-200"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </ScrollArea>
                        </div>

                        {selectedMetrics.includes('g_eval') && evaluationToRun?.type !== "agent" && (
                          <Alert className="bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800">
                            <Brain className="w-4 h-4 text-purple-600" />
                            <AlertDescription className="text-sm text-purple-900 dark:text-purple-100">
                              <div className="space-y-2">
                                <p className="font-semibold">G-Eval: LLM as Judge</p>
                                <p className="text-xs">
                                  This metric uses an LLM to evaluate the response based on your custom criteria.
                                  Be specific about what you want to evaluate (e.g., &quot;accuracy and completeness&quot;,
                                  &quot;professional tone and clarity&quot;, &quot;adherence to brand guidelines&quot;).
                                </p>
                                <div className="mt-3">
                                  <Label htmlFor="customCriteria" className="text-xs font-semibold text-purple-900 dark:text-purple-200">
                                    Custom Evaluation Criteria *
                                  </Label>
                                  <Textarea
                                    id="customCriteria"
                                    value={customCriteria ?? ""}
                                    onChange={(e) => setCustomCriteria(e.target.value)}
                                    placeholder="e.g., Evaluate the response for accuracy, completeness, clarity, and professional tone. The response should directly answer the question with relevant details."
                                    rows={4}
                                    className="mt-2 text-xs"
                                  />
                                </div>
                              </div>
                            </AlertDescription>
                          </Alert>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ) : evaluationToRun?.type === "agent" ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-white/80 dark:bg-gray-900/60 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.22em] text-gray-500 dark:text-gray-400">
                          DeepEval Agent
                        </p>
                        <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                          {evaluationToRun?.item?.name || "Agent"} Golden Dataset
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Run the eval service against OpenSearch golden cases and persist results to an output index.
                        </p>
                      </div>
                      <Badge variant="secondary" className="text-xs">agent</Badge>
                    </div>
                  </div>

                  <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <Label className="text-sm font-semibold">Input Type</Label>
                        <p className="text-xs text-gray-500">
                          Use a golden dataset for batch scoring, or save one question into a golden index for a quick check.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className={`px-3 text-xs h-8 transition ${agentEvaluationMode === "dataset" ? "bg-purple-600 border-purple-600 text-white hover:bg-purple-700" : ""}`}
                          onClick={() => setAgentEvaluationMode("dataset")}
                        >
                          Dataset
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className={`px-3 text-xs h-8 transition ${agentEvaluationMode === "question" ? "bg-purple-600 border-purple-600 text-white hover:bg-purple-700" : ""}`}
                          onClick={() => {
                            setAgentEvaluationMode("question");
                            setAgentUseCsvUpload(false);
                            setAgentCsvFile(null);
                            setAgentCsvUploaded(false);
                          }}
                        >
                          Questions
                        </Button>
                      </div>
                    </div>

                    {agentEvaluationMode === "dataset" ? (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <Label>Upload CSV Instead</Label>
                          <Switch
                            checked={agentUseCsvUpload}
                            onCheckedChange={(checked) => {
                              setAgentUseCsvUpload(checked);
                              setAgentCsvFile(null);
                              setAgentCsvUploaded(false);
                              setAgentCsvUploadError("");
                            }}
                          />
                        </div>
                        <div>
                          <Label>Agent Golden Index</Label>
                          <Input
                            value={agentGoldenIndexName ?? ""}
                            onChange={(e) => setAgentGoldenIndexName(e.target.value)}
                            placeholder="agent_eval_golden"
                            className="mt-2 font-mono text-sm"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Use an existing OpenSearch index, or upload CSV to create a new per-agent index.
                          </p>
                        </div>
                        {agentUseCsvUpload && (
                          <div>
                            <Label>Scenario CSV Upload</Label>
                            <Input
                              type="file"
                              accept=".csv"
                              className="mt-2"
                              onChange={handleAgentGoldenCsvUpload}
                              disabled={agentCsvUploading}
                            />
                            <p className="text-xs text-gray-500 mt-1">
                              Header: <code>agent_id,agent_name,question,expected_tool,expected_contains,task_type,human_time_minutes</code>
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              Example row: <code>{evaluationToRun?.item?.id || "agent-id"},{evaluationToRun?.item?.name || "Email Sender"},send an email...,send_email,Emails sent successfully.,send_email,8</code>
                            </p>
                            {agentCsvUploading && (
                              <p className="text-xs text-gray-500 mt-1">Uploading CSV...</p>
                            )}
                            {agentCsvUploadError && !agentCsvUploading && (
                              <p className="text-xs text-red-600 mt-1">{agentCsvUploadError}</p>
                            )}
                            {agentCsvUploaded && agentCsvFile?.name && (
                              <p className="text-xs text-green-600 mt-1">
                                Loaded <code>{agentCsvFile.name}</code> into <code>{agentGoldenIndexName}</code>.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="space-y-3 rounded-lg border border-purple-100 dark:border-purple-900/40 bg-white/70 dark:bg-gray-950/20 p-3">
                        {isFetchingAgentGoldenCase && (
                          <p className="text-xs text-gray-500">Loading saved questions for this agent...</p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Agent ID</Label>
                            <Input value={evaluationToRun?.item?.id || ""} readOnly className="mt-2 font-mono text-xs" />
                          </div>
                          <div>
                            <Label>Agent Name</Label>
                            <Input value={evaluationToRun?.item?.name || ""} readOnly className="mt-2" />
                          </div>
                        </div>
                        <p className="text-xs text-gray-500">Add one or more questions. Save questions before scheduling; each run evaluates all saved questions for this agent. Deleting a question removes it from future runs.</p>
                        {agentQuestions.map((row, index) => (
                          <fieldset key={row.question_id} disabled={agentSingleSaving || isFetchingAgentGoldenCase} className="space-y-3 rounded-lg border p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold">Question {index + 1} · <code>{row.question_id}</code></span>
                              <Button type="button" size="sm" variant="outline" disabled={agentSingleSaving || isFetchingAgentGoldenCase} onClick={() => deleteAgentQuestion(row)}>Delete question</Button>
                            </div>
                        <div>
                          <Label>Question</Label>
                          <Textarea
                            value={row.question ?? ""}
                            onChange={(e) => updateAgentQuestion(row.question_id, "question", e.target.value)}
                            placeholder="send a email to arjun.sharma@zetaris.com about latest interest rate cba 6 and suncorp bank 8%"
                            className="mt-2 min-h-[90px]"
                          />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Expected Tool</Label>
                            <Input
                              value={row.expected_tool ?? ""}
                              onChange={(e) => updateAgentQuestion(row.question_id, "expected_tool", e.target.value)}
                              placeholder="send_email"
                              className="mt-2"
                            />
                          </div>
                          <div>
                            <Label>Task Type</Label>
                            <Input
                              value={row.task_type ?? ""}
                              onChange={(e) => updateAgentQuestion(row.question_id, "task_type", e.target.value)}
                              placeholder="send_email"
                              className="mt-2"
                            />
                          </div>
                        </div>
                        <div>
                          <Label>Expected Tool Output</Label>
                          <Input
                            value={row.expected_contains ?? ""}
                            onChange={(e) => updateAgentQuestion(row.question_id, "expected_contains", e.target.value)}
                            placeholder="Emails sent successfully.,arjun.sharma@zetaris.com"
                            className="mt-2"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Add expected output text checks, separated with commas.
                          </p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Human Time Minutes</Label>
                            <Input
                              type="number"
                              min="0"
                              step="0.1"
                              value={row.human_time_minutes ?? ""}
                              onChange={(e) => updateAgentQuestion(row.question_id, "human_time_minutes", e.target.value)}
                              placeholder="8"
                              className="mt-2"
                            />
                          </div>

                        </div>
                          </fieldset>
                        ))}
                        <div className="flex gap-2">
                          <Button type="button" variant="outline" disabled={agentSingleSaving || isFetchingAgentGoldenCase || agentQuestions.length >= 100} onClick={() => setAgentQuestions((rows) => [...rows, newAgentGoldenQuestion()])}>Add question</Button>
                          <Button type="button" disabled={agentSingleSaving || isFetchingAgentGoldenCase || !agentQuestions.length} onClick={saveAgentQuestions}>Save all questions</Button>
                        </div>
                          <div>
                            <Label>Save To Golden Index</Label>
                            <Input
                              value={agentGoldenIndexName ?? ""}
                              onChange={(e) => setAgentGoldenIndexName(e.target.value)}
                              placeholder="agent_eval_golden"
                              className="mt-2 font-mono text-sm"
                            />
                          </div>
                        {agentCsvUploadError && (
                          <p className="text-xs text-red-600">{agentCsvUploadError}</p>
                        )}
                        {agentSingleSaving && (
                          <p className="text-xs text-gray-500">Saving questions into golden index...</p>
                        )}
                      </div>
                    )}
                    <div>
                      <Label>Output OpenSearch Index</Label>
                      <Input
                        value={agentOutputIndexName ?? ""}
                        onChange={(e) => setAgentOutputIndexName(e.target.value)}
                        placeholder="agent_eval_output"
                        className="mt-2 font-mono text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <Label>Framework</Label>
                        <Select value={deepevalFramework} onValueChange={(value) => {
                                  setDeepevalFramework(value || "");
                                  setDeepevalModel(getFrameworkModelOptions(value)[0]?.value || "");
                                }}>
                          <SelectTrigger className="mt-2">
                            <SelectValue placeholder="Select framework" />
                          </SelectTrigger>
                          <SelectContent>
                            {FRAMEWORK_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Model</Label>
                        <EvaluationModelPicker key={deepevalFramework} value={deepevalModel} onChange={setDeepevalModel} options={getFrameworkModelOptions(deepevalFramework)} />
                      </div>
                    </div>
                    <p className="text-xs text-gray-500">
                      Endpoint: <code>{getAgentDeepEvalRunApiUrl()}</code>
                    </p>
                  </div>
                </div>
              ) : (
                <div className="border rounded-lg p-3 bg-gray-50/60 dark:bg-gray-900/20">
                  <Label className="text-sm font-semibold">Scenario CSV Upload (Optional)</Label>
                  <p className="text-xs text-gray-500 mt-1">
                    Upload CSV columns: <code>test_scenario,test_inputs,expected_output,retrieval_context</code>
                  </p>
                  <Input type="file" accept=".csv" className="mt-2" onChange={handleScenarioCsvUpload} />
                  {uploadedScenarios.length > 0 && (
                    <p className="text-xs text-green-600 mt-2">Loaded {uploadedScenarios.length} scenario row(s) from CSV.</p>
                  )}
                </div>
              )}

              {!isRagEvaluation && evaluationToRun?.type !== "agent" && (
                <>
                  <div className="border rounded-lg p-4 bg-white/80 dark:bg-gray-900/60 shadow-sm space-y-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="flex items-center gap-2">
                        <Brain className="w-5 h-5 text-purple-600" />
                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-100">Pass Criteria & Scorecard</p>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Choose the score checks you care about, and adjust thresholds if needed.
                      </p>
                    </div>
                    <div className="grid gap-4 md:grid-cols-[1fr_1fr] items-center">
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                          Pass Threshold
                        </p>
                        <Input
                          type="number"
                          min="0"
                          max="1"
                          step="0.01"
                          value={overallThresholdValue ?? 0.8}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const raw = parseFloat(e.target.value);
                            if (Number.isNaN(raw)) {
                              setOverallThresholdValue(0.8);
                              return;
                            }
                            const clamped = Math.min(1, Math.max(0, raw));
                            setOverallThresholdValue(clamped);
                          }}
                          className="h-10 text-sm font-medium border-purple-200"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Used as the pass/fail cut-off for the overall score (0.0-1.0).
                        </p>
                      </div>
                      <div className="flex flex-col gap-1">
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                          Context Documents (Top K)
                        </p>
                        <Input
                          type="text"
                          value={evalTopK ?? 50}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const raw = parseInt(e.target.value, 10);
                            if (Number.isNaN(raw)) {
                              setEvalTopK(e.target.value);
                              return;
                            }
                            setEvalTopK(Math.max(1, raw));
                          }}
                          className="h-10 text-sm font-medium border-purple-200"
                        />
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          How many documents to retrieve as context for each question (default 50).
                        </p>
                      </div>
                    </div>
                    <ScrollArea className="h-[330px] border rounded-2xl bg-gray-50/80 dark:bg-gray-900/30 p-3">
                      <div className="space-y-3">
                        {DEEPEVAL_METRICS.map((metric) => {
                          const MetricIcon = metric.icon;
                          return (
                            <div
                              key={metric.id}
                              className="flex flex-col gap-1 rounded-xl border border-gray-100 bg-white/90 dark:border-gray-800 dark:bg-gray-900/40 p-3 transition hover:shadow-lg"
                            >
                              <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-100">
                                <MetricIcon className={`w-4 h-4 ${metric.color}`} />
                                {metric.name}
                                <Badge variant="outline" className="text-[11px]">
                                  Threshold: {(metricThresholds[metric.id] ?? metric.threshold)}
                                </Badge>
                                {metric.requiresCriteria && (
                                  <Badge className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30">
                                    Custom
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {metric.description}
                              </p>
                              <div className="flex items-center gap-3">
                                <Checkbox
                                  id={`eval-metric-${metric.id}`}
                                  checked={selectedMetrics.includes(metric.id)}
                                  onCheckedChange={() => toggleMetric(metric.id)}
                                />
                                <div className="w-full max-w-[220px]">
                                  <Label className="text-[11px]">Override threshold</Label>
                                  <Input
                                    type="number"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    value={metricThresholds?.[metric.id] ?? metric.threshold}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      setMetricThresholds((prev) => ({
                                        ...prev,
                                        [metric.id]: Number.isNaN(parseFloat(e.target.value))
                                          ? metric.threshold
                                          : parseFloat(e.target.value),
                                      }))
                                    }
                                    className="mt-1 h-9 text-xs border-purple-200"
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </div>

                  {selectedMetrics.includes('g_eval') && evaluationToRun?.type !== "agent" && (
                    <Alert className="bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800">
                      <Brain className="w-4 h-4 text-purple-600" />
                      <AlertDescription className="text-sm text-purple-900 dark:text-purple-100">
                        <div className="space-y-2">
                          <p className="font-semibold">G-Eval: LLM as Judge</p>
                          <p className="text-xs">
                            This metric uses an LLM to evaluate the response based on your custom criteria.
                            Be specific about what you want to evaluate (e.g., &quot;accuracy and completeness&quot;,
                            &quot;professional tone and clarity&quot;, &quot;adherence to brand guidelines&quot;).
                          </p>
                          <div className="mt-3">
                            <Label htmlFor="customCriteria" className="text-xs font-semibold text-purple-900 dark:text-purple-200">
                              Custom Evaluation Criteria *
                            </Label>
                            <Textarea
                              id="customCriteria"
                              value={customCriteria ?? ""}
                              onChange={(e) => setCustomCriteria(e.target.value)}
                              placeholder="e.g., Evaluate the response for accuracy, completeness, clarity, and professional tone. The response should directly answer the question with relevant details."
                              rows={4}
                              className="mt-2 text-xs"
                            />
                          </div>
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </>
              )}

              {!isRagEvaluation && evaluationToRun?.type !== "agent" && (
                <div className="h-[260px] overflow-y-auto pr-1">
                  <div>
                    <div className="mt-3">
                      <Label htmlFor="testInputs">Test Input / Question (Optional)</Label>
                      <Textarea
                        id="testInputs"
                        placeholder="Enter the input question or query..."
                        value={testInputs ?? ""}
                        onChange={(e) => setTestInputs(e.target.value)}
                        rows={3}
                        className="mt-2"
                      />
                    </div>

                    <div className="mt-3">
                      <Label htmlFor="expectedOutput">Expected Output (Optional)</Label>
                      <Textarea
                        id="expectedOutput"
                        placeholder="What output do you expect?"
                        value={expectedOutput ?? ""}
                        onChange={(e) => setExpectedOutput(e.target.value)}
                        rows={3}
                        className="mt-2"
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Describe the input and expected output you’d like to evaluate in test scenario mode.
                    </p>

                    <div className="mt-3">
                      <Label htmlFor="retrievalContext">Retrieval Context (For RAG Evaluations) (Optional)</Label>
                      <Textarea
                        id="retrievalContext"
                        placeholder="Enter the context that was retrieved (one item per line)..."
                        value={retrievalContext ?? ""}
                        onChange={(e) => setRetrievalContext(e.target.value)}
                        rows={4}
                        className="mt-2"
                      />
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
          <div
            className="mt-2 shrink-0 border-t bg-background pt-3 flex flex-wrap items-center justify-between gap-2"
          >
            {scheduleConfigEditMode && (
              <p className="text-xs text-gray-500 dark:text-gray-400 max-w-[320px]">
                Saves this configuration for future scheduled runs.
              </p>
            )}
            <div className={`flex flex-wrap items-center gap-2 ${scheduleConfigEditMode ? "" : "ml-auto"}`}>
              <Button variant="outline" onClick={() => setShowEvaluationDialog(false)} className="md-ripple">
                Cancel
              </Button>
              {scheduleConfigEditMode ? (
                <Button
                  onClick={() => saveScheduleConfigMutation.mutate()}
                  disabled={
                    selectedMetrics.length === 0 ||
                    saveScheduleConfigMutation.isPending ||
                    (isRagEvaluation && ragModelsMissing)
                  }
                  className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm ring-1 ring-emerald-500/30 md-ripple"
                >
                  {saveScheduleConfigMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving Config...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                      Save Configuration
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={handleConfirmRunEvaluation}
                  disabled={
                    selectedMetrics.length === 0 ||
                    runEvaluationMutation.isPending ||
                    agentCsvUploading ||
                    agentSingleSaving ||
                    (isRagEvaluation && ragModelsMissing)
                  }
                  className="bg-purple-600 hover:bg-purple-700 text-white md-ripple"
                >
                  {runEvaluationMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Running Evaluation...
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-4 h-4 mr-2" />
                      Run Evaluation
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Schedule Dialog */}
      <Dialog
        open={showScheduleDialog}
        onOpenChange={(open) => {
          setShowScheduleDialog(open);
          if (!open) {
            setShowScheduleSnapshotDetails(false);
            setShowScheduleConfigDetails(false);
          }
        }}
      >
        <DialogContent className="flex w-[calc(100vw-2rem)] max-w-2xl max-h-[85vh] min-w-0 flex-col overflow-hidden p-0 sm:w-[calc(100vw-3rem)]">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
            <DialogHeader className="min-w-0 pr-8">
              <DialogTitle>Schedule Recurring Evaluation</DialogTitle>
              <DialogDescription>
                Configure automatic evaluation for {evaluationToSchedule?.item_name}
              </DialogDescription>
            </DialogHeader>
            <Card className="mt-4 min-w-0 overflow-hidden p-4 bg-white/80 dark:bg-gray-900/70 border border-gray-200/70 dark:border-gray-800 shadow-sm">
              <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowScheduleSnapshotDetails((prev) => !prev)}
                    className="h-8 w-8 shrink-0 p-0"
                    aria-label={showScheduleSnapshotDetails ? "Collapse config snapshot" : "Expand config snapshot"}
                  >
                    <ChevronsUpDown className="h-4 w-4" />
                  </Button>
                  <p className="text-xs uppercase tracking-[0.25em] text-gray-500 dark:text-gray-400">
                    Config Snapshot
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={handleEditScheduleConfig} className="w-full shrink-0 sm:w-auto">
                  Change Config
                </Button>
              </div>
              {showScheduleSnapshotDetails && (
                <div className="mt-4 min-w-0 space-y-3 border-t border-gray-200/70 pt-3 text-sm text-gray-700 dark:border-gray-800 dark:text-gray-300">
                  {(() => {
                    const scheduleSummary = buildScheduleInputSummary(evaluationToSchedule);
                    return (
                      <div className="flex min-w-0 flex-wrap gap-4 text-[12px] text-gray-600 dark:text-gray-400">
                        <span className="min-w-0 break-words">
                          Index:{" "}
                          <strong className="text-gray-800 dark:text-gray-200">
                            {scheduleSummary.indexName}
                          </strong>
                        </span>
                        <span className="min-w-0 break-words">
                          Input:{" "}
                          <strong className="text-gray-800 dark:text-gray-200">
                            {scheduleSummary.modeLabel}
                          </strong>
                        </span>
                      </div>
                    );
                  })()}
                  {(() => {
                    const scheduleSummary = buildScheduleInputSummary(evaluationToSchedule);
                    if (!scheduleSummary.scenarioSummary) return null;
                    return (
                      <div className="min-w-0 break-words text-[12px] text-gray-500 dark:text-gray-400">
                        Scenario:{" "}
                        <span className="text-gray-700 dark:text-gray-300">
                          {scheduleSummary.scenarioSummary}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="h-px bg-gray-200/70 dark:bg-gray-800/80" />
                  <div className="flex min-w-0 flex-wrap gap-4 text-[12px] text-gray-600 dark:text-gray-400">
                    <span className="min-w-0 break-words">
                      Under Test:{" "}
                      <strong className="text-gray-800 dark:text-gray-200">
                        {resolveEvaluationValue(evaluationToSchedule, [
                          "schedule_config.eval_target_params.model_under_test",
                          "model_under_test",
                          "eval_api_response.model_under_test",
                        ]) || "N/A"}
                      </strong>
                    </span>
                    <span className="min-w-0 break-words">
                      Under Test Framework:{" "}
                      <strong className="text-gray-800 dark:text-gray-200">
                        {resolveEvaluationValue(evaluationToSchedule, [
                          "schedule_config.eval_target_params.model_under_test_framework",
                          "model_under_test_framework",
                          "eval_api_response.model_under_test_framework",
                        ]) || "N/A"}
                      </strong>
                    </span>
                    <span className="min-w-0 break-words">
                      Eval Model:{" "}
                      <strong className="text-gray-800 dark:text-gray-200">
                        {resolveEvaluationValue(evaluationToSchedule, [
                          "schedule_config.eval_target_params.deepeval_metrics_model",
                          "deepeval_metrics_model",
                          "eval_api_response.deepeval_metrics_model",
                        ]) || "N/A"}
                      </strong>
                    </span>
                    <span className="min-w-0 break-words">
                      Eval Framework:{" "}
                      <strong className="text-gray-800 dark:text-gray-200">
                        {resolveEvaluationValue(evaluationToSchedule, [
                          "schedule_config.eval_target_params.deepeval_metrics_framework",
                          "deepeval_metrics_framework",
                          "eval_api_response.deepeval_metrics_framework",
                        ]) || "N/A"}
                      </strong>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(() => {
                      const rawMetrics =
                        evaluationToSchedule?.schedule_config?.eval_target_params?.rag_metrics ||
                        evaluationToSchedule?.selected_metrics ||
                        evaluationToSchedule?.selectedMetrics ||
                        [];
                      const metrics = normalizeSelectedMetrics(rawMetrics);
                      return metrics.length ? (
                        metrics.map((metricId) => (
                          <span
                            key={`sched-metric-${metricId}`}
                            className="min-w-0 max-w-full break-words inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] dark:border-gray-800 dark:bg-gray-900/60"
                          >
                            {METRIC_NAME_LOOKUP[metricId] || metricId}
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px] text-gray-500">No metrics saved.</span>
                      );
                    })()}
                  </div>
                  {(() => {
                    const targetSummary = buildScheduleTargetSummary(evaluationToSchedule);
                    if (!targetSummary) return null;
                    return (
                      <div className="min-w-0 overflow-hidden rounded-md border border-gray-200/70 dark:border-gray-800 bg-white/70 dark:bg-gray-900/60 p-2">
                        <p className="text-[10px] uppercase tracking-[0.2em] text-gray-400 dark:text-gray-500">
                          Eval Endpoint
                        </p>
                        <p className="mt-1 text-[11px] font-mono break-all text-gray-700 dark:text-gray-200">
                          {targetSummary.url}
                        </p>
                        {targetSummary.details ? (
                          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
                            {targetSummary.details}
                          </p>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              )}
            </Card>
            <Card className="mt-4 min-w-0 overflow-hidden p-4 bg-white/80 dark:bg-gray-900/70 border border-gray-200/70 dark:border-gray-800 shadow-sm">
              <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowScheduleConfigDetails((prev) => !prev)}
                    className="h-8 w-8 shrink-0 p-0"
                    aria-label={showScheduleConfigDetails ? "Collapse schedule config" : "Expand schedule config"}
                  >
                    <ChevronsUpDown className="h-4 w-4" />
                  </Button>
                  <p className="text-xs uppercase tracking-[0.25em] text-gray-500 dark:text-gray-400">
                    Schedule Config
                  </p>
                </div>
              </div>
              {showScheduleConfigDetails && (
                <div className="mt-4 min-w-0 max-w-full overflow-hidden border-t border-gray-200/70 pt-3 dark:border-gray-800">
                  <SchedulerConfigurator
                    config={evaluationToSchedule?.schedule_config}
                    onSave={handleSaveSchedule}
                    onCancel={() => setShowScheduleDialog(false)}
                    type="evaluation"
                  />
                </div>
              )}
            </Card>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          setShowDeleteDialog(open);
          if (!open) setEvaluationToDelete(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Evaluation</DialogTitle>
            <DialogDescription>
              Removing an evaluation hides it from the history and score charts. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-gray-600 dark:text-gray-300">
            Are you sure you want to delete the run for <strong>{evaluationToDelete?.item_name}</strong>?
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteEvaluationMutation.isLoading}
              onClick={handleConfirmDelete}
            >
              {deleteEvaluationMutation.isLoading ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

	      <Dialog
		        open={detailsModalOpen}
		        onOpenChange={(open) => {
		          setDetailsModalOpen(open);
		          if (!open) setDetailsModalEvaluationId(null);
		        }}
		      >
	        <DialogContent className="flex w-[calc(100vw-1.5rem)] max-w-6xl max-h-[90vh] min-h-0 flex-col gap-0 overflow-hidden p-0">
	          <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-800 bg-[rgb(var(--md-surface))] px-4 py-3">
	            <div className="min-w-0">
	              <DialogTitle className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
	                {detailsModalEvaluation?.item_name || "Evaluation Details"}
	              </DialogTitle>
	              <DialogDescription className="text-xs">
	                Full evaluation results
	              </DialogDescription>
	            </div>
	          </div>
	          <div className="min-h-0 flex-1 overflow-y-auto bg-[rgb(var(--md-surface))] px-4 py-3">
	            {detailsModalEvaluation ? (
	              (() => {
	                const evaluation = detailsModalEvaluation;
	                const normalizedStatus = String(evaluation.status || "completed").toLowerCase();
	                const isAgentEvaluation = evaluation.evaluation_type === "agent";
	                const isAgentOutputRow = String(evaluation.id || "").startsWith("agent-output:");
	                const agentSummary = isAgentEvaluation ? getAgentEvalSummary(evaluation) : {};
	                const hasAgentSummary = isAgentEvaluation && Object.keys(agentSummary).length > 0;
	                const agentCompletedRunCount = isAgentEvaluation
	                  ? displayedEvaluations.filter(
	                      (item) =>
	                        item.evaluation_type === "agent" &&
	                        item.item_id === evaluation.item_id &&
	                        String(item.status || "").toLowerCase() === "completed"
	                    ).length
	                  : null;
	                const isRunning = isEvaluationRecordInProgress(evaluation);
	                const deepEvalRaw = evaluation.eval_overall_status || evaluation.eval_status;
	                const deepEvalNormalized = deepEvalRaw ? String(deepEvalRaw).toLowerCase() : "";
	                const modalMetricDetailsForOutcome = getEvaluationMetricDetails(evaluation);
	                const hasResults =
	                  !isRunning &&
	                  (Boolean(evaluation.eval_results_found) ||
	                    (evaluation.deepeval_metrics && Object.keys(evaluation.deepeval_metrics).length > 0) ||
	                    (evaluation.eval_summary?.avg_scores &&
	                      Object.keys(evaluation.eval_summary.avg_scores).length > 0) ||
	                    hasAgentSummary ||
	                    (evaluation.eval_api_response &&
	                      typeof evaluation.eval_api_response === "object" &&
	                      Object.keys(extractMetricDetailsFromResponse(evaluation.eval_api_response)).length > 0));
	                const isJobFailed = ["failed", "error"].includes(normalizedStatus) && !hasResults;
	                const thresholdForOutcome = Number(evaluation?.overall_threshold_value ?? 0.8);
	                const remoteMetricDetailsForOutcome = reasoningByEvaluationId[evaluation.id] || null;
	                if (remoteMetricDetailsForOutcome) {
	                  Object.entries(remoteMetricDetailsForOutcome).forEach(([metricId, result]) => {
	                    mergeMetricResult(modalMetricDetailsForOutcome, metricId, result);
	                  });
	                }
	                const { combinedScore: combinedOutcomeScore } =
	                  computeQualityRiskScores(modalMetricDetailsForOutcome);
	                const computedPassedByScore =
	                  !isAgentOutputRow &&
	                  hasResults &&
	                  Number.isFinite(combinedOutcomeScore) &&
	                  Number.isFinite(thresholdForOutcome)
	                    ? combinedOutcomeScore >= thresholdForOutcome
	                    : null;
	                const computedPassed =
	                  computedPassedByScore !== null
	                    ? computedPassedByScore
	                    : typeof evaluation.passed === "boolean"
	                      ? evaluation.passed
	                      : null;
	                const isDeepEvalPass = ["pass", "passed", "success"].includes(deepEvalNormalized);
	                const isDeepEvalFail = ["fail", "failed", "error"].includes(deepEvalNormalized);
	                const isDeepEvalPending = isRunning || !hasResults || deepEvalNormalized === "processing";
	                const deepEvalStatusLabel = isAgentEvaluation
	                  ? ""
	                  : isDeepEvalPending
	                    ? "Pending"
	                    : computedPassed === true
	                    ? "Pass"
	                    : computedPassed === false && hasResults
	                      ? "Fail"
	                      : isDeepEvalFail
	                        ? "Fail"
	                        : isDeepEvalPass
	                          ? "Pass"
	                          : "";
	                const jobBadgeClass = isRunning
	                  ? "bg-blue-100 text-blue-700"
	                  : isJobFailed
	                    ? "bg-red-100 text-red-700"
	                    : "bg-gray-100 text-gray-700";
	                const deepEvalBadgeClass =
	                  deepEvalStatusLabel === "Fail"
	                    ? "bg-red-100 text-red-700"
	                    : deepEvalStatusLabel === "Pass"
	                      ? "bg-green-100 text-green-700"
	                      : deepEvalStatusLabel === "Pending"
	                        ? "bg-amber-100 text-amber-800"
	                        : "bg-gray-100 text-gray-700";
	                const startedAtValue = resolveEvaluationValue(evaluation, [
	                  "started_at",
	                  "eval_api_response.started_at",
	                  "eval_api_response.created_at",
	                  "created_date",
	                ]);
	                const endedAtValue = resolveEvaluationValue(evaluation, [
	                  "ended_at",
	                  "finished_at",
	                  "completed_at",
	                  "eval_api_response.ended_at",
	                  "eval_api_response.finished_at",
	                  "eval_api_response.completed_at",
	                  "eval_api_response.updated_at",
	                  "updated_date",
	                ]);
	                const formattedStartedAt = formatEvaluationDate(startedAtValue);
	                const formattedEndedAt = formatEvaluationDate(endedAtValue);

	                const modelUnderTestValue = resolveEvaluationValue(evaluation, [
	                  "model_under_test",
	                  "eval_api_response.model_under_test",
	                ]);
	                const modelUnderTestFrameworkValue = resolveEvaluationValue(evaluation, [
	                  "model_under_test_framework",
	                  "eval_api_response.model_under_test_framework",
	                ]);
	                const deepevalModelValue = resolveEvaluationValue(evaluation, [
	                  "deepeval_metrics_model",
	                  "eval_api_response.deepeval_metrics_model",
	                ]);
	                const goldenModelValue = resolveEvaluationValue(evaluation, [
	                  "golden_truth_model",
	                  "eval_api_response.golden_truth_model",
	                ]);
	                const evalInputModeForDetails = resolveEvaluationValue(evaluation, [
	                  "eval_input_mode",
	                  "eval_api_response.eval_input_mode",
	                ]);
	                const hideGoldenModelForDataset =
	                  Boolean(String(evaluation?.eval_index_name || "").trim()) ||
	                  ["csv_upload", "index_name"].includes(String(evalInputModeForDetails || "").toLowerCase());
	                const hasDisplayedEvalIndex = Boolean(String(evaluation?.eval_index_name || "").trim());
	                const testScenarioText = String(evaluation?.test_scenario || "").trim();
	                const isSyntheticRagScenario =
	                  String(evaluation.evaluation_type || "").startsWith("rag_") &&
	                  /^RAG Evaluation \(.+\)$/i.test(testScenarioText);
	                const showTestScenario =
	                  Boolean(testScenarioText) && !(hasDisplayedEvalIndex && isSyntheticRagScenario);

	                const overallThresholdRaw = evaluation?.overall_threshold_value ?? 0.8;
	                const overallThresholdNumeric = Number(overallThresholdRaw);
	                const overallThresholdDisplay = Number.isFinite(overallThresholdNumeric)
	                  ? overallThresholdNumeric.toFixed(2)
	                  : "0.80";
	                const underTestDisplay = modelUnderTestValue
	                  ? `${modelUnderTestValue}${
	                      modelUnderTestFrameworkValue ? ` (${modelUnderTestFrameworkValue})` : ""
	                    }`
	                  : null;

	                const evalApiResponseObject =
	                  evaluation.eval_api_response && typeof evaluation.eval_api_response === "object"
	                    ? evaluation.eval_api_response
	                    : null;
	                const isEvalOutputDuplicateText =
	                  typeof evaluation.actual_output === "string" &&
	                  typeof evaluation.eval_api_response === "string" &&
	                  evaluation.actual_output.trim() === evaluation.eval_api_response.trim();
	                const showEvalResponseDetails =
	                  evalApiResponseObject && !isRunning && !isEvalOutputDuplicateText;

	                const metricDetails = getEvaluationMetricDetails(evaluation);
	                const remoteMetricDetails = reasoningByEvaluationId[evaluation.id] || null;
	                if (remoteMetricDetails) {
	                  Object.entries(remoteMetricDetails).forEach(([metricId, result]) => {
	                    mergeMetricResult(metricDetails, metricId, result);
	                  });
	                }
	                const { qualityScore, riskScore, combinedScore } = computeQualityRiskScores(metricDetails);
	                const qualityMetricNames = DEEPEVAL_METRICS
	                  .filter((metric) => !metric.inverse)
	                  .map((metric) => metric.name)
	                  .join(", ");
	                const riskMetricNames = DEEPEVAL_METRICS
	                  .filter((metric) => metric.inverse)
	                  .map((metric) => metric.name)
	                  .join(", ");
	                const qualityMetricCount = qualityMetricNames
	                  ? qualityMetricNames.split(", ").filter(Boolean).length
	                  : 0;
	                const riskMetricCount = riskMetricNames
	                  ? riskMetricNames.split(", ").filter(Boolean).length
	                  : 0;
	                const hasMetricDetails = !isRunning && !isAgentEvaluation && Object.keys(metricDetails).length > 0;
	                const isReasoningLoading = Boolean(reasoningLoadingByEvaluationId[evaluation.id]);
	                const missingDownloads =
	                  !evaluation?.eval_download_urls ||
	                  (typeof evaluation.eval_download_urls === "object" &&
	                    Object.keys(evaluation.eval_download_urls).length === 0);
	                const hasRefreshableResultsUrl = Boolean(
	                  (evaluation?.eval_status_url || evaluation?.status_url || evaluation?.eval_results_url) &&
	                    !isRunning
	                );
		                const hasAnyResults =
		                  !isRunning &&
		                  (hasMetricDetails ||
		                    hasAgentSummary ||
		                    Boolean(evaluation?.eval_results_found) ||
		                    (evaluation?.eval_summary?.avg_scores &&
		                      Object.keys(evaluation.eval_summary.avg_scores).length > 0));
	                const executionTimeMs = resolveExecutionTimeMs(evaluation);
	                const runtimeLabel = formatDurationLabel(executionTimeMs);

	                const overallNumeric = Number.isFinite(combinedScore)
	                  ? Number(combinedScore)
	                  : Number.isFinite(qualityScore)
	                    ? Number(qualityScore)
	                    : NaN;
	                const passFail =
	                  Number.isFinite(overallNumeric) && Number.isFinite(overallThresholdNumeric)
	                    ? overallNumeric >= overallThresholdNumeric
	                    : null;
	                const passPill = passFail === true
	                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200"
	                  : passFail === false
	                    ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-900/20 dark:text-rose-200"
	                    : "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200";

	                return (
	                  <div className="space-y-3">
		                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		                      <div className="flex flex-wrap items-center gap-2">
		                        {isRunning ? (
		                        <Badge
		                          variant="secondary"
		                          className={`${jobBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
		                        >
		                          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
		                          Running
		                        </Badge>
		                      ) : (
	                        <Badge
	                          variant="secondary"
	                          className={`${jobBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
	                        >
	                          {isJobFailed ? (
	                            <XCircle className="w-3 h-3 mr-1" />
	                          ) : (
	                            <CheckCircle2 className="w-3 h-3 mr-1" />
	                          )}
	                          {isJobFailed ? "Failed" : "Completed"}
		                        </Badge>
		                      )}
		                      {deepEvalStatusLabel && (
	                        <Badge
	                          variant="secondary"
	                          className={`${deepEvalBadgeClass} rounded-full px-2 py-0.5 text-[11px] font-semibold`}
	                        >
	                          {deepEvalStatusLabel === "Fail" ? (
	                            <XCircle className="w-3 h-3 mr-1" />
	                          ) : (
	                            <CheckCircle2 className="w-3 h-3 mr-1" />
	                          )}
	                          {deepEvalStatusLabel}
		                        </Badge>
		                      )}
		                        <span className="text-[11px] text-gray-500 dark:text-gray-400">
		                          {formattedStartedAt ? `Start ${formattedStartedAt}` : "Start —"}
		                          {formattedEndedAt ? ` · End ${formattedEndedAt}` : ""}
		                          {runtimeLabel ? ` · Avg ${runtimeLabel}` : ""}
		                        </span>
		                      </div>

		                      <div className="flex flex-wrap items-center gap-2">
		                        {[
		                          {
		                            key: "eval_csv",
		                            label: "Eval CSV",
		                            borderClass: "border-blue-200 hover:bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:hover:bg-blue-950/20 dark:text-blue-200",
		                          },
		                          {
		                            key: "rag_csv",
		                            label: "RAG CSV",
		                            borderClass: "border-teal-200 hover:bg-teal-50 text-teal-700 dark:border-teal-900/40 dark:hover:bg-teal-950/20 dark:text-teal-200",
		                          },
		                        ].map((link) => {
		                          const url = resolveUrl(evaluation.eval_download_urls?.[link.key]);
			                          const isReady = Boolean(url) && !isRunning;
		                          const baseClass = `inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${link.borderClass}`;
		                          return isReady && url ? (
		                            <a
		                              key={link.key}
		                              href={url}
		                              target="_blank"
		                              rel="noreferrer"
		                              className={baseClass}
		                            >
		                              <Download className="mr-1 h-3.5 w-3.5" />
		                              {link.label}
		                            </a>
		                          ) : null;
		                        })}
		                        <TooltipProvider>
		                          <UiTooltip>
		                            <TooltipTrigger asChild>
		                              <Button
		                                type="button"
		                                variant="ghost"
		                                className="h-8 w-8 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
		                                aria-label="Refresh download links"
			                                disabled={isRunning || refreshDownloadMutation.isPending}
		                                onClick={() => refreshDownloadMutation.mutate(evaluation)}
		                              >
		                                <RefreshCw className={`w-4 h-4 ${refreshDownloadMutation.isPending ? "animate-spin" : ""}`} />
		                              </Button>
		                            </TooltipTrigger>
		                            <TooltipContent
		                              side="bottom"
		                              align="end"
		                              sideOffset={8}
		                              collisionPadding={12}
		                              className="text-xs z-50"
		                            >
		                              Refresh links
		                            </TooltipContent>
		                          </UiTooltip>
		                        </TooltipProvider>
		                      </div>
		                    </div>

		                    {String(evaluation.evaluation_type || "").startsWith("rag_") && (
	                      <div className="text-[11px] text-gray-500 dark:text-gray-400">
	                        {evaluation.eval_index_name ? `Eval Index: ${evaluation.eval_index_name}` : null}
	                        {evaluation.eval_username ? ` • User: ${evaluation.eval_username}` : null}
	                        {evaluation.eval_run_id ? ` • Run: ${evaluation.eval_run_id}` : null}
	                      </div>
	                    )}

		                    {showTestScenario && (
		                      <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2 text-xs text-gray-700 dark:text-gray-300 line-clamp-2">
		                        {testScenarioText}
		                      </div>
		                    )}

		                    {(underTestDisplay || deepevalModelValue || (goldenModelValue && !hideGoldenModelForDataset)) && (
	                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
	                        {underTestDisplay && (
	                          <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
	                            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
	                              Model Under Test
	                            </p>
	                            <p className="mt-1 text-[13px] font-semibold text-gray-900 dark:text-gray-100">
	                              {underTestDisplay}
	                            </p>
	                          </div>
	                        )}
	                        {deepevalModelValue && (
	                          <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
	                            <p className="text-[10px] uppercase tracking-wide text-blue-700 dark:text-blue-200">
	                              Eval Model
	                            </p>
	                            <p className="mt-1 text-[13px] font-semibold text-blue-900 dark:text-blue-50">
	                              {deepevalModelValue}
	                            </p>
	                          </div>
	                        )}
	                        {goldenModelValue && !hideGoldenModelForDataset && (
	                          <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
	                            <p className="text-[10px] uppercase tracking-wide text-amber-800 dark:text-amber-200">
	                              Golden Model
	                            </p>
	                            <p className="mt-1 text-[13px] font-semibold text-amber-900 dark:text-amber-50">
	                              {goldenModelValue}
	                            </p>
	                          </div>
		                        )}
		                      </div>
			                    )}

		                    {isAgentEvaluation && hasAgentSummary && !isRunning && (
		                      <AgentEvaluationSummaryCard
		                        evaluation={evaluation}
		                        completedRunCount={agentCompletedRunCount}
		                      />
		                    )}
		                    {isAgentEvaluation && Array.isArray(evaluation.eval_api_response?.case_rows) && (
		                      <AgentEvalCasesList cases={evaluation.eval_api_response.case_rows} />
		                    )}

		                    {!isRunning && !isAgentEvaluation && (
		                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
	                      <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
	                        <div className="flex items-center justify-between gap-2">
	                          <div className="flex items-center gap-2">
	                            <Sparkles className="w-4 h-4 text-purple-600" />
	                            <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
	                              Overall
	                            </p>
	                          </div>
	                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${passPill}`}>
	                            {passFail === true ? "Pass" : passFail === false ? "Below threshold" : "—"}
	                          </span>
	                        </div>
	                        <div className="mt-1 flex items-end justify-between gap-2">
	                          <p className="text-xl font-semibold text-gray-900 dark:text-gray-100">
	                            {formatMetricScore(overallNumeric)}
	                          </p>
	                          <span className="text-[11px] text-gray-500 dark:text-gray-400">
	                            Threshold {overallThresholdDisplay}
	                          </span>
	                        </div>
	                      </div>
		                      <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
		                        <div className="flex items-center gap-2">
		                          <TrendingUp className="w-4 h-4 text-emerald-600" />
		                          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
		                            Quality
		                          </p>
		                          {qualityMetricCount > 0 && (
		                            <TooltipProvider>
		                              <UiTooltip>
		                                <TooltipTrigger asChild>
		                                  <button
		                                    type="button"
		                                    className="ml-auto inline-flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
		                                    aria-label="Quality metrics included"
		                                  >
		                                    <Info className="h-3.5 w-3.5" />
		                                  </button>
		                                </TooltipTrigger>
			                                <TooltipContent
			                                  side="bottom"
			                                  align="end"
			                                  sideOffset={8}
			                                  collisionPadding={12}
			                                  className="max-w-[360px] text-xs z-50"
			                                >
			                                  {qualityMetricNames}
			                                </TooltipContent>
		                              </UiTooltip>
		                            </TooltipProvider>
		                          )}
		                        </div>
		                        <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
		                          {formatMetricScore(qualityScore)}
		                        </p>
		                        <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
		                          Higher is better
		                        </p>
		                        {qualityMetricCount > 0 && (
		                          <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
		                            Includes {qualityMetricCount} metrics
		                          </p>
		                        )}
		                      </div>
		                      <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
		                        <div className="flex items-center gap-2">
		                          <Shield className="w-4 h-4 text-orange-600" />
		                          <p className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
		                            Safety Risk
		                          </p>
		                          {riskMetricCount > 0 && (
		                            <TooltipProvider>
		                              <UiTooltip>
		                                <TooltipTrigger asChild>
		                                  <button
		                                    type="button"
		                                    className="ml-auto inline-flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
		                                    aria-label="Safety risk metrics included"
		                                  >
		                                    <Info className="h-3.5 w-3.5" />
		                                  </button>
		                                </TooltipTrigger>
			                                <TooltipContent
			                                  side="bottom"
			                                  align="end"
			                                  sideOffset={8}
			                                  collisionPadding={12}
			                                  className="max-w-[360px] text-xs z-50"
			                                >
			                                  {riskMetricNames}
			                                </TooltipContent>
		                              </UiTooltip>
		                            </TooltipProvider>
		                          )}
		                        </div>
		                        <p className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">
		                          {formatMetricScore(riskScore)}
		                        </p>
		                        <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
		                          Lower is better
		                        </p>
		                        {riskMetricCount > 0 && (
		                          <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
		                            Includes {riskMetricCount} metrics
		                          </p>
		                        )}
		                      </div>
			                    </div>
			                    )}

			                    {hasMetricDetails && (() => {
	                      const orderedIds = [
	                        ...DEEPEVAL_METRICS.map((m) => m.id),
	                        ...Object.keys(metricDetails).filter((id) => !DEEPEVAL_METRICS.some((m) => m.id === id)),
	                      ];
	                      const uniqueOrdered = Array.from(new Set(orderedIds)).filter((id) => metricDetails[id]);
	                      const safeSelectedId = selectedMetricId && metricDetails[selectedMetricId]
	                        ? selectedMetricId
	                        : uniqueOrdered[0];
	                      const selectedResult = safeSelectedId ? (metricDetails[safeSelectedId] || {}) : {};
	                      const selectedMeta = safeSelectedId
	                        ? DEEPEVAL_METRICS.find((m) => m.id === safeSelectedId) || null
	                        : null;
	                      const selectedScore = Number(selectedResult.score);
	                      const selectedHealth = getMetricHealth(selectedMeta, selectedScore);
	                      const selectedPill = getHealthPillClasses(selectedHealth);

	                      return (
	                        <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-3">
	                          <div className="flex items-center justify-between gap-2">
	                            <div className="flex items-center gap-2">
	                              <ClipboardList className="w-4 h-4 text-gray-600 dark:text-gray-300" />
	                              <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
	                                Metrics
	                              </p>
	                            </div>
	                            {isReasoningLoading && (
	                              <span className="text-[11px] text-gray-400 dark:text-gray-500">
	                                Fetching reasoning…
	                              </span>
	                            )}
	                          </div>

	                          <div className="mt-2 grid grid-cols-1 lg:grid-cols-3 gap-2">
	                            <div className="lg:col-span-2">
	                              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
	                                {uniqueOrdered.map((metricId) => {
	                                  const result = metricDetails[metricId] || {};
	                                  const metric = DEEPEVAL_METRICS.find((m) => m.id === metricId) || null;
	                                  const Icon = metric?.icon || Target;
	                                  const scoreNumeric = Number(result.score);
	                                  const remoteEntry = remoteMetricDetails?.[metricId];
	                                  const shouldHideScore =
	                                    remoteEntry?.reason && !Number.isFinite(Number(remoteEntry?.score));
	                                  const showScore = Number.isFinite(scoreNumeric) && !shouldHideScore;
	                                  const health = getMetricHealth(metric, scoreNumeric);
	                                  const scorePillClasses = getHealthPillClasses(health);
	                                  const barPct = showScore ? clamp01(scoreNumeric) * 100 : 0;
	                                  const isSelected = metricId === safeSelectedId;
	                                  const thresholdNumeric = metric?.threshold != null ? Number(metric.threshold) : NaN;
	                                  const hasThreshold = Number.isFinite(thresholdNumeric);
	                                  const thresholdLabel = hasThreshold
	                                    ? `${metric?.inverse ? "Max" : "Min"} ${thresholdNumeric.toFixed(2)}`
	                                    : null;

	                                  return (
	                                    <button
	                                      key={metricId}
	                                      type="button"
	                                      onClick={() => setSelectedMetricId(metricId)}
	                                      className={`group rounded-xl border p-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/40 ${
	                                        isSelected
	                                          ? "border-purple-400/80 dark:border-purple-500/60 bg-purple-50/50 dark:bg-purple-950/20 shadow-sm ring-1 ring-purple-400/20"
	                                          : "border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface))] hover:border-gray-300 dark:hover:border-gray-700"
	                                      }`}
	                                    >
	                                      <div className="flex items-start justify-between gap-2">
	                                        <div className="min-w-0">
	                                          <div className="flex items-center gap-2">
	                                            <span
	                                              className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border ${
	                                                isSelected
	                                                  ? "border-purple-200/80 dark:border-purple-800 bg-purple-100/70 dark:bg-purple-950/30 text-purple-700 dark:text-purple-200"
	                                                  : "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-800 dark:bg-gray-900/40 dark:text-gray-200"
	                                              }`}
	                                            >
	                                              <Icon className="h-3.5 w-3.5" />
	                                            </span>
	                                            <div className="min-w-0">
	                                              <p
	                                                className="text-[12px] font-semibold leading-snug text-gray-900 dark:text-gray-100 line-clamp-2"
	                                                title={metric?.name || metricId}
	                                              >
	                                                {metric?.name || metricId}
	                                              </p>
	                                              {metric?.inverse ? (
	                                                <p className="text-[10px] text-gray-500 dark:text-gray-400">
	                                                  Lower is better
	                                                </p>
	                                              ) : (
	                                                <p className="text-[10px] text-gray-500 dark:text-gray-400">
	                                                  Higher is better
	                                                </p>
	                                              )}
	                                            </div>
	                                          </div>
	                                        </div>

		                                        <div className="shrink-0 flex flex-col items-end gap-1">
		                                          <span
		                                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${scorePillClasses}`}
		                                          >
		                                            {showScore ? formatMetricScore(scoreNumeric) : "—"}
		                                          </span>
		                                          {thresholdLabel && (
		                                            <span className="inline-flex items-center rounded-full border border-gray-200/80 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-950/30 px-2 py-0.5 text-[10px] font-semibold text-gray-600 dark:text-gray-300">
		                                              <Target className="mr-1 h-3 w-3 opacity-70" />
		                                              {thresholdLabel}
		                                            </span>
		                                          )}
		                                        </div>
		                                      </div>

	                                      {showScore && (
	                                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
	                                          <div
	                                            className={`${health === false ? "bg-rose-500" : "bg-emerald-500"} h-full`}
	                                            style={{ width: `${barPct}%` }}
	                                          />
	                                        </div>
	                                      )}
	                                    </button>
	                                  );
	                                })}
	                              </div>
	                            </div>

	                            <div className="rounded-xl border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface))] p-2">
	                              {safeSelectedId ? (
	                                <div className="space-y-2">
		                                  <div className="flex items-start justify-between gap-2">
		                                    <div className="min-w-0">
		                                      <p
		                                        className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-2"
		                                        title={selectedMeta?.name || safeSelectedId}
		                                      >
		                                        {selectedMeta?.name || safeSelectedId}
		                                      </p>
		                                    {selectedMeta?.description && (
		                                      <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
		                                        {selectedMeta.description}
		                                      </p>
		                                    )}
		                                    </div>
		                                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${selectedPill}`}>
		                                      {Number.isFinite(selectedScore) ? formatMetricScore(selectedScore) : "—"}
		                                    </span>
		                                  </div>

	                                  {selectedMeta?.threshold != null && (
	                                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
	                                      Threshold: {Number(selectedMeta.threshold).toFixed(2)} ·{" "}
	                                      {selectedMeta.inverse ? "Pass if score ≤ threshold" : "Pass if score ≥ threshold"}
	                                    </div>
	                                  )}

	                                  {selectedResult?.reason ? (
	                                    <details className="rounded-lg border border-gray-200/70 dark:border-gray-800 bg-[rgb(var(--md-surface-variant))] p-2">
	                                      <summary className="cursor-pointer text-[11px] font-semibold text-gray-700 dark:text-gray-200">
	                                        Why this score
	                                      </summary>
	                                      <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-300 whitespace-pre-wrap">
	                                        {String(selectedResult.reason)}
	                                      </p>
	                                    </details>
	                                  ) : null}
	                                </div>
	                              ) : (
	                                <div className="text-sm text-gray-500 dark:text-gray-400">Select a metric to view details.</div>
	                              )}
	                            </div>
	                          </div>
	                        </div>
	                      );
	                    })()}

		                    {!isRunning && !hasAnyResults && (
	                      <p className="text-xs uppercase text-orange-500 font-semibold tracking-wide">
	                        {missingDownloads && hasRefreshableResultsUrl ? "RESULTS PENDING (REFRESH LINKS)" : "RESULTS NOT FOUND"}
	                      </p>
	                    )}

		                    {/* Downloads moved to header row */}

	                    {evaluation.schedule_config?.enabled && (
	                      <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-200 dark:border-purple-800">
	                        <p className="text-xs text-purple-900 dark:text-purple-200 flex items-center gap-1">
	                          <Clock className="w-3 h-3" />
	                          Scheduled: {evaluation.schedule_config.cron_expression} ({evaluation.schedule_config.timezone})
	                        </p>
	                        {evaluation.schedule_config.next_run_at && (
	                          <p className="text-xs text-purple-700 dark:text-purple-300 mt-1">
	                            Next run: {new Date(evaluation.schedule_config.next_run_at).toLocaleString()}
	                          </p>
	                        )}
	                      </div>
	                    )}
	                  </div>
	                );
	              })()
	            ) : (
	              <div className="text-sm text-gray-500 dark:text-gray-400">No evaluation selected.</div>
	            )}
	          </div>
	        </DialogContent>
	      </Dialog>
	    </div>
	  );
	}
