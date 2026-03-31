import crypto from "node:crypto";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

export type OrchestrationChannel = "cli" | "telegram" | "whatsapp" | "unknown";

export type OrchestrationMissionStatus = {
  found: true;
  missionId: string;
  workerId: string;
  state: string;
  routingClass?: string;
  surface?: string;
  statusSummary?: string;
  ownerSessionKey: string;
  workerSessionKey?: string;
  processSessionId?: string;
  deliveryState: TaskRecord["deliveryStatus"];
  replyText: string;
};

export type OrchestrationSuppressionResult = {
  suppress: boolean;
  reason: "live_owner_exists" | "cooldown_active" | null;
  task?: TaskRecord;
  existingMissionId?: string;
  existingWorkerId?: string;
};

const CONTINUATION_PATTERNS = /\b(continue|still working|what.?s happening|how.?s it going)\b/i;
const STANDALONE_CONTINUATION = /^\s*(status|progress|update)\s*\??\s*$/i;
const PUNCTUATION_CONTINUATION = new Set(["?", "??"]);
export const DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS = 30;

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactText(value: string | null | undefined, maxChars = 320): string | undefined {
  const trimmed = normalizeOptionalText(
    typeof value === "string" ? value.replace(/\s+/g, " ") : (value ?? undefined),
  );
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function resolveMissionId(task: TaskRecord): string {
  return task.sourceId?.trim() || task.taskId;
}

function resolveWorkerId(task: TaskRecord): string {
  return (
    task.orchestrationWorkerId?.trim() || task.childSessionKey?.trim() || task.runId || task.taskId
  );
}

export function normalizeOrchestrationChannel(sessionKey: string): OrchestrationChannel {
  const lower = sessionKey.trim().toLowerCase();
  if (!lower) {
    return "unknown";
  }
  if (lower.includes(":telegram:")) {
    return lower.includes(":group:") || lower.includes(":supergroup:") ? "unknown" : "telegram";
  }
  if (lower.includes(":whatsapp:")) {
    return lower.includes(":group:") ? "unknown" : "whatsapp";
  }
  if (
    lower.startsWith("agent:main:main") ||
    lower.includes(":direct:") ||
    lower.includes(":cli:")
  ) {
    return "cli";
  }
  return lower.includes(":telegram:") || lower.includes(":whatsapp:") ? "unknown" : "cli";
}

export function isGroupOrchestratorSession(sessionKey: string): boolean {
  const lower = sessionKey.toLowerCase();
  return (
    normalizeOrchestrationChannel(sessionKey) === "unknown" &&
    (lower.includes(":group:") || lower.includes(":supergroup:"))
  );
}

export function isContinuationIntent(text: string): boolean {
  return CONTINUATION_PATTERNS.test(text) || STANDALONE_CONTINUATION.test(text);
}

export function isMinimalContinuationIntent(text: string): boolean {
  return PUNCTUATION_CONTINUATION.has(text.trim());
}

export function resolveContinuationIntent(params: {
  text: string;
  activeMissionId?: string | null;
  focusedWorkerId?: string | null;
}) {
  const activeMissionId = normalizeOptionalText(params.activeMissionId);
  if (!activeMissionId) {
    return { isContinuation: false, missionId: undefined, workerId: undefined };
  }
  if (!(isContinuationIntent(params.text) || isMinimalContinuationIntent(params.text))) {
    return { isContinuation: false, missionId: undefined, workerId: undefined };
  }
  return {
    isContinuation: true,
    missionId: activeMissionId,
    workerId: normalizeOptionalText(params.focusedWorkerId),
  };
}

export function buildOrchestrationMissionLabel(params: {
  routingClass: string;
  sourceText: string;
}): string {
  const sourceText = params.sourceText.trim() || params.routingClass;
  return `${params.routingClass}:${slugify(sourceText.slice(0, 60)) || params.routingClass}`;
}

export function buildOrchestrationSuppressionKey(params: {
  sessionMode: string;
  userOrChannel: string;
  missionLabel: string;
  surface: string;
  toolNeeds?: string[];
}): string {
  const normalizedTools = [
    ...new Set((params.toolNeeds ?? []).map((item) => item.trim()).filter(Boolean)),
  ]
    .toSorted()
    .join("|");
  const raw = [
    params.sessionMode.trim(),
    params.userOrChannel.trim(),
    params.missionLabel.trim(),
    params.surface.trim(),
    normalizedTools,
  ].join(":");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function isOrchestratedMissionTask(task: TaskRecord): boolean {
  return Boolean(
    task.sourceId?.trim() &&
    task.orchestrationWorkerId?.trim() &&
    task.orchestrationRoutingClass?.trim(),
  );
}

export function isDirectOrchestratorSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest?.trim().toLowerCase() ?? "";
  if (!rest) {
    return false;
  }
  return !rest.includes(":subagent:") && !rest.includes(":worker:") && !rest.startsWith("archive:");
}

export function resolveOrchestrationMissionState(task: TaskRecord): string {
  return task.status === "succeeded" ? "completed" : task.status;
}

export function resolveOrchestrationMissionSummary(task: TaskRecord): string | undefined {
  return (
    compactText(task.terminalSummary, 240) ??
    compactText(task.error, 240) ??
    compactText(task.progressSummary, 240) ??
    compactText(task.orchestrationStatusSummary, 160) ??
    compactText(task.label, 120) ??
    compactText(task.task, 120)
  );
}

export function buildOrchestrationMissionStatus(task: TaskRecord): OrchestrationMissionStatus {
  const missionId = resolveMissionId(task);
  const workerId = resolveWorkerId(task);
  const state = resolveOrchestrationMissionState(task);
  const statusSummary = resolveOrchestrationMissionSummary(task);
  return {
    found: true,
    missionId,
    workerId,
    state,
    routingClass: task.orchestrationRoutingClass,
    surface: task.orchestrationSurface,
    statusSummary,
    ownerSessionKey: task.requesterSessionKey,
    workerSessionKey: task.childSessionKey,
    processSessionId: task.runId,
    deliveryState: task.deliveryStatus,
    replyText: `Mission ${missionId} is ${state}${statusSummary ? `. ${statusSummary}` : "."}`,
  };
}

export function findSuppressedOrchestrationTask(params: {
  suppressionKey?: string;
  tasks: TaskRecord[];
  nowMs?: number;
  cooldownSeconds?: number;
}): OrchestrationSuppressionResult {
  const suppressionKey = normalizeOptionalText(params.suppressionKey);
  if (!suppressionKey) {
    return {
      suppress: false,
      reason: null,
    };
  }
  const nowMs = params.nowMs ?? Date.now();
  const cooldownMs =
    Math.max(0, params.cooldownSeconds ?? DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS) * 1000;
  for (const task of params.tasks) {
    if (task.orchestrationSuppressionKey?.trim() !== suppressionKey) {
      continue;
    }
    if (task.status === "running") {
      const status = buildOrchestrationMissionStatus(task);
      return {
        suppress: true,
        reason: "live_owner_exists",
        task,
        existingMissionId: status.missionId,
        existingWorkerId: status.workerId,
      };
    }
    const startedAt = task.startedAt ?? task.createdAt;
    if (cooldownMs > 0 && typeof startedAt === "number" && nowMs - startedAt < cooldownMs) {
      const status = buildOrchestrationMissionStatus(task);
      return {
        suppress: true,
        reason: "cooldown_active",
        task,
        existingMissionId: status.missionId,
        existingWorkerId: status.workerId,
      };
    }
  }
  return {
    suppress: false,
    reason: null,
  };
}
