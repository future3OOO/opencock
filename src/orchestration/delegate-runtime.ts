import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import { updateSessionStoreEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { prepareDispatchRequestFromSession } from "./control-plane.prepare.js";
import {
  resolveMissionTask,
  type AcceptedPreparedDelegatePlan,
  type SuppressedPreparedDelegatePlan,
} from "./control-plane.shared.js";
import { buildCompactReceipt, normalizeOptionalText } from "./format.js";
import { setSessionMissionBinding } from "./session-state.js";

export type AcceptedDelegatePlan = AcceptedPreparedDelegatePlan;
export type SuppressedDelegatePlan = SuppressedPreparedDelegatePlan;

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

export function isAcceptedDelegatePlan(value: unknown): value is AcceptedDelegatePlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "accepted" &&
    candidate.action === "delegate" &&
    typeof candidate.missionId === "string" &&
    typeof candidate.workerId === "string" &&
    typeof candidate.routingClass === "string" &&
    typeof candidate.surface === "string" &&
    typeof candidate.suppressionKey === "string" &&
    typeof candidate.workerTask === "string" &&
    typeof candidate.workerLabel === "string" &&
    typeof candidate.replyText === "string"
  );
}

export function isSuppressedDelegatePlan(value: unknown): value is SuppressedDelegatePlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "accepted" &&
    candidate.action === "suppressed" &&
    typeof candidate.routingClass === "string" &&
    typeof candidate.replyText === "string"
  );
}

export async function bindSuppressedMissionForSession(params: {
  sessionKey: string;
  routingClass: string;
  plan: SuppressedDelegatePlan;
}) {
  const existingMissionId = normalizeOptionalText(params.plan.missionId);
  const existingWorkerId = normalizeOptionalText(params.plan.workerId);
  if (!existingMissionId || !existingWorkerId) {
    return params.plan;
  }
  const task = resolveMissionTask(params.sessionKey, existingMissionId);
  if (task?.status === "running") {
    await setSessionMissionBinding({
      sessionKey: params.sessionKey,
      missionId: existingMissionId,
      workerId: existingWorkerId,
      continuitySummary: buildCompactReceipt(
        existingMissionId,
        existingWorkerId,
        task.orchestrationRoutingClass ?? params.routingClass,
      ),
    });
  }
  return params.plan;
}

export async function executePreparedDelegatePlan(params: {
  sessionKey: string;
  loaded: ReturnType<typeof loadSessionEntry>;
  plan: AcceptedDelegatePlan;
}) {
  const delivery =
    deliveryContextFromSession(params.loaded.entry) ??
    deriveDirectDeliveryContextFromSessionKey(params.sessionKey);
  const spawnResult = await spawnSubagentDirect(
    {
      task: params.plan.workerTask,
      label: params.plan.workerLabel,
      cleanup: "delete",
      runTimeoutSeconds: params.plan.runTimeoutSeconds,
      expectsCompletionMessage: true,
      orchestration: {
        missionId: params.plan.missionId,
        workerId: params.plan.workerId,
        routingClass: params.plan.routingClass,
        surface: params.plan.surface,
        statusSummary: params.plan.statusSummary,
        suppressionKey: params.plan.suppressionKey,
      },
    },
    {
      agentSessionKey: params.sessionKey,
      agentChannel: delivery?.channel,
      agentAccountId: delivery?.accountId,
      agentTo: delivery?.to,
      agentThreadId: delivery?.threadId,
      requesterAgentIdOverride: parseAgentSessionKey(params.sessionKey)?.agentId,
    },
  );
  if (spawnResult.status !== "accepted" || !spawnResult.runId || !spawnResult.childSessionKey) {
    return {
      status: "error" as const,
      category: "delegate_rejected" as const,
      error: spawnResult.error ?? "Failed to spawn worker.",
      missionId: params.plan.missionId,
      workerId: params.plan.workerId,
    };
  }
  await setSessionMissionBinding({
    sessionKey: params.sessionKey,
    missionId: params.plan.missionId,
    workerId: params.plan.workerId,
    continuitySummary: buildCompactReceipt(
      params.plan.missionId,
      params.plan.workerId,
      params.plan.routingClass,
    ),
  });
  await updateSessionStoreEntry({
    storePath: params.loaded.storePath,
    sessionKey: params.sessionKey,
    update: async (existing) => ({
      workerNoticeCount: Math.max(0, Number(existing?.workerNoticeCount ?? 0)) + 1,
      updatedAt: Date.now(),
    }),
  }).catch(() => null);
  return {
    status: "accepted" as const,
    action: "delegate" as const,
    missionId: params.plan.missionId,
    workerId: params.plan.workerId,
    routingClass: params.plan.routingClass,
    childSessionKey: spawnResult.childSessionKey,
    runId: spawnResult.runId,
    replyText: params.plan.replyText,
  };
}

export async function dispatchRequestFromSession(params: {
  text: string;
  sessionKey: string;
  surface?: string;
  hasBrowserNeed?: boolean;
  hasRepoMutation?: boolean;
  hasTimedCommitment?: boolean;
  toolNeeds?: string[];
  isMultiStep?: boolean;
}) {
  const prepared = await prepareDispatchRequestFromSession({
    text: params.text,
    sessionKey: params.sessionKey,
    surface: params.surface,
    hasBrowserNeed: params.hasBrowserNeed,
    hasRepoMutation: params.hasRepoMutation,
    hasTimedCommitment: params.hasTimedCommitment,
    toolNeeds: params.toolNeeds,
    isMultiStep: params.isMultiStep,
    allowAutoDelegate: true,
  });
  if (!isAcceptedDelegatePlan(prepared)) {
    return prepared;
  }
  const loaded = loadSessionEntry(params.sessionKey);
  return await executePreparedDelegatePlan({
    sessionKey: loaded.canonicalKey,
    loaded,
    plan: prepared,
  });
}
