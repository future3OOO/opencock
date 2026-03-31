import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareDispatchRequestFromSessionMock = vi.fn();
const delegateExplicitRequestFromSessionMock = vi.fn();
const commitDelegatedWorkerFromSessionMock = vi.fn();
const completeMissionFromSessionMock = vi.fn();
const heartbeatMissionFromSessionMock = vi.fn();
const queryMissionStatusFromSessionMock = vi.fn();
const querySessionStatusFromSessionMock = vi.fn();
const delegateFromSessionMock = vi.fn();
const dispatchRequestFromSessionMock = vi.fn();
const delegateManyFromSessionMock = vi.fn();
const listMissionsFromSessionMock = vi.fn();
const statusFromSessionMock = vi.fn();
const cancelMissionFromSessionMock = vi.fn();
const registerExternalTaskFromSessionMock = vi.fn();

vi.mock("../../orchestration/control-plane.js", () => ({
  prepareDispatchRequestFromSession: (...args: unknown[]) =>
    prepareDispatchRequestFromSessionMock(...args),
  delegateExplicitRequestFromSession: (...args: unknown[]) =>
    delegateExplicitRequestFromSessionMock(...args),
  commitDelegatedWorkerFromSession: (...args: unknown[]) =>
    commitDelegatedWorkerFromSessionMock(...args),
  completeMissionFromSession: (...args: unknown[]) => completeMissionFromSessionMock(...args),
  heartbeatMissionFromSession: (...args: unknown[]) => heartbeatMissionFromSessionMock(...args),
  queryMissionStatusFromSession: (...args: unknown[]) => queryMissionStatusFromSessionMock(...args),
  querySessionStatusFromSession: (...args: unknown[]) => querySessionStatusFromSessionMock(...args),
  listOrchestratorMissionsFromSession: vi.fn(),
}));

vi.mock("../../orchestration/external-runtime.js", () => ({
  registerExternalTaskFromSession: (...args: unknown[]) =>
    registerExternalTaskFromSessionMock(...args),
}));

vi.mock("../../orchestration/service.js", () => ({
  DELEGATABLE_ROUTING_CLASSES: [
    "research",
    "coding",
    "browser",
    "timed-work",
    "multi-step",
    "external-action",
    "content-creation",
    "instagram-cycle",
    "self-improvement",
  ],
  delegateFromSession: (...args: unknown[]) => delegateFromSessionMock(...args),
  dispatchRequestFromSession: (...args: unknown[]) => dispatchRequestFromSessionMock(...args),
  delegateManyFromSession: (...args: unknown[]) => delegateManyFromSessionMock(...args),
  listMissionsFromSession: (...args: unknown[]) => listMissionsFromSessionMock(...args),
  statusFromSession: (...args: unknown[]) => statusFromSessionMock(...args),
  cancelMissionFromSession: (...args: unknown[]) => cancelMissionFromSessionMock(...args),
}));

