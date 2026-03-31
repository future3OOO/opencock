import { loadSessionEntry } from "../gateway/session-utils.js";
import {
  reconcileInspectableTasks,
  reconcileTaskLookupToken,
} from "../tasks/task-registry.reconcile.js";
import type { TaskDeliveryStatus, TaskRecord } from "../tasks/task-registry.types.js";
import { buildCompactReceipt, buildWorkerTask, normalizeOptionalText } from "./format.js";
import type { OrchestrationRuntimeConfig } from "./runtime-config.js";
import {
  buildOrchestrationMissionLabel,
  buildOrchestrationMissionStatus,
  buildOrchestrationSuppressionKey,
  findSuppressedOrchestrationTask,
  isOrchestratedMissionTask,
} from "./runtime-primitives.js";
import { readSessionMissionBinding } from "./session-state.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function utcSlug(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}z$/i, "z")
    .toLowerCase();
}

function makeId(prefix: string, label: string, maxSlug = 40): string {
  const slug = slugify(label).slice(0, maxSlug) || prefix;
  return `${prefix}-${slug}-${utcSlug()}`;
}

export function resolveMissionTask(sessionKey: string, missionId?: string): TaskRecord | undefined {
  const normalizedMissionId = normalizeOptionalText(missionId);
  if (normalizedMissionId) {
    const task = reconcileTaskLookupToken(normalizedMissionId);
    return task && isOrchestratedMissionTask(task) ? task : undefined;
  }
  const loaded = loadSessionEntry(sessionKey);
  const binding = readSessionMissionBinding(loaded.entry);
  if (binding.activeMissionId) {
    const task = reconcileTaskLookupToken(binding.activeMissionId);
    if (task && isOrchestratedMissionTask(task)) {
      return task;
    }
  }
  return listInspectableOrchestratedTasks().find(
    (task) => task.requesterSessionKey === loaded.canonicalKey && task.status === "running",
  );
}

export function listInspectableOrchestratedTasks(): TaskRecord[] {
  return reconcileInspectableTasks().filter((task) => isOrchestratedMissionTask(task));
}

export function listInspectableTasksForSuppressionKey(params: {
  sessionKey: string;
  suppressionKey: string;
}): TaskRecord[] {
  const suppressionKey = normalizeOptionalText(params.suppressionKey);
  if (!suppressionKey) {
    return [];
  }
  return listInspectableOrchestratedTasks().filter(
    (task) =>
      task.requesterSessionKey === params.sessionKey &&
      task.orchestrationSuppressionKey?.trim() === suppressionKey,
  );
}

export function resolveMissionRunId(task: TaskRecord): string | undefined {
  return normalizeOptionalText(task.runId) ?? normalizeOptionalText(task.sourceId);
}

export function resolveSpawnSurface(surface: string | undefined, sessionKey: string): string {
  const normalized = normalizeOptionalText(surface);
  if (normalized) {
    return normalized;
  }
  if (sessionKey.includes(":whatsapp:")) {
    return "whatsapp";
  }
  if (sessionKey.includes(":telegram:")) {
    return "telegram";
  }
  return "general";
}

export function mapMissionStateToTaskStatus(
  value: string | null | undefined,
): "succeeded" | "failed" | "timed_out" | "cancelled" {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  switch (normalized) {
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    default:
      return "succeeded";
  }
}

export function mapDeliveryStateToTaskDeliveryStatus(
  value: string | null | undefined,
  fallback: TaskDeliveryStatus,
): TaskDeliveryStatus {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  switch (normalized) {
    case "pending":
      return "pending";
    case "delivered":
      return "delivered";
    case "session_queued":
      return "session_queued";
    case "permanent_failure":
      return "failed";
    default:
      return fallback;
  }
}

export function delegateRejected(message: string) {
  return {
    status: "error" as const,
    category: "delegate_rejected" as const,
    error: message,
  };
}

export function buildPreparedDelegatePlan(params: {
  sessionKey: string;
  routingClass: string;
  task: string;
  statusSummary: string;
  surface: string;
  toolNeeds?: string[];
  timeoutSeconds?: number;
  config?: Pick<OrchestrationRuntimeConfig, "spawnSuppression">;
}) {
  const missionLabel = buildOrchestrationMissionLabel({
    routingClass: params.routingClass,
    sourceText: params.statusSummary,
  });
  const suppressionKey = buildOrchestrationSuppressionKey({
    sessionMode: "orchestrator",
    userOrChannel: params.sessionKey,
    missionLabel,
    surface: params.surface,
    toolNeeds: params.toolNeeds,
  });
  const suppression = findSuppressedOrchestrationTask({
    suppressionKey,
    tasks: listInspectableTasksForSuppressionKey({
      sessionKey: params.sessionKey,
      suppressionKey,
    }),
    cooldownSeconds: params.config?.spawnSuppression.cooldownSeconds,
  });
  if (suppression.suppress && suppression.task) {
    const existing = buildOrchestrationMissionStatus(suppression.task);
    return {
      status: "accepted" as const,
      action: "suppressed" as const,
      missionId: existing.missionId,
      workerId: existing.workerId,
      routingClass: existing.routingClass ?? params.routingClass,
      suppressed: {
        reason: suppression.reason,
        existingMissionId: suppression.existingMissionId,
        existingWorkerId: suppression.existingWorkerId,
      },
      replyText: existing.replyText,
    };
  }
  const missionId = makeId("m", missionLabel);
  const workerId = makeId("w", params.routingClass, 30);
  return {
    status: "accepted" as const,
    action: "delegate" as const,
    missionId,
    workerId,
    routingClass: params.routingClass,
    missionLabel,
    surface: params.surface,
    suppressionKey,
    statusSummary: params.statusSummary,
    workerTask: buildWorkerTask({
      task: params.task,
      missionId,
      routingClass: params.routingClass,
      sessionKey: params.sessionKey,
      surface: params.surface,
      toolNeeds: params.toolNeeds,
    }),
    workerLabel: params.routingClass,
    runTimeoutSeconds: params.timeoutSeconds,
    replyText: buildCompactReceipt(missionId, workerId, params.routingClass),
  };
}
