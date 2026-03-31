import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStoreEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { cancelTaskById } from "../tasks/task-registry.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import {
  listInspectableOrchestratedTasks,
  listInspectableTasksForSuppressionKey,
  resolveMissionTask,
  resolveSpawnSurface,
} from "./control-plane.shared.js";
import {
  buildCompactReceipt,
  buildWorkerTask,
  compactText,
  DELEGATABLE_ROUTING_CLASSES,
  isDelegatableRoutingClass,
  normalizeOptionalText,
} from "./format.js";
import {
  buildOrchestrationMissionLabel,
  buildOrchestrationMissionStatus,
  buildOrchestrationSuppressionKey,
  DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS,
  findSuppressedOrchestrationTask,
  isDirectOrchestratorSessionKey,
} from "./runtime-primitives.js";
import { readSessionMissionBinding, setSessionMissionBinding } from "./session-state.js";

export { DELEGATABLE_ROUTING_CLASSES } from "./format.js";

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

function deriveDirectDeliveryContextFromSessionKey(sessionKey: string) {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest?.trim().toLowerCase() ?? "";
  if (!rest) {
    return null;
  }
  const directMatch = rest.match(/^(whatsapp|telegram)(?::([^:]+))?:direct:(.+)$/);
  if (!directMatch) {
    return null;
  }
  const channel = directMatch[1];
  const accountId = directMatch[2]?.trim() || "default";
  const to = directMatch[3]?.trim();
  if (!to) {
    return null;
  }
  return {
    channel,
    accountId,
    to,
    threadId: undefined,
  };
}

function resolveEffectiveSpawnSurface(taskSurface: string | undefined, sessionKey: string): string {
  const normalized = normalizeOptionalText(taskSurface);
  if (normalized) {
    return normalized;
  }
  return resolveSpawnSurface(
    deriveDirectDeliveryContextFromSessionKey(sessionKey)?.channel,
    sessionKey,
  );
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
  const delivery =
    deliveryContextFromSession(loaded.entry) ??
    deriveDirectDeliveryContextFromSessionKey(canonicalSessionKey);
  const surface = resolveEffectiveSpawnSurface(params.surface, canonicalSessionKey);
  const missionLabel = buildOrchestrationMissionLabel({
    routingClass,
    sourceText: statusSummary,
  });
  const suppressionKey = buildOrchestrationSuppressionKey({
    sessionMode: "orchestrator",
    userOrChannel: canonicalSessionKey,
    missionLabel,
    surface,
    toolNeeds: params.toolNeeds,
  });
  const suppression = findSuppressedOrchestrationTask({
    suppressionKey,
    tasks: listInspectableTasksForSuppressionKey({
      sessionKey: canonicalSessionKey,
      suppressionKey,
    }),
    cooldownSeconds: DEFAULT_ORCHESTRATION_SPAWN_COOLDOWN_SECONDS,
  });
  if (suppression.suppress && suppression.task) {
    const existing = buildOrchestrationMissionStatus(suppression.task);
    if (suppression.task.status === "running") {
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
    }
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
  const missionId = makeId("m", missionLabel);
  const workerId = makeId("w", routingClass, 30);
  const workerTask = buildWorkerTask({
    task,
    missionId,
    routingClass,
    sessionKey: canonicalSessionKey,
    surface,
    toolNeeds: params.toolNeeds,
  });
  const spawnResult = await spawnSubagentDirect(
    {
      task: workerTask,
      label: routingClass,
      cleanup: "delete",
      runTimeoutSeconds: params.timeoutSeconds,
      expectsCompletionMessage: true,
      orchestration: {
        missionId,
        workerId,
        routingClass,
        surface,
        statusSummary,
        suppressionKey,
      },
    },
    {
      agentSessionKey: canonicalSessionKey,
      agentChannel: delivery?.channel,
      agentAccountId: delivery?.accountId,
      agentTo: delivery?.to,
      agentThreadId: delivery?.threadId,
      requesterAgentIdOverride: parseAgentSessionKey(canonicalSessionKey)?.agentId,
    },
  );
  if (spawnResult.status !== "accepted" || !spawnResult.runId || !spawnResult.childSessionKey) {
    return {
      status: "error" as const,
      category: "delegate_rejected" as const,
      error: spawnResult.error ?? "Failed to spawn worker.",
      missionId,
      workerId,
    };
  }
  await setSessionMissionBinding({
    sessionKey: canonicalSessionKey,
    missionId,
    workerId,
    continuitySummary: buildCompactReceipt(missionId, workerId, routingClass),
  });
  await updateSessionStoreEntry({
    storePath: loaded.storePath,
    sessionKey: canonicalSessionKey,
    update: async (existing) => ({
      workerNoticeCount: Math.max(0, Number(existing?.workerNoticeCount ?? 0)) + 1,
      updatedAt: Date.now(),
    }),
  }).catch(() => null);
  return {
    status: "accepted" as const,
    action: "delegate" as const,
    missionId,
    workerId,
    routingClass,
    childSessionKey: spawnResult.childSessionKey,
    runId: spawnResult.runId,
    replyText: buildCompactReceipt(missionId, workerId, routingClass),
  };
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
  const target = resolveMissionTask(sessionKey, params.missionId);
  if (target) {
    return buildOrchestrationMissionStatus(target);
  }
  const loaded = loadSessionEntry(sessionKey);
  const sessionTasks = listInspectableOrchestratedTasks().filter(
    (task) => task.requesterSessionKey === loaded.canonicalKey,
  );
  const active = sessionTasks.filter((task) => task.status === "running");
  if (active.length > 1) {
    return {
      found: true,
      missionId: null,
      state: "running",
      missions: active.map((task) => buildOrchestrationMissionStatus(task)),
      replyText: `Multiple missions are running (${active.length}).`,
    };
  }
  if (sessionTasks.length > 0) {
    return {
      found: false,
      missionId: null,
      state: null,
      missions: sessionTasks.slice(0, 3).map((task) => buildOrchestrationMissionStatus(task)),
      replyText: "No active worker is bound.",
    };
  }
  return {
    found: false,
    missionId: null,
    state: null,
    workerId: readSessionMissionBinding(loaded.entry).focusedWorkerId,
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
