import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  buildOrchestrationMissionLabel,
  buildOrchestrationSuppressionKey,
} from "./runtime-primitives.js";

const spawnSubagentDirectMock = vi.fn();
const cancelTaskByIdMock = vi.fn();

vi.mock("../agents/subagent-spawn.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/subagent-spawn.js")>(
    "../agents/subagent-spawn.js",
  );
  return {
    ...actual,
    spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
  };
});

vi.mock("../tasks/task-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../tasks/task-registry.js")>(
    "../tasks/task-registry.js",
  );
  return {
    ...actual,
    cancelTaskById: (...args: unknown[]) => cancelTaskByIdMock(...args),
  };
});

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withOrchestrationTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-orchestration-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    const { resetTaskRegistryForTests } = await import("../tasks/task-registry.js");
    resetTaskRegistryForTests();
    try {
      return await run(root);
    } finally {
      resetTaskRegistryForTests();
    }
  });
}

describe("orchestration service", () => {
  beforeEach(() => {
    spawnSubagentDirectMock.mockReset();
    cancelTaskByIdMock.mockReset();
  });

  afterEach(async () => {
    const { resetTaskRegistryForTests } = await import("../tasks/task-registry.js");
    resetTaskRegistryForTests({ persist: false });
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
  });

  it("delegates natively through subagent spawn and binds the mission in session state", async () => {
    await withOrchestrationTempDir(async () => {
      const { delegateFromSession } = await import("./service.js");
      spawnSubagentDirectMock.mockResolvedValue({
        status: "accepted",
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-child-1",
      });

      const result = await delegateFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        routingClass: "coding",
        task: "Implement the orchestration source slice",
        statusSummary: "porting the delegation loop",
        surface: "whatsapp",
        toolNeeds: ["rg", "apply_patch"],
        timeoutSeconds: 900,
      });

      expect(result).toMatchObject({
        status: "accepted",
        action: "delegate",
        routingClass: "coding",
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-child-1",
      });
      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") {
        throw new Error(`delegateFromSession rejected: ${result.error}`);
      }
      expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
      expect(spawnSubagentDirectMock.mock.calls[0]?.[0]).toMatchObject({
        label: "coding",
        cleanup: "delete",
        runTimeoutSeconds: 900,
        orchestration: expect.objectContaining({
          routingClass: "coding",
          surface: "whatsapp",
          statusSummary: "porting the delegation loop",
          suppressionKey: expect.any(String),
        }),
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      const store = loadSessionStore(storePath, { skipCache: true });
      const entry =
        loadSessionEntry("agent:main:whatsapp:direct:+64270000000").entry ??
        store["agent:main:whatsapp:direct:+64270000000"];
      expect(entry?.activeMissionId).toBe(result.missionId);
      expect(entry?.focusedWorkerId).toBe(result.workerId);
      expect(entry?.workerNoticeCount).toBe(1);
      expect(entry?.continuityCapsule).toMatchObject({
        summary: expect.any(String),
        activeMissionIds: [result.missionId],
      });
    });
  });

  it("suppresses duplicate delegates against an existing source-owned mission", async () => {
    await withOrchestrationTempDir(async () => {
      const taskExecutor = await import("../tasks/task-executor.js");
      const { delegateFromSession } = await import("./service.js");

      const suppressionKey = buildOrchestrationSuppressionKey({
        sessionMode: "orchestrator",
        userOrChannel: "agent:main:whatsapp:direct:+64270000000",
        missionLabel: buildOrchestrationMissionLabel({
          routingClass: "coding",
          sourceText: "porting the delegation loop",
        }),
        surface: "whatsapp",
        toolNeeds: ["apply_patch", "rg"],
      });

      taskExecutor.createRunningTaskRun({
        runtime: "subagent",
        sourceId: "mission-source-dup",
        orchestrationWorkerId: "worker-source-dup",
        orchestrationRoutingClass: "coding",
        orchestrationSurface: "whatsapp",
        orchestrationStatusSummary: "porting the delegation loop",
        orchestrationSuppressionKey: suppressionKey,
        requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
        childSessionKey: "agent:main:subagent:child-dup",
        runId: "run-source-dup",
        label: "coding",
        task: "Implement the orchestration source slice",
        deliveryStatus: "pending",
      });

      const result = await delegateFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        routingClass: "coding",
        task: "Implement the orchestration source slice",
        statusSummary: "porting the delegation loop",
        surface: "whatsapp",
        toolNeeds: ["rg", "apply_patch"],
        timeoutSeconds: 900,
      });

      expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "accepted",
        action: "suppressed",
        missionId: "mission-source-dup",
        workerId: "worker-source-dup",
        suppressed: {
          reason: "live_owner_exists",
        },
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      const store = loadSessionStore(storePath, { skipCache: true });
      const entry =
        loadSessionEntry("agent:main:whatsapp:direct:+64270000000").entry ??
        store["agent:main:whatsapp:direct:+64270000000"];
      expect(entry?.activeMissionId).toBe("mission-source-dup");
      expect(entry?.focusedWorkerId).toBe("worker-source-dup");
      expect(entry?.continuityCapsule).toMatchObject({
        activeMissionIds: ["mission-source-dup"],
      });
    });
  });

  it("reads status and lists missions from source-owned task metadata", async () => {
    await withOrchestrationTempDir(async () => {
      const taskExecutor = await import("../tasks/task-executor.js");
      const { setSessionMissionBinding } = await import("./session-state.js");
      const { listMissionsFromSession, statusFromSession } = await import("./service.js");

      taskExecutor.createRunningTaskRun({
        runtime: "subagent",
        sourceId: "mission-source-10",
        orchestrationWorkerId: "worker-source-10",
        orchestrationRoutingClass: "coding",
        orchestrationSurface: "whatsapp",
        orchestrationStatusSummary: "implementing native orchestration",
        requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
        childSessionKey: "agent:main:subagent:child-10",
        runId: "run-source-10",
        label: "coding",
        task: "Implement orchestration",
        deliveryStatus: "pending",
      });
      await setSessionMissionBinding({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-10",
        workerId: "worker-source-10",
      });

      const status = await statusFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
      });
      expect(status).toMatchObject({
        found: true,
        missionId: "mission-source-10",
        workerId: "worker-source-10",
        routingClass: "coding",
        surface: "whatsapp",
        state: "running",
      });

      const listed = await listMissionsFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
      });
      expect(listed).toMatchObject({
        action: "list",
        count: 1,
      });
      expect(listed.missions?.[0]).toMatchObject({
        missionId: "mission-source-10",
        workerId: "worker-source-10",
      });
    });
  });

  it("cancels the native task and clears the active binding", async () => {
    await withOrchestrationTempDir(async () => {
      const taskExecutor = await import("../tasks/task-executor.js");
      const { cancelMissionFromSession } = await import("./service.js");
      const { setSessionMissionBinding } = await import("./session-state.js");

      const task = taskExecutor.createRunningTaskRun({
        runtime: "subagent",
        sourceId: "mission-source-11",
        orchestrationWorkerId: "worker-source-11",
        orchestrationRoutingClass: "coding",
        orchestrationSurface: "whatsapp",
        requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
        childSessionKey: "agent:main:subagent:child-11",
        runId: "run-source-11",
        label: "coding",
        task: "Cancel orchestration task",
        deliveryStatus: "pending",
      });
      await setSessionMissionBinding({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-11",
        workerId: "worker-source-11",
      });
      cancelTaskByIdMock.mockResolvedValue({
        found: true,
        cancelled: true,
        task: {
          ...task,
          status: "cancelled",
        },
      });

      const result = await cancelMissionFromSession({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-11",
        statusSummary: "aborted by operator",
      });

      expect(cancelTaskByIdMock).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: task.taskId,
        }),
      );
      expect(result).toMatchObject({
        action: "cancelled",
        missionId: "mission-source-11",
        workerId: "worker-source-11",
      });

      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      const store = loadSessionStore(storePath, { skipCache: true });
      const entry = store["agent:main:whatsapp:direct:+64270000000"];
      expect(entry?.activeMissionId).toBeNull();
      expect(entry?.focusedWorkerId).toBeNull();
    });
  });

  it("reconciles missing child sessions through the native task view", async () => {
    await withOrchestrationTempDir(async () => {
      const taskExecutor = await import("../tasks/task-executor.js");
      const { setSessionMissionBinding } = await import("./session-state.js");
      const { listMissionsFromSession, statusFromSession } = await import("./service.js");

      taskExecutor.createRunningTaskRun({
        runtime: "subagent",
        sourceId: "mission-source-lost",
        orchestrationWorkerId: "worker-source-lost",
        orchestrationRoutingClass: "coding",
        orchestrationSurface: "whatsapp",
        requesterSessionKey: "agent:main:whatsapp:direct:+64270000000",
        childSessionKey: "agent:main:subagent:missing-child",
        runId: "run-source-lost",
        label: "coding",
        task: "Reconcile lost task",
        deliveryStatus: "pending",
        startedAt: 0,
        lastEventAt: 0,
      });
      await setSessionMissionBinding({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        missionId: "mission-source-lost",
        workerId: "worker-source-lost",
      });

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10 * 60_000);
      try {
        const status = await statusFromSession({
          sessionKey: "agent:main:whatsapp:direct:+64270000000",
        });
        expect(status).toMatchObject({
          found: true,
          missionId: "mission-source-lost",
          state: "lost",
        });

        const listed = await listMissionsFromSession({
          sessionKey: "agent:main:whatsapp:direct:+64270000000",
        });
        expect(listed.missions?.[0]).toMatchObject({
          missionId: "mission-source-lost",
          state: "lost",
        });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
