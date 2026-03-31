import { loadConfig } from "../config/config.js";
import {
  mergeSessionEntry,
  resolveStorePath,
  resolveSessionStoreEntry,
  type PendingMissionNotification,
  type SessionEntry,
  type SessionLastDeliveredMission,
  type SessionMissionEvent,
  updateSessionStore,
  updateSessionStoreEntry,
} from "../config/sessions.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TaskRegistryHookEvent, TaskRegistryHooks } from "./task-registry.store.js";
import type { TaskDeliveryStatus, TaskRecord, TaskStatus } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/mission-runtime");
const MAX_MISSION_EVENT_HISTORY = 10;
export const MISSION_WAKE_TTL_MS = 60_000;
export const MISSION_WAKE_MAX_ATTEMPTS = 10;

function compactText(value: string | null | undefined, maxChars = 320): string | undefined {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function resolveMissionStorePath(sessionKey: string): string {
  const cfg = loadConfig();
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  return resolveStorePath(cfg.session?.store, agentId ? { agentId } : undefined);
}

function isVisibleTerminalDeliveryStatus(
  status: TaskDeliveryStatus | undefined,
): status is "delivered" | "session_queued" {
  return status === "delivered" || status === "session_queued";
}

function isTerminalStatus(status: TaskStatus | undefined): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function resolveMissionId(task: TaskRecord): string {
  return task.sourceId?.trim() || task.runId?.trim() || task.taskId;
}

function resolveWorkerId(task: TaskRecord): string {
  return task.childSessionKey?.trim() || task.runId?.trim() || task.taskId;
}

function resolveMissionFinalState(task: TaskRecord): string {
  switch (task.status) {
    case "succeeded":
      return "completed";
    case "failed":
    case "timed_out":
    case "cancelled":
    case "lost":
      return task.status;
    default:
      return task.status;
  }
}

function buildMissionAwarenessSummary(task: TaskRecord): string | undefined {
  const finalState = resolveMissionFinalState(task);
  return (
    compactText(task.terminalSummary, 280) ??
    compactText(task.error, 280) ??
    compactText(task.progressSummary, 280) ??
    compactText(task.label, 120) ??
    compactText(task.task, 120) ??
    (finalState === "completed" ? "completed successfully" : finalState)
  );
}

function buildMissionSystemEventText(task: TaskRecord): string {
  const missionId = resolveMissionId(task);
  const state = resolveMissionFinalState(task);
  const summary = buildMissionAwarenessSummary(task);
  return `Worker completion: ${missionId} (${state})${summary ? ` — ${summary}` : ""}`;
}

function buildLastDeliveredMission(task: TaskRecord): SessionLastDeliveredMission {
  return {
    missionId: resolveMissionId(task),
    workerId: resolveWorkerId(task),
    state: resolveMissionFinalState(task),
    summary: buildMissionAwarenessSummary(task) ?? null,
    artifactPath: null,
    deliveredAt: task.lastEventAt ?? task.endedAt ?? Date.now(),
  };
}

function buildMissionEventRecord(task: TaskRecord): SessionMissionEvent {
  const deliveredAt = task.lastEventAt ?? task.endedAt ?? Date.now();
  return {
    missionId: resolveMissionId(task),
    workerId: resolveWorkerId(task),
    state: resolveMissionFinalState(task),
    summary: buildMissionAwarenessSummary(task) ?? null,
    artifactPath: null,
    deliveredAt,
  };
}

function buildPendingMissionNotification(task: TaskRecord): PendingMissionNotification {
  const deliveredAtMs = task.lastEventAt ?? task.endedAt ?? Date.now();
  return {
    missionId: resolveMissionId(task),
    workerId: resolveWorkerId(task),
    finalState: resolveMissionFinalState(task),
    statusSummary: buildMissionAwarenessSummary(task) ?? null,
    artifactPath: null,
    deliveredAtMs,
    attempts: 0,
    expiresAtMs: deliveredAtMs + MISSION_WAKE_TTL_MS,
  };
}

function readPendingMissionMap(
  entry: SessionEntry | undefined,
): Record<string, PendingMissionNotification> {
  const raw = entry?.pendingMissionNotifications;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw;
}

function appendMissionEventHistory(
  current: SessionMissionEvent[] | null | undefined,
  nextEvent: SessionMissionEvent,
): SessionMissionEvent[] {
  const existing = Array.isArray(current) ? current.filter(Boolean) : [];
  const filtered = existing.filter(
    (entry) =>
      !(
        entry.missionId === nextEvent.missionId &&
        entry.workerId === nextEvent.workerId &&
        entry.deliveredAt === nextEvent.deliveredAt
      ),
  );
  return [nextEvent, ...filtered]
    .sort((left, right) => (right.deliveredAt ?? 0) - (left.deliveredAt ?? 0))
    .slice(0, MAX_MISSION_EVENT_HISTORY);
}

function shouldProjectMissionCompletion(params: {
  task: TaskRecord;
  previous?: TaskRecord;
}): boolean {
  const { task, previous } = params;
  if (!task.requesterSessionKey.trim() || task.notifyPolicy === "silent") {
    return false;
  }
  if (!isTerminalStatus(task.status) || !isVisibleTerminalDeliveryStatus(task.deliveryStatus)) {
    return false;
  }
  if (!previous) {
    return true;
  }
  const previousVisible =
    isTerminalStatus(previous.status) && isVisibleTerminalDeliveryStatus(previous.deliveryStatus);
  if (!previousVisible) {
    return true;
  }
  return (
    previous.deliveryStatus !== task.deliveryStatus ||
    previous.status !== task.status ||
    previous.endedAt !== task.endedAt ||
    previous.terminalSummary !== task.terminalSummary ||
    previous.error !== task.error
  );
}

async function persistMissionCompletionProjection(task: TaskRecord): Promise<void> {
  const sessionKey = task.requesterSessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const storePath = resolveMissionStorePath(sessionKey);
  const lastDeliveredMission = buildLastDeliveredMission(task);
  const missionEvent = buildMissionEventRecord(task);
  const pendingNotification = buildPendingMissionNotification(task);
  const continuitySummary =
    compactText(
      `Mission ${lastDeliveredMission.missionId} ${lastDeliveredMission.state}${lastDeliveredMission.summary ? `: ${lastDeliveredMission.summary}` : ""}`,
      280,
    ) ?? null;
  await updateSessionStore(storePath, async (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    const pending = readPendingMissionMap(existing);
    store[resolved.normalizedKey] = mergeSessionEntry(existing, {
      lastDeliveredMission,
      recentMissionEvents: appendMissionEventHistory(existing?.recentMissionEvents, missionEvent),
      pendingMissionNotifications: {
        ...pending,
        [pendingNotification.missionId]: pendingNotification,
      },
      continuitySummary,
      continuityUpdatedAt: missionEvent.deliveredAt,
      updatedAt: Date.now(),
    });
    for (const legacyKey of resolved.legacyKeys) {
      if (legacyKey !== resolved.normalizedKey) {
        delete store[legacyKey];
      }
    }
  });
}

async function emitMissionCompletedHook(task: TaskRecord): Promise<void> {
  const sessionKey = task.requesterSessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const context = {
    missionId: resolveMissionId(task),
    workerId: resolveWorkerId(task),
    finalState: resolveMissionFinalState(task),
    statusSummary: buildMissionAwarenessSummary(task) ?? null,
    artifactPath: null,
    deliveredAtMs: task.lastEventAt ?? task.endedAt ?? Date.now(),
    requesterSessionKey: sessionKey,
    childSessionKey: task.childSessionKey?.trim() || null,
    deliveryState: task.deliveryStatus,
    eventText: buildMissionSystemEventText(task),
  };
  await triggerInternalHook(createInternalHookEvent("agent", "mission:completed", sessionKey, context));
}

async function handleTaskRegistryEvent(event: TaskRegistryHookEvent): Promise<void> {
  if (event.kind !== "upserted") {
    return;
  }
  if (!shouldProjectMissionCompletion({ task: event.task, previous: event.previous })) {
    return;
  }
  try {
    await persistMissionCompletionProjection(event.task);
    await emitMissionCompletedHook(event.task);
  } catch (error) {
    log.warn("Failed to project mission completion from task registry", {
      taskId: event.task.taskId,
      sessionKey: event.task.requesterSessionKey,
      error,
    });
  }
}

export function createTaskRegistryMissionHooks(): TaskRegistryHooks {
  return {
    onEvent: (event) => {
      void handleTaskRegistryEvent(event);
    },
  };
}

export function readPendingMissionNotificationRecords(
  entry: SessionEntry | undefined,
): PendingMissionNotification[] {
  return Object.values(readPendingMissionMap(entry))
    .filter((record) => Boolean(record?.missionId))
    .sort((left, right) => (left.deliveredAtMs ?? 0) - (right.deliveredAtMs ?? 0));
}

export async function clearPendingMissionNotifications(
  sessionKey: string,
  missionIds: string[],
): Promise<void> {
  const wanted = new Set(
    missionIds
      .filter((missionId) => typeof missionId === "string" && missionId.trim())
      .map((missionId) => missionId.trim()),
  );
  if (!sessionKey.trim() || wanted.size === 0) {
    return;
  }
  await updateSessionStoreEntry({
    storePath: resolveMissionStorePath(sessionKey),
    sessionKey,
    update: async (existing) => {
      const pending = { ...readPendingMissionMap(existing) };
      let changed = false;
      for (const missionId of wanted) {
        if (missionId in pending) {
          delete pending[missionId];
          changed = true;
        }
      }
      if (!changed) {
        return null;
      }
      return {
        pendingMissionNotifications: Object.keys(pending).length > 0 ? pending : null,
        updatedAt: Date.now(),
      };
    },
  });
}

export async function incrementPendingMissionAttempts(
  sessionKey: string,
  missionIds: string[],
): Promise<void> {
  const wanted = new Set(
    missionIds
      .filter((missionId) => typeof missionId === "string" && missionId.trim())
      .map((missionId) => missionId.trim()),
  );
  if (!sessionKey.trim() || wanted.size === 0) {
    return;
  }
  await updateSessionStoreEntry({
    storePath: resolveMissionStorePath(sessionKey),
    sessionKey,
    update: async (existing) => {
      const pending = readPendingMissionMap(existing);
      let changed = false;
      const next: Record<string, PendingMissionNotification> = { ...pending };
      for (const missionId of wanted) {
        const current = pending[missionId];
        if (!current) {
          continue;
        }
        next[missionId] = {
          ...current,
          attempts: (current.attempts ?? 0) + 1,
        };
        changed = true;
      }
      if (!changed) {
        return null;
      }
      return {
        pendingMissionNotifications: next,
        updatedAt: Date.now(),
      };
    },
  });
}

export async function pruneExpiredPendingMissionNotifications(sessionKey: string): Promise<void> {
  if (!sessionKey.trim()) {
    return;
  }
  const now = Date.now();
  await updateSessionStoreEntry({
    storePath: resolveMissionStorePath(sessionKey),
    sessionKey,
    update: async (existing) => {
      const pending = readPendingMissionMap(existing);
      const liveEntries = Object.entries(pending).filter(
        ([, record]) => (record.expiresAtMs ?? 0) > now && (record.attempts ?? 0) < MISSION_WAKE_MAX_ATTEMPTS,
      );
      if (liveEntries.length === Object.keys(pending).length) {
        return null;
      }
      return {
        pendingMissionNotifications:
          liveEntries.length > 0 ? Object.fromEntries(liveEntries) : null,
        updatedAt: Date.now(),
      };
    },
  });
}

export function buildMissionWakeMessage(records: PendingMissionNotification[]): string {
  const lines = [
    "One or more delegated missions for this session have completed.",
    "Raw completion receipts already reached the user.",
    "Review the completions and send the user a concise, helpful follow-up now.",
    "Summarize what finished, the concrete outcome, and what should happen next. Be proactive and do not repeat the raw receipt verbatim.",
  ];
  for (const record of records.slice(0, 5)) {
    lines.push(
      `- ${record.missionId} (${record.finalState})${record.statusSummary ? ` — ${record.statusSummary}` : ""}${record.artifactPath ? ` | artifact: ${record.artifactPath}` : ""}`,
    );
  }
  if (records.length > 5) {
    lines.push(`- +${records.length - 5} more pending completions`);
  }
  return lines.join("\n");
}

export function isTransientMissionWakeFailure(value: unknown): boolean {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value
        ? (
            (value as { error?: string }).error?.trim() ||
            (value as { summary?: string }).summary?.trim() ||
            ""
          )
        : "";
  return /busy|queue|timeout|temporar|requests-in-flight|rate limit|locked/i.test(text);
}

export async function recoverPendingMissionWakeSessions(): Promise<string[]> {
  const cfg = loadConfig();
  const { store } = await import("../gateway/session-utils.js").then((mod) =>
    mod.loadCombinedSessionStoreForGateway(cfg),
  );
  return Object.entries(store)
    .filter(([, entry]) => readPendingMissionNotificationRecords(entry).length > 0)
    .map(([sessionKey]) => sessionKey);
}

export const __testing = {
  buildMissionSystemEventText,
  buildMissionAwarenessSummary,
  buildPendingMissionNotification,
  buildLastDeliveredMission,
  buildMissionEventRecord,
  shouldProjectMissionCompletion,
  readPendingMissionMap,
  resolveMissionId,
  resolveWorkerId,
  resolveMissionFinalState,
};
