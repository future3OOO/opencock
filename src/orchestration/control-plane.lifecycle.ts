import { updateSessionStoreEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/task-executor.js";
import {
  findTaskBySourceId,
  listTasksForOrchestrationSuppressionKey,
} from "../tasks/task-registry.js";
import {
  delegateRejected,
  mapDeliveryStateToTaskDeliveryStatus,
  mapMissionStateToTaskStatus,
  resolveMissionRunId,
  resolveSpawnSurface,
} from "./control-plane.shared.js";
import { buildCompactCompletion, buildCompactReceipt, normalizeOptionalText } from "./format.js";
import {
  buildOrchestrationMissionStatus,
  DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS,
  findSuppressedOrchestrationTask,
  isOrchestratedMissionTask,
} from "./runtime-primitives.js";
import { listMissionsFromSession, statusFromSession } from "./service.js";
import { clearSessionMissionBindingIfMatches, setSessionMissionBinding } from "./session-state.js";

export async function commitDelegatedWorkerFromSession(params: {
  sessionKey: string;
  missionId: string;
  workerId: string;
  routingClass: string;
  mechanismId?: string | null;
  surface?: string;
  workerSessionKey?: string | null;
  processSessionId?: string | null;
  suppressionKey?: string | null;
  statusSummary?: string | null;
}) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  const missionId = normalizeOptionalText(params.missionId);
  const workerId = normalizeOptionalText(params.workerId);
  const routingClass = normalizeOptionalText(params.routingClass);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  if (!missionId || !workerId || !routingClass) {
    return delegateRejected("Missing mission, worker, or routing class.");
  }
  const loaded = loadSessionEntry(sessionKey);
  const canonicalSessionKey = loaded.canonicalKey;
  const suppressionKey = normalizeOptionalText(params.suppressionKey);
  if (suppressionKey) {
    const suppression = findSuppressedOrchestrationTask({
      suppressionKey,
      tasks: listTasksForOrchestrationSuppressionKey(suppressionKey).filter(
        (task) => task.requesterSessionKey === canonicalSessionKey,
      ),
      cooldownSeconds: DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS,
    });
    if (suppression.suppress && suppression.task) {
      const existing = buildOrchestrationMissionStatus(suppression.task);
      await setSessionMissionBinding({
        sessionKey: canonicalSessionKey,
        missionId: existing.missionId,
        workerId: existing.workerId,
        continuitySummary: buildCompactReceipt(
          existing.missionId,
          existing.workerId,
          existing.routingClass ?? routingClass,
        ),
      });
      return {
        status: "accepted" as const,
        action: "suppressed" as const,
        missionId: existing.missionId,
        workerId: existing.workerId,
        routingClass: existing.routingClass ?? routingClass,
        suppressed: {
          reason: suppression.reason,
          existingMissionId: suppression.existingMissionId,
          existingWorkerId: suppression.existingWorkerId,
        },
        replyText: existing.replyText,
      };
    }
  }
  const existing = findTaskBySourceId(missionId);
  const runId =
    normalizeOptionalText(params.processSessionId) ??
    normalizeOptionalText(params.mechanismId) ??
    missionId;
  const task =
    existing && isOrchestratedMissionTask(existing)
      ? existing
      : createRunningTaskRun({
          runtime: "subagent",
          sourceId: missionId,
          orchestrationWorkerId: workerId,
          orchestrationRoutingClass: routingClass,
          orchestrationSurface: resolveSpawnSurface(params.surface, canonicalSessionKey),
          orchestrationStatusSummary:
            normalizeOptionalText(params.statusSummary) ?? `dispatched: ${routingClass}`,
          orchestrationSuppressionKey: suppressionKey,
          requesterSessionKey: canonicalSessionKey,
          childSessionKey: normalizeOptionalText(params.workerSessionKey),
          runId,
          label: routingClass,
          task:
            normalizeOptionalText(params.statusSummary) ??
            `Mission ${missionId} dispatched via external orchestration bridge.`,
          deliveryStatus: "pending",
        });
  await setSessionMissionBinding({
    sessionKey: canonicalSessionKey,
    missionId,
    workerId,
    continuitySummary: buildCompactReceipt(missionId, workerId, routingClass),
  });
  await updateSessionStoreEntry({
    storePath: loaded.storePath,
    sessionKey: canonicalSessionKey,
    update: async (entry) => ({
      workerNoticeCount: Math.max(0, Number(entry?.workerNoticeCount ?? 0)) + 1,
      updatedAt: Date.now(),
    }),
  }).catch(() => null);
  return {
    status: "accepted" as const,
    action: "delegate" as const,
    missionId,
    workerId,
    routingClass,
    receipt: {
      action: "delegate",
      missionId,
      workerId,
      routingClass,
      mechanismKind: "sessions_spawn",
      mechanismId: normalizeOptionalText(params.mechanismId) ?? runId,
      state: task.status,
      startedAt: task.startedAt ?? task.createdAt,
    },
    replyText: buildCompactReceipt(missionId, workerId, routingClass),
  };
}