describe("registerOrchestratorCommand", () => {
  beforeEach(() => {
    prepareDispatchRequestFromSessionMock.mockReset();
    delegateExplicitRequestFromSessionMock.mockReset();
    commitDelegatedWorkerFromSessionMock.mockReset();
    completeMissionFromSessionMock.mockReset();
    heartbeatMissionFromSessionMock.mockReset();
    queryMissionStatusFromSessionMock.mockReset();
    querySessionStatusFromSessionMock.mockReset();
    delegateFromSessionMock.mockReset();
    dispatchRequestFromSessionMock.mockReset();
    delegateManyFromSessionMock.mockReset();
    listMissionsFromSessionMock.mockReset();
    statusFromSessionMock.mockReset();
    cancelMissionFromSessionMock.mockReset();
    registerExternalTaskFromSessionMock.mockReset();
  });

  it("registers the orchestrator top-level command", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    const program = new Command();
    registerOrchestratorCommand(program);

    const command = program.commands.find((entry) => entry.name() === "orchestrator");
    expect(command).toBeDefined();
    expect(command?.commands.map((entry) => entry.name())).toEqual([
      "prepare",
      "delegate-explicit",
      "delegate",
      "register-external",
      "commit",
      "delegate-many",
      "complete",
      "heartbeat",
      "status",
      "list",
      "cancel",
      "query-status",
      "bridge",
    ]);
  });

  it("routes delegate args into the source orchestration service", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    delegateFromSessionMock.mockResolvedValue({
      status: "accepted",
      action: "delegate",
      missionId: "mission-1",
      workerId: "worker-1",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevEnv = process.env.OPENCLAW_SESSION_KEY;
    process.env.OPENCLAW_SESSION_KEY = "agent:main:main";
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "delegate",
        "--routing-class",
        "coding",
        "--status-summary",
        "implementing port",
        "--task",
        "Move orchestration into source",
        "--surface",
        "whatsapp",
      ]);
      expect(delegateFromSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          routingClass: "coding",
          statusSummary: "implementing port",
          task: "Move orchestration into source",
          surface: "whatsapp",
        }),
      );
    } finally {
      if (prevEnv === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = prevEnv;
      }
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });

  it("routes register-external args into the native external-task runtime", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    registerExternalTaskFromSessionMock.mockResolvedValue({
      status: "accepted",
      action: "registered",
      taskId: "task-external-1",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevEnv = process.env.OPENCLAW_SESSION_KEY;
    process.env.OPENCLAW_SESSION_KEY = "agent:main:main";
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "register-external",
        "--routing-class",
        "coding",
        "--label",
        "session-separation-signup",
        "--task",
        "Quarantined dirty live workspace changes for later continuation",
        "--surface",
        "general",
        "--source-id",
        "worker-signup-1",
        "--run-id",
        "worker-signup-1",
        "--status-summary",
        "migrated from live workspace; no active execution mechanism yet",
        "--worktree-path",
        "/tmp/worktree",
        "--branch",
        "worker/signup",
        "--artifact-path",
        "/tmp/patch.diff",
      ]);
      expect(registerExternalTaskFromSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          routingClass: "coding",
          label: "session-separation-signup",
          task: "Quarantined dirty live workspace changes for later continuation",
          surface: "general",
          sourceId: "worker-signup-1",
          runId: "worker-signup-1",
          statusSummary: "migrated from live workspace; no active execution mechanism yet",
          worktreePath: "/tmp/worktree",
          branch: "worker/signup",
          artifactPath: "/tmp/patch.diff",
        }),
      );
    } finally {
      if (prevEnv === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = prevEnv;
      }
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });

  it("routes prepare args into the native orchestration control plane", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    prepareDispatchRequestFromSessionMock.mockResolvedValue({
      action: "delegate",
      routingClass: "coding",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevEnv = process.env.OPENCLAW_SESSION_KEY;
    process.env.OPENCLAW_SESSION_KEY = "agent:main:whatsapp:direct:+64270000000";
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "prepare",
        "--text",
        "Please implement the native orchestration runtime",
        "--has-repo-mutation",
        "--tool-need",
        "rg",
        "apply_patch",
        "--allow-auto-delegate",
      ]);
      expect(prepareDispatchRequestFromSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:whatsapp:direct:+64270000000",
          text: "Please implement the native orchestration runtime",
          hasRepoMutation: true,
          allowAutoDelegate: true,
          toolNeeds: ["rg", "apply_patch"],
        }),
      );
    } finally {
      if (prevEnv === undefined) {
        delete process.env.OPENCLAW_SESSION_KEY;
      } else {
        process.env.OPENCLAW_SESSION_KEY = prevEnv;
      }
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });

  it("routes bridge delegate payloads into the native delegate-explicit control plane", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    delegateExplicitRequestFromSessionMock.mockResolvedValue({
      status: "accepted",
      action: "delegate",
      missionId: "m-bridge",
      workerId: "w-bridge",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "bridge",
        "delegate",
        "--payload-json",
        JSON.stringify({
          sessionKey: "agent:main:main",
          routingClass: "coding",
          task: "Move the legacy bridge into runtime",
          statusSummary: "porting orchestration bridge",
          surface: "whatsapp",
          toolNeeds: ["rg", "apply_patch"],
          mutationTargets: ["skills/clawbot-autoresearch/scripts/dispatch.py"],
          runTimeoutSeconds: 900,
        }),
      ]);
      expect(delegateExplicitRequestFromSessionMock).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        routingClass: "coding",
        task: "Move the legacy bridge into runtime",
        statusSummary: "porting orchestration bridge",
        surface: "whatsapp",
        toolNeeds: ["rg", "apply_patch"],
        mutationTargets: ["skills/clawbot-autoresearch/scripts/dispatch.py"],
        timeoutSeconds: 900,
      });
    } finally {
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });

  it("routes bridge dispatch payloads into the native combined ingress path", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    dispatchRequestFromSessionMock.mockResolvedValue({
      status: "accepted",
      action: "delegate",
      missionId: "m-dispatch",
      workerId: "w-dispatch",
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "bridge",
        "dispatch",
        "--payload-json",
        JSON.stringify({
          sessionKey: "agent:main:whatsapp:direct:+64270000000",
          text: "Implement the remaining native orchestration ingress",
          hasRepoMutation: true,
          toolNeeds: ["rg", "apply_patch"],
          isMultiStep: true,
        }),
      ]);
      expect(dispatchRequestFromSessionMock).toHaveBeenCalledWith({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        text: "Implement the remaining native orchestration ingress",
        hasBrowserNeed: false,
        hasRepoMutation: true,
        hasTimedCommitment: false,
        toolNeeds: ["rg", "apply_patch"],
        isMultiStep: true,
        surface: undefined,
      });
    } finally {
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });

  it("routes bridge status payloads without a mission id into the session-status control plane", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    querySessionStatusFromSessionMock.mockResolvedValue({
      found: false,
      missionId: null,
      state: null,
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerOrchestratorCommand(program);
      await program.parseAsync([
        "node",
        "openclaw",
        "orchestrator",
        "bridge",
        "status",
        "--payload-json",
        JSON.stringify({
          sessionKey: "agent:main:whatsapp:direct:+64270000000",
        }),
      ]);
      expect(querySessionStatusFromSessionMock).toHaveBeenCalledWith({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
      });
    } finally {
      process.exitCode = prevExit;
      stdout.mockRestore();
    }
  });
});
