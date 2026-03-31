import { loadSessionEntry } from "../gateway/session-utils.js";
import { createRunningTaskRun, markTaskRunLostById } from "../tasks/task-executor.js";
import { getTaskById } from "../tasks/task-registry.js";
import { resolveSpawnSurface } from "./control-plane.shared.js";
import { compactText, isDelegatableRoutingClass, normalizeOptionalText } from "./format.js";

function buildExternalSourceId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `external-${slug || "task"}-${Date.now()}`;
}

export async function registerExternalTaskFromSession(params: {
  sessionKey: string;
  routingClass: string;
  label: string;
  task: string;
  surface?: string;
  sourceId?: string;
  runId?: string;
  statusSummary?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  artifactPath?: string | null;
}) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  const routingClass = normalizeOptionalText(params.routingClass);
  const label = normalizeOptionalText(params.label);
  const task = normalizeOptionalText(params.task);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  if (!routingClass || !isDelegatableRoutingClass(routingClass)) {
    return {
      status: "error" as const,
      category: "delegate_rejected" as const,
      error: routingClass ? `Invalid routingClass "${routingClass}".` : "Missing routing class.",
    };
  }
  if (!label) {
    return {
      status: "error" as const,
      category: "delegate_rejected" as const,
      error: "Missing label.",
    };
  }
  if (!task) {
    return {
      status: "error" as const,
      category: "delegate_rejected" as const,
      error: "Missing task description.",
    };
  }

  const loaded = loadSessionEntry(sessionKey);
  const canonicalSessionKey = loaded.canonicalKey;
  const sourceId = normalizeOptionalText(params.sourceId) ?? buildExternalSourceId(label);
  const runId = normalizeOptionalText(params.runId) ?? sourceId;
  const summary =
    compactText(params.statusSummary, 240) ??
    "migrated from live workspace; no active execution mechanism yet";
  const detailParts = [
    normalizeOptionalText(params.worktreePath)
      ? `worktree=${normalizeOptionalText(params.worktreePath)}`
      : undefined,
    normalizeOptionalText(params.branch)
      ? `branch=${normalizeOptionalText(params.branch)}`
      : undefined,
    normalizeOptionalText(params.artifactPath)
      ? `artifact=${normalizeOptionalText(params.artifactPath)}`
      : undefined,
  ].filter(Boolean);
  const detailText = detailParts.length > 0 ? compactText(detailParts.join(" "), 320) : undefined;

  const created = createRunningTaskRun({
    runtime: "cli",
    sourceId,
    requesterSessionKey: canonicalSessionKey,
    runId,
    label,
    task,
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
    orchestrationWorkerId: sourceId,
    orchestrationRoutingClass: routingClass,
    orchestrationSurface: resolveSpawnSurface(params.surface, canonicalSessionKey),
    orchestrationStatusSummary: summary,
    progressSummary: detailText,
  });

  markTaskRunLostById({
    taskId: created.taskId,
    endedAt: Date.now(),
    lastEventAt: Date.now(),
    error: summary,
  });
  const registered = getTaskById(created.taskId) ?? created;
  return {
    status: "accepted" as const,
    action: "registered" as const,
    taskId: registered.taskId,
    sourceId,
    runId,
    routingClass,
    replyText: `Registered external task ${registered.taskId}.`,
    task: registered,
  };
}
