import { getMissionWakeRuntime } from "../../../gateway/mission-wake-runtime.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";
import { isGatewayStartupEvent } from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/mission-wake");

function resolveRequesterSessionKey(event: Parameters<HookHandler>[0]): string | null {
  if (isGatewayStartupEvent(event)) {
    return "gateway:startup";
  }
  if (event.type !== "agent" || event.action !== "mission:completed") {
    return null;
  }
  const requesterSessionKey = event.context?.requesterSessionKey;
  if (typeof requesterSessionKey === "string" && requesterSessionKey.trim()) {
    return requesterSessionKey.trim();
  }
  const sessionKey = event.sessionKey?.trim();
  return sessionKey || null;
}

const runMissionWake: HookHandler = async (event) => {
  const target = resolveRequesterSessionKey(event);
  if (!target) {
    return;
  }
  const runtime = getMissionWakeRuntime();
  if (!runtime) {
    log.warn("mission-wake runtime unavailable; leaving pending notifications intact", {
      target,
      event: `${event.type}:${event.action}`,
    });
    return;
  }
  if (target === "gateway:startup") {
    await runtime.recoverPending();
    return;
  }
  await runtime.dispatchForSession(target);
};

export default runMissionWake;
