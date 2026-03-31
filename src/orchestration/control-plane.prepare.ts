import { loadConfig } from "../config/config.js";
import { evaluateSessionFreshness, resolveSessionResetPolicy } from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import {
  buildPreparedDelegatePlan,
  delegateRejected,
  resolveMissionTask,
  resolveSpawnSurface,
} from "./control-plane.shared.js";
import { compactText, isDelegatableRoutingClass, normalizeOptionalText } from "./format.js";
import {
  classifyOrchestrationRequest,
  isInlineEligible,
  shouldDelegateRoutingClass,
} from "./policy.js";
import {
  buildOrchestrationMissionStatus,
  isDirectOrchestratorSessionKey,
  isGroupOrchestratorSession,
  resolveContinuationIntent,
} from "./runtime-primitives.js";
import { readSessionMissionBinding } from "./session-state.js";

export async function prepareDispatchRequestFromSession(params: {
  text: string;
  sessionKey: string;
  surface?: string;
  hasBrowserNeed?: boolean;
  hasRepoMutation?: boolean;
  hasTimedCommitment?: boolean;
  toolNeeds?: string[];
  isMultiStep?: boolean;
  allowAutoDelegate?: boolean;
}) {
  const sessionKey = normalizeOptionalText(params.sessionKey);
  const text = normalizeOptionalText(params.text);
  if (!sessionKey) {
    return {
      status: "error" as const,
      category: "invalid_session" as const,
      error: "Missing session key. Set OPENCLAW_SESSION_KEY.",
    };
  }
  if (!text) {
    return delegateRejected("Missing dispatch text.");
  }
  const loaded = loadSessionEntry(sessionKey);
  const canonicalSessionKey = loaded.canonicalKey;
  const cfg = loadConfig();
  const freshness = evaluateSessionFreshness({
    updatedAt: loaded.entry?.updatedAt ?? 0,
    now: Date.now(),
    policy: resolveSessionResetPolicy({
      sessionCfg: cfg.session,
      resetType: "direct",
    }),
  });
  const routingClass = classifyOrchestrationRequest({
    text,
    hasBrowserNeed: params.hasBrowserNeed,
    hasRepoMutation: params.hasRepoMutation,
    hasTimedCommitment: params.hasTimedCommitment,
    toolNeeds: params.toolNeeds,
  });
  if (
    isGroupOrchestratorSession(canonicalSessionKey) ||
    !isDirectOrchestratorSessionKey(canonicalSessionKey)
  ) {
    return {
      action: "inline" as const,
      routingClass,
      freshness,
    };
  }
  const binding = readSessionMissionBinding(loaded.entry);
  const continuation = resolveContinuationIntent({
    text,
    activeMissionId: binding.activeMissionId,
    focusedWorkerId: binding.focusedWorkerId,
  });
  if (continuation.isContinuation) {
    const task = resolveMissionTask(canonicalSessionKey, continuation.missionId);
    return {
      action: "continue" as const,
      routingClass,
      missionId: continuation.missionId ?? null,
      workerId: continuation.workerId ?? null,
      replyText:
        task != null
          ? buildOrchestrationMissionStatus(task).replyText
          : `Mission ${continuation.missionId} has no live worker bound.`,
      freshness,
    };
  }
  if (routingClass === "direct-answer" || !params.allowAutoDelegate) {
    return {
      action: "inline" as const,
      routingClass,
      freshness,
    };
  }
  if (
    isInlineEligible({
      text,
      hasBrowserNeed: params.hasBrowserNeed,
      hasRepoMutation: params.hasRepoMutation,
      hasTimedCommitment: params.hasTimedCommitment,
      isMultiStep: params.isMultiStep,
    }) &&
    !shouldDelegateRoutingClass(routingClass)
  ) {
    return {
      action: "inline" as const,
      routingClass,
      freshness,
    };
  }
  return {
    ...buildPreparedDelegatePlan({
      sessionKey: canonicalSessionKey,
      routingClass,
      task: text,
      statusSummary: compactText(text, 120) ?? text,
      surface: resolveSpawnSurface(params.surface, canonicalSessionKey),
      toolNeeds: params.toolNeeds,
    }),
    freshness,
  };
}

export async function delegateExplicitRequestFromSession(params: {
  sessionKey: string;
  routingClass: string;
  task: string;
  statusSummary: string;
  surface?: string;
  toolNeeds?: string[];
  timeoutSeconds?: number;
}) {
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
    return delegateRejected("Missing routing class.");
  }
  if (!task) {
    return delegateRejected("Missing task.");
  }
  if (!statusSummary) {
    return delegateRejected("Missing status summary.");
  }
  if (!isDelegatableRoutingClass(routingClass)) {
    return delegateRejected(`Invalid routingClass "${routingClass}".`);
  }
  const loaded = loadSessionEntry(sessionKey);
  const canonicalSessionKey = loaded.canonicalKey;
  if (isGroupOrchestratorSession(canonicalSessionKey)) {
    return delegateRejected("Group sessions stay inline.");
  }
  return buildPreparedDelegatePlan({
    sessionKey: canonicalSessionKey,
    routingClass,
    task,
    statusSummary,
    surface: resolveSpawnSurface(params.surface, canonicalSessionKey),
    toolNeeds: params.toolNeeds,
    timeoutSeconds: params.timeoutSeconds,
  });
}
