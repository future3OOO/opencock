import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMissionWakeRuntime,
  getMissionWakeRuntime,
  setMissionWakeRuntime,
  type MissionWakeRuntime,
} from "../../../gateway/mission-wake-runtime.js";
import { createInternalHookEvent } from "../../internal-hooks.js";
import runMissionWake from "./handler.js";

const runtimeStub = (): MissionWakeRuntime => ({
  dispatchForSession: vi.fn(async () => true),
  recoverPending: vi.fn(async () => {}),
});

describe("bundled mission-wake hook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (getMissionWakeRuntime()) {
      clearMissionWakeRuntime();
    }
  });

  it("dispatches requester session mission wakes for mission completion events", async () => {
    const runtime = runtimeStub();
    setMissionWakeRuntime(runtime);
    const event = createInternalHookEvent("agent", "mission:completed", "agent:main:main", {
      requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
    });

    await runMissionWake(event);

    expect(runtime.dispatchForSession).toHaveBeenCalledWith(
      "agent:main:whatsapp:direct:+64270000000",
    );
    expect(runtime.recoverPending).not.toHaveBeenCalled();
  });

  it("replays pending mission wakes on gateway startup", async () => {
    const runtime = runtimeStub();
    setMissionWakeRuntime(runtime);
    const event = createInternalHookEvent("gateway", "startup", "gateway:startup", {});

    await runMissionWake(event);

    expect(runtime.recoverPending).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchForSession).not.toHaveBeenCalled();
  });

  it("leaves pending state intact when runtime is unavailable", async () => {
    const event = createInternalHookEvent("agent", "mission:completed", "agent:main:main", {
      requesterSessionKey: "agent:main:main",
    });

    await runMissionWake(event);
  });

  it("ignores unrelated hook events", async () => {
    const runtime = runtimeStub();
    setMissionWakeRuntime(runtime);
    const event = createInternalHookEvent("message", "received", "agent:main:main", {
      from: "user",
      channelId: "web",
    });

    await runMissionWake(event);

    expect(runtime.recoverPending).not.toHaveBeenCalled();
    expect(runtime.dispatchForSession).not.toHaveBeenCalled();
  });
});
