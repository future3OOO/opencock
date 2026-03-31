import { describe, expect, it } from "vitest";
import {
  buildOrchestrationMissionLabel,
  buildOrchestrationMissionStatus,
  buildOrchestrationSuppressionKey,
  findSuppressedOrchestrationTask,
  isGroupOrchestratorSession,
  normalizeOrchestrationChannel,
  resolveContinuationIntent,
} from "./runtime-primitives.js";

describe("orchestration runtime primitives", () => {
  it("normalizes direct and group session channels", () => {
    expect(normalizeOrchestrationChannel("agent:main:main")).toBe("cli");
    expect(normalizeOrchestrationChannel("agent:main:telegram:direct:123")).toBe("telegram");
    expect(normalizeOrchestrationChannel("agent:main:whatsapp:direct:+6427")).toBe("whatsapp");
    expect(normalizeOrchestrationChannel("agent:main:telegram:group:abc")).toBe("unknown");
    expect(isGroupOrchestratorSession("agent:main:telegram:group:abc")).toBe(true);
    expect(isGroupOrchestratorSession("agent:main:telegram:direct:123")).toBe(false);
  });

  it("resolves continuation intent against an active mission binding", () => {
    expect(
      resolveContinuationIntent({
        text: "status?",
        activeMissionId: "mission-1",
        focusedWorkerId: "worker-1",
      }),
    ).toEqual({
      isContinuation: true,
      missionId: "mission-1",
      workerId: "worker-1",
    });
    expect(
      resolveContinuationIntent({
        text: "implement the status page",
        activeMissionId: "mission-1",
        focusedWorkerId: "worker-1",
      }),
    ).toEqual({
      isContinuation: false,
      missionId: undefined,
      workerId: undefined,
    });
  });

  it("builds stable mission labels and suppression keys", () => {
    expect(
      buildOrchestrationMissionLabel({
        routingClass: "coding",
        sourceText: "Implement the native orchestration runtime slice",
      }),
    ).toBe("coding:implement-the-native-orchestration-runtime-slice");

    const keyA = buildOrchestrationSuppressionKey({
      sessionMode: "orchestrator",
      userOrChannel: "agent:main:main",
      missionLabel: "coding:port-native-runtime",
      surface: "whatsapp",
      toolNeeds: ["apply_patch", "rg", "rg"],
    });
    const keyB = buildOrchestrationSuppressionKey({
      sessionMode: "orchestrator",
      userOrChannel: "agent:main:main",
      missionLabel: "coding:port-native-runtime",
      surface: "whatsapp",
      toolNeeds: ["rg", "apply_patch"],
    });
    expect(keyA).toBe(keyB);
  });

  it("suppresses duplicate live or cooldown-bound orchestration tasks", () => {
    const live = {
      taskId: "task-live",
      runtime: "subagent" as const,
      sourceId: "mission-live",
      orchestrationWorkerId: "worker-live",
      orchestrationRoutingClass: "coding",
      orchestrationSurface: "whatsapp",
      orchestrationSuppressionKey: "dup-key",
      requesterSessionKey: "agent:main:whatsapp:direct:+6427",
      runId: "run-live",
      task: "Live task",
      status: "running" as const,
      deliveryStatus: "pending" as const,
      notifyPolicy: "done_only" as const,
      createdAt: 100,
      startedAt: 100,
      lastEventAt: 100,
    };
    const liveResult = findSuppressedOrchestrationTask({
      suppressionKey: "dup-key",
      tasks: [live],
      nowMs: 500,
      cooldownSeconds: 30,
    });
    expect(liveResult).toMatchObject({
      suppress: true,
      reason: "live_owner_exists",
      existingMissionId: "mission-live",
      existingWorkerId: "worker-live",
    });

    const cooled = {
      ...live,
      taskId: "task-cooled",
      sourceId: "mission-cooled",
      orchestrationWorkerId: "worker-cooled",
      status: "succeeded" as const,
      deliveryStatus: "delivered" as const,
      startedAt: 1_000,
      lastEventAt: 2_000,
      terminalSummary: "completed recently",
    };
    const cooldownResult = findSuppressedOrchestrationTask({
      suppressionKey: "dup-key",
      tasks: [cooled],
      nowMs: 10_000,
      cooldownSeconds: 30,
    });
    expect(cooldownResult).toMatchObject({
      suppress: true,
      reason: "cooldown_active",
      existingMissionId: "mission-cooled",
      existingWorkerId: "worker-cooled",
    });
    expect(buildOrchestrationMissionStatus(cooled).replyText).toContain(
      "Mission mission-cooled is completed",
    );
  });
});