export async function completeMissionFromSession(params: {
  sessionKey: string;
  missionId: string;
  workerId: string;
  state?: string | null;
  statusSummary?: string | null;
  replyText?: string | null;
  artifactPath?: string | null;
  deliveryState?: string | null;
  clearBinding?: boolean;
}) {
  const missionId = normalizeOptionalText(params.missionId);
  const workerId = normalizeOptionalText(params.workerId);
  if (!missionId || !workerId) {
    return {
      action: "error" as const,
      error: "Missing mission or worker id.",
    };
  }
  const task = findTaskBySourceId(missionId);
  if (!task || !isOrchestratedMissionTask(task)) {
    return {
      action: "error" as const,
      missionId,
      workerId,
      error: `Unknown mission id: ${missionId}`,
    };
  }
  const finalState = normalizeOptionalText(params.state)?.toLowerCase() ?? "completed";
  const replyText = normalizeOptionalText(params.replyText);
  if (
    task.status !== "running" &&
    task.status !== "queued" &&
    buildOrchestrationMissionStatus(task).state !== finalState
  ) {
    const current = buildOrchestrationMissionStatus(task);
    return {
      action: "ignored" as const,
      missionId: current.missionId,
      workerId: current.workerId,
      state: current.state,
      deliveryState: current.deliveryState,
      replyText:
        replyText ??
        buildCompactCompletion(current.missionId, current.state, current.statusSummary),
      ignoredLateTerminalState: true,
    };
  }
  const runId = resolveMissionRunId(task);
  const endedAt = Date.now();
  const taskStatus = mapMissionStateToTaskStatus(finalState);
  const terminalSummary = replyText ?? normalizeOptionalText(params.statusSummary);
  if (!runId) {
    return {
      action: "error" as const,
      missionId,
      workerId,
      error: "Mission task is missing run metadata.",
    };
  }
  if (taskStatus === "succeeded") {
    completeTaskRunByRunId({
      runId,
      endedAt,
      lastEventAt: endedAt,
      terminalSummary,
      progressSummary: normalizeOptionalText(params.statusSummary),
    });
  } else {
    failTaskRunByRunId({
      runId,
      status: taskStatus,
      endedAt,
      lastEventAt: endedAt,
      error: terminalSummary,
      progressSummary: normalizeOptionalText(params.statusSummary),
      terminalSummary,
    });
  }
  const deliveryStatus = mapDeliveryStateToTaskDeliveryStatus(
    params.deliveryState,
    taskStatus === "succeeded" ? "delivered" : "failed",
  );
  setDetachedTaskDeliveryStatusByRunId({
    runId,
    deliveryStatus,
  });
  if (params.clearBinding !== false) {
    await clearSessionMissionBindingIfMatches({
      sessionKey: params.sessionKey,
      missionId,
      workerId,
    });
  }
  const stateText =
    taskStatus === "succeeded" ? "completed" : taskStatus === "cancelled" ? "aborted" : taskStatus;
  return {
    action: "completed" as const,
    missionId,
    workerId,
    state: stateText,
    deliveryState: deliveryStatus,
    replyText: replyText ?? buildCompactCompletion(missionId, stateText, terminalSummary),
  };
}

export async function heartbeatMissionFromSession(params: {
  sessionKey: string;
  missionId: string;
  workerId: string;
  statusSummary?: string | null;
}) {
  const missionId = normalizeOptionalText(params.missionId);
  const workerId = normalizeOptionalText(params.workerId);
  if (!missionId || !workerId) {
    return {
      action: "error" as const,
      error: "Missing mission or worker id.",
    };
  }
  const task = findTaskBySourceId(missionId);
  if (!task || !isOrchestratedMissionTask(task)) {
    return {
      action: "error" as const,
      missionId,
      workerId,
      error: `Missing mission ${missionId} for heartbeat.`,
    };
  }
  const runId = resolveMissionRunId(task);
  if (!runId) {
    return {
      action: "error" as const,
      missionId,
      workerId,
      error: "Mission task is missing run metadata.",
    };
  }
  recordTaskRunProgressByRunId({
    runId,
    lastEventAt: Date.now(),
    progressSummary: normalizeOptionalText(params.statusSummary),
    eventSummary: normalizeOptionalText(params.statusSummary),
  });
  const updated = findTaskBySourceId(missionId) ?? task;
  return {
    action: "heartbeat" as const,
    missionId,
    workerId,
    state: "running",
    replyText: buildOrchestrationMissionStatus(updated).replyText,
  };
}

export async function queryMissionStatusFromSession(params: { missionId: string }) {
  const missionId = normalizeOptionalText(params.missionId);
  if (!missionId) {
    return {
      found: false,
      missionId: null,
      state: null,
      replyText: "No mission id supplied.",
    };
  }
  const task = findTaskBySourceId(missionId);
  if (!task || !isOrchestratedMissionTask(task)) {
    return {
      found: false,
      missionId,
      state: null,
      replyText: `Mission ${missionId} has no live worker bound.`,
    };
  }
  return buildOrchestrationMissionStatus(task);
}

export async function querySessionStatusFromSession(params: {
  sessionKey: string;
  missionId?: string;
}) {
  if (normalizeOptionalText(params.missionId)) {
    return await queryMissionStatusFromSession({ missionId: params.missionId! });
  }
  return await statusFromSession({ sessionKey: params.sessionKey });
}

export async function listOrchestratorMissionsFromSession(params: {
  sessionKey: string;
  activeOnly?: boolean;
  allDirectSessions?: boolean;
}) {
  return await listMissionsFromSession(params);
}
