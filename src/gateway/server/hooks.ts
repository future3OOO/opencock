import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildMissionWakeMessage,
  clearPendingMissionNotifications,
  incrementPendingMissionAttempts,
  isTransientMissionWakeFailure,
  MISSION_WAKE_MAX_ATTEMPTS,
  pruneExpiredPendingMissionNotifications,
  readPendingMissionNotificationRecords,
} from "../../tasks/task-registry-mission-runtime.js";
import {
  normalizeHookDispatchSessionKey,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
} from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "../server-http.js";
import { loadCombinedSessionStoreForGateway, loadSessionEntry } from "../session-utils.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const MISSION_WAKE_RUNTIME_KEY = "__openclaw_mission_wake_runtime__";
const MISSION_WAKE_IN_FLIGHT_KEY = "__openclaw_mission_wake_in_flight__";

type MissionWakeRuntime = {
  dispatchForSession: (sessionKey: string) => Promise<boolean>;
  recoverPending: () => Promise<void>;
};

export function resolveHookClientIpConfig(cfg: OpenClawConfig): HookClientIpConfig {
  return {
    trustedProxies: cfg.gateway?.trustedProxies,
    allowRealIpFallback: cfg.gateway?.allowRealIpFallback === true,
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;
  const missionWakeGlobals = globalThis as typeof globalThis & Record<string, unknown>;
  const missionWakeInFlight =
    missionWakeGlobals[MISSION_WAKE_IN_FLIGHT_KEY] instanceof Set
      ? (missionWakeGlobals[MISSION_WAKE_IN_FLIGHT_KEY] as Set<string>)
      : (missionWakeGlobals[MISSION_WAKE_IN_FLIGHT_KEY] = new Set<string>());

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: value.agentId,
    });
    const isMissionWake = value.purpose === "mission-wake";
    const missionIds = Array.isArray(value.missionIds)
      ? value.missionIds
          .filter((missionId): missionId is string => typeof missionId === "string")
          .map((missionId) => missionId.trim())
          .filter(Boolean)
      : [];
    if (isMissionWake && missionWakeInFlight.has(sessionKey)) {
      return `mission-wake:${sessionKey}`;
    }
    if (isMissionWake) {
      missionWakeInFlight.add(sessionKey);
    }
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      sessionKey,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    void (async () => {
      try {
        const cfg = loadConfig();
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
          deliveryContract: "shared",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        const missionWakeDelivered = !isMissionWake || !value.deliver || result.delivered === true;
        if (
          isMissionWake &&
          result.status === "ok" &&
          missionWakeDelivered &&
          missionIds.length > 0
        ) {
          await clearPendingMissionNotifications(sessionKey, missionIds);
        }
        if (!result.delivered && value.suppressUndeliveredEnqueue !== true) {
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
        if (isMissionWake && result.status === "ok" && missionWakeDelivered) {
          queueMicrotask(() => {
            void (
              missionWakeGlobals[MISSION_WAKE_RUNTIME_KEY] as MissionWakeRuntime | undefined
            )?.dispatchForSession?.(sessionKey);
          });
        } else if (
          isMissionWake &&
          missionIds.length > 0 &&
          (isTransientMissionWakeFailure(result) ||
            (value.deliver && result.status === "ok" && result.delivered !== true))
        ) {
          setTimeout(() => {
            void (
              missionWakeGlobals[MISSION_WAKE_RUNTIME_KEY] as MissionWakeRuntime | undefined
            )?.dispatchForSession?.(sessionKey);
          }, 1000);
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        if (value.suppressUndeliveredEnqueue !== true) {
          enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}:error` });
          }
        }
        if (isMissionWake && missionIds.length > 0 && isTransientMissionWakeFailure(String(err))) {
          setTimeout(() => {
            void (
              missionWakeGlobals[MISSION_WAKE_RUNTIME_KEY] as MissionWakeRuntime | undefined
            )?.dispatchForSession?.(sessionKey);
          }, 1000);
        }
      } finally {
        if (isMissionWake) {
          missionWakeInFlight.delete(sessionKey);
        }
      }
    })();

    return runId;
  };

  const dispatchMissionWakeForSession = async (sessionKey: string) => {
    if (!sessionKey?.trim()) {
      return false;
    }
    await pruneExpiredPendingMissionNotifications(sessionKey);
    const live = loadSessionEntry(sessionKey);
    const pending = readPendingMissionNotificationRecords(live?.entry).filter(
      (record) => record.attempts < MISSION_WAKE_MAX_ATTEMPTS,
    );
    if (pending.length === 0 || missionWakeInFlight.has(sessionKey)) {
      return false;
    }
    const missionIds = pending.map((record) => record.missionId);
    await incrementPendingMissionAttempts(sessionKey, missionIds);
    dispatchAgentHook({
      sessionKey,
      name: "Mission Wake",
      message: buildMissionWakeMessage(pending),
      deliver: true,
      channel: "last",
      wakeMode: "now",
      purpose: "mission-wake",
      missionIds,
      suppressUndeliveredEnqueue: true,
    });
    return true;
  };

  const recoverPendingMissionWakes = async () => {
    const { store } = loadCombinedSessionStoreForGateway(loadConfig());
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (readPendingMissionNotificationRecords(entry).length === 0) {
        continue;
      }
      await dispatchMissionWakeForSession(sessionKey);
    }
  };

  missionWakeGlobals[MISSION_WAKE_RUNTIME_KEY] = {
    dispatchForSession: dispatchMissionWakeForSession,
    recoverPending: recoverPendingMissionWakes,
  } satisfies MissionWakeRuntime;

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
