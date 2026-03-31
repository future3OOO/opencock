import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const delegateFromSessionMock = vi.fn();
const delegateManyFromSessionMock = vi.fn();
const listMissionsFromSessionMock = vi.fn();
const statusFromSessionMock = vi.fn();
const cancelMissionFromSessionMock = vi.fn();

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
  delegateManyFromSession: (...args: unknown[]) => delegateManyFromSessionMock(...args),
  listMissionsFromSession: (...args: unknown[]) => listMissionsFromSessionMock(...args),
  statusFromSession: (...args: unknown[]) => statusFromSessionMock(...args),
  cancelMissionFromSession: (...args: unknown[]) => cancelMissionFromSessionMock(...args),
}));

describe("registerOrchestratorCommand", () => {
  beforeEach(() => {
    delegateFromSessionMock.mockReset();
    delegateManyFromSessionMock.mockReset();
    listMissionsFromSessionMock.mockReset();
    statusFromSessionMock.mockReset();
    cancelMissionFromSessionMock.mockReset();
  });

  it("registers the orchestrator top-level command", async () => {
    const { registerOrchestratorCommand } = await import("./register.orchestrator.js");
    const program = new Command();
    registerOrchestratorCommand(program);

    const command = program.commands.find((entry) => entry.name() === "orchestrator");
    expect(command).toBeDefined();
    expect(command?.commands.map((entry) => entry.name())).toEqual([
      "delegate",
      "delegate-many",
      "status",
      "list",
      "cancel",
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
});
