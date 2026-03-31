import { loadConfig } from "../config/config.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { cancelTaskById } from "../tasks/task-registry.js";
import {
  buildPreparedDelegatePlan,
  listInspectableOrchestratedTasks,
  resolveMissionTask,
  resolveSpawnSurface,
} from "./control-plane.shared.js";
import {
  bindSuppressedMissionForSession,
  executePreparedDelegatePlan,
  isAcceptedDelegatePlan,
  isSuppressedDelegatePlan,
} from "./delegate-runtime.js";
import {
  compactText,
  DELEGATABLE_ROUTING_CLASSES,
  isDelegatableRoutingClass,
  normalizeOptionalText,
} from "./format.js";
import { isOrchestrationChannelEnabled, loadOrchestrationRuntimeConfig } from "./runtime-config.js";
import {
  buildOrchestrationMissionStatus,
  isDirectOrchestratorSessionKey,
} from "./runtime-primitives.js";
import { reconcileSessionMissionBinding } from "./session-binding-reconcile.js";
import { buildSessionMissionOverview } from "./session-overview.js";
import { setSessionMissionBinding } from "./session-state.js";

export { DELEGATABLE_ROUTING_CLASSES } from "./format.js";
export { dispatchRequestFromSession } from "./delegate-runtime.js";

type DelegateParams = {
  sessionKey: string;
  routingClass: string;
  task: string;
  statusSummary: string;
  surface?: string;
  toolNeeds?: string[];
  timeoutSeconds?: number;
};

type DelegateManyItem = Omit<DelegateParams, "sessionKey">;

function resolveEffectiveSpawnSurface(taskSurface: string | undefined, sessionKey: string): string {
  const normalized = normalizeOptionalText(taskSurface);
  if (normalized) {
    return normalized;
  }
  return resolveSpawnSurface(undefined, sessionKey);
}

function delegateRejected(message: string) {
  return {
    status: "error" as const,
    category: "delegate_rejected" as const,
    error: message,
  };
}

export async function delegateFromSession(params: DelegateParams) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  const routingClass = normalizeOptionalText(params.routingClass);
  const task = normalizeOptionalText(params.task);
  const statusSummary = normalizeOptionalText(params.statusSummary);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  if (!routingClass) {
    return delegateRejected("Missing --routing-class.");
  }
  if (!task) {
    return delegateRejected("Missing --task or --task-file.");
  }
  if (!statusSummary) {
    return delegateRejected("Missing --status-summary.");
  }
  if (!isDelegatableRoutingClass(routingClass)) {
    return delegateRejected(`Invalid routingClass "${routingClass}".`);
  }

  const loaded = loadSessionEntry(sessionKey);
  const canonicalSessionKey = loaded.canonicalKey;
  const orchestrationConfig = loadOrchestrationRuntimeConfig();
  const surface = resolveEffectiveSpawnSurface(params.surface, canonicalSessionKey);
  if (!isOrchestrationChannelEnabled(canonicalSessionKey, orchestrationConfig)) {
    return delegateRejected("Orchestration is disabled for this session.");
  }
  const prepared = buildPreparedDelegatePlan({
    sessionKey: canonicalSessionKey,
    routingClass,
    task,
    statusSummary,
    surface,
    toolNeeds: params.toolNeeds,
    timeoutSeconds: params.timeoutSeconds,
    config: orchestrationConfig,
  });
  if (isSuppressedDelegatePlan(prepared)) {
    return await bindSuppressedMissionForSession({
      sessionKey: canonicalSessionKey,
      routingClass,
      plan: prepared,
    });
  }
  if (!isAcceptedDelegatePlan(prepared)) {
    return delegateRejected("Failed to build delegate plan.");
  }
  return await executePreparedDelegatePlan({
    sessionKey: canonicalSessionKey,
    loaded,
    plan: prepared,
  });
}

