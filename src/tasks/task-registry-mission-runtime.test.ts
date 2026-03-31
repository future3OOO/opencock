import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  clearPendingMissionNotifications,
  createTaskRegistryMissionHooks,
  incrementPendingMissionAttempts,
  pruneExpiredPendingMissionNotifications,
} from "./task-registry-mission-runtime.js";
import { createTaskRecord, resetTaskRegistryForTests } from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 10) {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

async function withTaskTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-task-mission-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskRegistryForTests();
    clearInternalHooks();
    try {
      return await run(root);
    } finally {
      clearInternalHooks();
      resetTaskRegistryForTests();
    }
  });
}

describe("task-registry mission runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    clearInternalHooks();
    resetTaskRegistryForTests({ persist: false });
  });

  it("projects visible terminal completions into session state and emits agent:mission:completed", async () => {
    await withTaskTempDir(async () => {
      configureTaskRegistryRuntime({
        hooks: createTaskRegistryMissionHooks(),
      });

      const events: Array<{ sessionKey: string; context: Record<string, unknown> }> = [];
      registerInternalHook("agent:mission:completed", (event) => {
        events.push({
          sessionKey: event.sessionKey,
          context: event.context,
        });
      });

      createTaskRecord({
        runtime: "acp",
        sourceId: "mission-source-1",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-mission-1",
        label: "Mission Wake Validation",
        task: "Validate source-owned mission wake",
        status: "succeeded",
        deliveryStatus: "session_queued",
        terminalSummary: "Patched the OpenCock source seam and queued the wake.",
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        const entry = store["agent:main:main"];
        expect(entry?.lastDeliveredMission).toMatchObject({
          missionId: "mission-source-1",
          workerId: "agent:main:acp:child",
          state: "completed",
          summary: "Patched the OpenCock source seam and queued the wake.",
        });
        expect(entry?.recentMissionEvents).toEqual([
          expect.objectContaining({
            missionId: "mission-source-1",
            state: "completed",
          }),
        ]);
        expect(entry?.pendingMissionNotifications).toMatchObject({
          "mission-source-1": expect.objectContaining({
            missionId: "mission-source-1",
            finalState: "completed",
            attempts: 0,
          }),
        });
        expect(entry?.continuityCapsule).toMatchObject({
          summary:
            "Mission mission-source-1 completed: Patched the OpenCock source seam and queued the wake.",
          recentMissionIds: ["mission-source-1"],
        });
      });

      await waitForAssertion(() => {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          sessionKey: "agent:main:main",
          context: expect.objectContaining({
            missionId: "mission-source-1",
            requesterSessionKey: "agent:main:main",
            deliveryState: "session_queued",
          }),
        });
      });
    });
  });

  it("clears the active mission binding when the delivered terminal event matches it", async () => {
    await withTaskTempDir(async () => {
      configureTaskRegistryRuntime({
        hooks: createTaskRegistryMissionHooks(),
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await updateSessionStoreEntry({
        storePath,
        sessionKey: "agent:main:main",
        update: async () => ({
          activeMissionId: "mission-source-4",
          focusedWorkerId: "worker-source-4",
          updatedAt: Date.now(),
        }),
      });

      createTaskRecord({
        runtime: "acp",
        sourceId: "mission-source-4",
        orchestrationWorkerId: "worker-source-4",
        orchestrationRoutingClass: "coding",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child-4",
        runId: "run-mission-4",
        task: "Clear active mission binding",
        status: "succeeded",
        deliveryStatus: "session_queued",
        terminalSummary: "Mission completed cleanly.",
      });

      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        const entry = store["agent:main:main"];
        expect(entry?.activeMissionId ?? null).toBeNull();
        expect(entry?.focusedWorkerId ?? null).toBeNull();
        expect(entry?.continuityCapsule).toMatchObject({
          recentMissionIds: ["mission-source-4"],
        });
      });
    });
  });

  it("increments, clears, and prunes pending mission notifications", async () => {
    await withTaskTempDir(async () => {
      configureTaskRegistryRuntime({
        hooks: createTaskRegistryMissionHooks(),
      });

      createTaskRecord({
        runtime: "acp",
        sourceId: "mission-source-2",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-mission-2",
        task: "Exercise mission wake state",
        status: "succeeded",
        deliveryStatus: "session_queued",
        terminalSummary: "Initial completion state.",
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(
          store["agent:main:main"]?.pendingMissionNotifications?.["mission-source-2"],
        ).toBeTruthy();
      });

      await incrementPendingMissionAttempts("agent:main:main", ["mission-source-2"]);
      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(
          store["agent:main:main"]?.pendingMissionNotifications?.["mission-source-2"]?.attempts,
        ).toBe(1);
      });

      await clearPendingMissionNotifications("agent:main:main", ["mission-source-2"]);
      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store["agent:main:main"]?.pendingMissionNotifications).toBeNull();
      });

      createTaskRecord({
        runtime: "acp",
        sourceId: "mission-source-3",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:main:acp:child",
        runId: "run-mission-3",
        task: "Prune expired mission wake",
        status: "succeeded",
        deliveryStatus: "session_queued",
        terminalSummary: "This wake should expire.",
      });

      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(
          store["agent:main:main"]?.pendingMissionNotifications?.["mission-source-3"],
        ).toBeTruthy();
      });

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      await pruneExpiredPendingMissionNotifications("agent:main:main");
      nowSpy.mockRestore();

      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store["agent:main:main"]?.pendingMissionNotifications).toBeNull();
      });
    });
  });
});
