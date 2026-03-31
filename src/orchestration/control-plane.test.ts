import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import {
  createTaskRegistryMissionHooks,
  readPendingMissionNotificationRecords,
} from "../tasks/task-registry-mission-runtime.js";
import { findTaskBySourceId, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR;

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

async function withControlPlaneTempDir<T>(run: () => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-orchestration-control-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_WORKSPACE_DIR = path.join(root, "workspace");
    await fs.mkdir(
      path.join(process.env.OPENCLAW_WORKSPACE_DIR, "skills", "clawbot-autoresearch"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        process.env.OPENCLAW_WORKSPACE_DIR,
        "skills",
        "clawbot-autoresearch",
        "runtime.json",
      ),
      JSON.stringify(
        {
          orchestration: {
            enabled: true,
            enabledChannels: ["cli", "telegram", "whatsapp"],
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: process.env.OPENCLAW_WORKSPACE_DIR,
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetTaskRegistryForTests();
    clearInternalHooks();
    configureTaskRegistryRuntime({
      hooks: createTaskRegistryMissionHooks(),
    });
    try {
      return await run();
    } finally {
      clearInternalHooks();
      resetTaskRegistryForTests();
    }
  });
}

describe("orchestration control plane", () => {
  afterEach(() => {
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    if (ORIGINAL_WORKSPACE_DIR === undefined) {
      delete process.env.OPENCLAW_WORKSPACE_DIR;
    } else {
      process.env.OPENCLAW_WORKSPACE_DIR = ORIGINAL_WORKSPACE_DIR;
    }
    clearInternalHooks();
    resetTaskRegistryForTests({ persist: false });
  });

  it("prepares direct-session requests into delegate plans and respects the auto-delegate gate", async () => {
    await withControlPlaneTempDir(async () => {
      const { prepareDispatchRequestFromSession } = await import("./control-plane.js");

      const inline = await prepareDispatchRequestFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        text: "Implement the source-owned orchestration migration",
        hasRepoMutation: true,
      });
      expect(inline).toMatchObject({
        action: "inline",
        routingClass: "coding",
      });

      const delegated = await prepareDispatchRequestFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        text: "Implement the source-owned orchestration migration",
        hasRepoMutation: true,
        allowAutoDelegate: true,
        toolNeeds: ["rg", "apply_patch"],
      });
      expect(delegated).toMatchObject({
        status: "accepted",
        action: "delegate",
        routingClass: "coding",
        suppressionKey: expect.any(String),
      });
      if (!("workerTask" in delegated)) {
        throw new Error("prepareDispatchRequestFromSession did not return a delegate plan");
      }
      expect(delegated.workerTask).toContain("Mission");
    });
  });

  it("commits external delegated workers into the native task registry and binds the session", async () => {
    await withControlPlaneTempDir(async () => {
      const { commitDelegatedWorkerFromSession } = await import("./control-plane.js");

      const result = await commitDelegatedWorkerFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-20",
        workerId: "worker-source-20",
        routingClass: "coding",
        mechanismId: "run-source-20",
        workerSessionKey: "agent:main:subagent:child-20",
        processSessionId: "run-source-20",
        statusSummary: "porting the remaining Python control plane",
      });

      expect(result).toMatchObject({
        status: "accepted",
        action: "delegate",
        missionId: "mission-source-20",
        workerId: "worker-source-20",
      });

      const task = findTaskBySourceId("mission-source-20");
      expect(task).toMatchObject({
        sourceId: "mission-source-20",
        orchestrationWorkerId: "worker-source-20",
        requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
        childSessionKey: "agent:main:subagent:child-20",
        runId: "run-source-20",
        status: "running",
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:whatsapp:direct:+64270000000"]).toMatchObject({
        activeMissionId: "mission-source-20",
        focusedWorkerId: "worker-source-20",
        workerNoticeCount: 1,
        continuityCapsule: expect.objectContaining({
          activeMissionIds: ["mission-source-20"],
        }),
      });
    });
  });

  it("records heartbeat progress and completes missions through the native task lifecycle", async () => {
    await withControlPlaneTempDir(async () => {
      const {
        commitDelegatedWorkerFromSession,
        completeMissionFromSession,
        heartbeatMissionFromSession,
        queryMissionStatusFromSession,
      } = await import("./control-plane.js");

      await commitDelegatedWorkerFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        routingClass: "coding",
        mechanismId: "run-source-21",
        workerSessionKey: "agent:main:subagent:child-21",
        processSessionId: "run-source-21",
        statusSummary: "running the native orchestration bridge",
      });

      const heartbeat = await heartbeatMissionFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        statusSummary: "worker is still applying the migration",
      });
      expect(heartbeat).toMatchObject({
        action: "heartbeat",
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        state: "running",
      });

      const completed = await completeMissionFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        state: "completed",
        statusSummary: "ported the control plane into source",
        deliveryState: "session_queued",
      });
      expect(completed).toMatchObject({
        action: "completed",
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        state: "completed",
      });

      await waitForAssertion(() => {
        const task = findTaskBySourceId("mission-source-21");
        expect(task).toMatchObject({
          status: "succeeded",
          deliveryStatus: "session_queued",
        });
      });

      const status = await queryMissionStatusFromSession({
        missionId: "mission-source-21",
      });
      expect(status).toMatchObject({
        found: true,
        missionId: "mission-source-21",
        workerId: "worker-source-21",
        state: "completed",
        deliveryState: "session_queued",
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        const entry = store["agent:main:whatsapp:direct:+64270000000"];
        expect(entry?.lastDeliveredMission).toMatchObject({
          missionId: "mission-source-21",
          workerId: "worker-source-21",
          state: "completed",
        });
        expect(readPendingMissionNotificationRecords(entry)).toHaveLength(1);
        expect(entry?.activeMissionId ?? null).toBeNull();
        expect(entry?.focusedWorkerId ?? null).toBeNull();
        expect(entry?.continuityCapsule).toMatchObject({
          recentMissionIds: ["mission-source-21"],
        });
      });
    });
  });

  it("resets direct-session continuity state when orchestration freshness thresholds are exceeded", async () => {
    await withControlPlaneTempDir(async () => {
      const { setSessionMissionBinding } = await import("./session-state.js");
      const { prepareDispatchRequestFromSession } = await import("./control-plane.js");

      const sessionKey = "agent:main:whatsapp:direct:+64270000000";
      const transcriptPath = path.join(
        process.env.OPENCLAW_STATE_DIR ?? ".",
        "sessions",
        "oversized.jsonl",
      );
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "x".repeat(512));

      const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR ?? ".";
      await fs.writeFile(
        path.join(workspaceDir, "skills", "clawbot-autoresearch", "runtime.json"),
        JSON.stringify(
          {
            orchestration: {
              enabled: true,
              enabledChannels: ["cli", "telegram", "whatsapp"],
              directSessionContinuity: {
                maxTranscriptBytes: 64,
                maxCompactions: 1,
                maxWorkerNotices: 2,
              },
            },
          },
          null,
          2,
        ),
      );

      await setSessionMissionBinding({
        sessionKey,
        missionId: "mission-oversized",
        workerId: "worker-oversized",
        continuitySummary: "stale continuity summary",
      });
      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await updateSessionStoreEntry({
        storePath,
        sessionKey,
        update: async () => ({
          sessionFile: transcriptPath,
          compactionCount: 3,
          workerNoticeCount: 4,
          continuitySummary: "stale continuity summary",
          continuityUpdatedAt: 111,
        }),
      });

      const prepared = await prepareDispatchRequestFromSession({
        sessionKey,
        text: "Implement the orchestration runtime config slice",
        hasRepoMutation: true,
        allowAutoDelegate: true,
      });

      expect(prepared).toMatchObject({
        action: "delegate",
        routingClass: "coding",
        orchestratorFreshness: {
          needsRotation: true,
          reasons: ["transcript_bytes", "compactions", "worker_notices"],
        },
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]).toMatchObject({
        workerNoticeCount: 0,
        continuitySummary: null,
        continuityCapsule: null,
        freshnessResetReasons: ["transcript_bytes", "compactions", "worker_notices"],
      });
      expect(store[sessionKey]?.freshnessResetAt).toEqual(expect.any(Number));
    });
  });
});