export async function delegateManyFromSession(params: {
  sessionKey: string;
  items: DelegateManyItem[];
}) {
  const rawItems = Array.isArray(params.items) ? params.items : [];
  if (rawItems.length === 0) {
    return delegateRejected("Missing delegate-many items.");
  }
  const results = await Promise.all(
    rawItems.map(
      async (item) =>
        await delegateFromSession({
          sessionKey: params.sessionKey,
          routingClass: item.routingClass,
          task: item.task,
          statusSummary: item.statusSummary,
          surface: item.surface,
          toolNeeds: item.toolNeeds,
          timeoutSeconds: item.timeoutSeconds,
        }),
    ),
  );
  const acceptedCount = results.filter((result) => result.status === "accepted").length;
  return {
    status: acceptedCount === results.length ? "accepted" : acceptedCount > 0 ? "partial" : "error",
    action: "delegate-many" as const,
    count: results.length,
    acceptedCount,
    results,
    replyText:
      acceptedCount > 0
        ? `Delegated ${acceptedCount}/${results.length} missions.`
        : "delegate-many failed.",
  };
}

export async function statusFromSession(params: { sessionKey: string; missionId?: string }) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  const explicitMissionId = normalizeOptionalText(params.missionId);
  if (explicitMissionId) {
    const target = resolveMissionTask(sessionKey, explicitMissionId);
    if (target) {
      return buildOrchestrationMissionStatus(target);
    }
  }
  const reconciledBinding = await reconcileSessionMissionBinding({ sessionKey });
  const loaded = loadSessionEntry(reconciledBinding.sessionKey);
  const sessionTasks = listInspectableOrchestratedTasks().filter(
    (task) => task.requesterSessionKey === loaded.canonicalKey,
  );
  const missionStatuses = sessionTasks.map((task) => buildOrchestrationMissionStatus(task));
  const active = sessionTasks.filter((task) => task.status === "running");
  if (active.length === 1) {
    return buildOrchestrationMissionStatus(active[0]);
  }
  if (active.length > 1) {
    return {
      found: true,
      missionId: null,
      state: "running",
      missions: active.map((task) => buildOrchestrationMissionStatus(task)),
      replyText:
        buildSessionMissionOverview(missionStatuses) ??
        `Multiple missions are running (${active.length}).`,
    };
  }
  if (sessionTasks.length > 0) {
    return {
      found: false,
      missionId: null,
      state: null,
      missions: missionStatuses.slice(0, 3),
      replyText: buildSessionMissionOverview(missionStatuses) ?? "No active worker is bound.",
    };
  }
  return {
    found: false,
    missionId: null,
    state: null,
    workerId: reconciledBinding.binding.focusedWorkerId,
    replyText: "No active worker is bound.",
  };
}

export async function listMissionsFromSession(params: {
  sessionKey: string;
  activeOnly?: boolean;
  allDirectSessions?: boolean;
}) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  if (!params.allDirectSessions) {
    await reconcileSessionMissionBinding({ sessionKey });
  }
  const loaded = loadSessionEntry(sessionKey);
  const missions = listInspectableOrchestratedTasks()
    .filter((task) =>
      params.allDirectSessions
        ? isDirectOrchestratorSessionKey(task.requesterSessionKey)
        : task.requesterSessionKey === loaded.canonicalKey,
    )
    .filter((task) => (params.activeOnly ? task.status === "running" : true))
    .map((task) => buildOrchestrationMissionStatus(task));
  return {
    action: "list" as const,
    sessionKey: loaded.canonicalKey,
    scope: params.allDirectSessions ? "all-direct-sessions" : "current-session",
    count: missions.length,
    missions,
  };
}

export async function cancelMissionFromSession(params: {
  sessionKey: string;
  missionId?: string;
  statusSummary?: string;
}) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  const task = resolveMissionTask(sessionKey, params.missionId);
  if (!task) {
    return {
      action: "error" as const,
      error: "No active mission is bound.",
    };
  }
  const cfg = loadConfig();
  const result = await cancelTaskById({
    cfg,
    taskId: task.taskId,
  });
  if (!result.found || !result.cancelled || !result.task) {
    return {
      action: "error" as const,
      missionId: task.sourceId,
      error: result.reason ?? "Unable to cancel mission.",
    };
  }
  await setSessionMissionBinding({
    sessionKey,
    missionId: null,
    workerId: null,
  });
  return {
    action: "cancelled" as const,
    missionId: result.task.sourceId,
    workerId: result.task.orchestrationWorkerId,
    state: "cancelled",
    workerSessionKey: result.task.childSessionKey,
    processSessionId: result.task.runId,
    replyText:
      compactText(params.statusSummary, 240) ??
      `Mission ${result.task.sourceId ?? result.task.taskId} cancelled.`,
  };
}
