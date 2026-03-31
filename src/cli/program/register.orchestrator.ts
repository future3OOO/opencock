import fs from "node:fs";
import type { Command } from "commander";
import {
  ORCHESTRATION_BRIDGE_COMMANDS,
  runOrchestrationBridgeCommand,
} from "../../orchestration/bridge.js";
import {
  commitDelegatedWorkerFromSession,
  completeMissionFromSession,
  delegateExplicitRequestFromSession,
  heartbeatMissionFromSession,
  prepareDispatchRequestFromSession,
  queryMissionStatusFromSession,
} from "../../orchestration/control-plane.js";
import {
  DELEGATABLE_ROUTING_CLASSES,
  cancelMissionFromSession,
  delegateFromSession,
  delegateManyFromSession,
  listMissionsFromSession,
  statusFromSession,
} from "../../orchestration/service.js";

const DELEGATABLE_ROUTING_CLASSES_TEXT = DELEGATABLE_ROUTING_CLASSES.join(", ");

function resolveSessionKey(opts: { sessionKey?: string }): string {
  return opts.sessionKey?.trim() || process.env.OPENCLAW_SESSION_KEY?.trim() || "";
}

function resolveTask(opts: { task?: string; taskFile?: string }): string {
  if (opts.taskFile) {
    const content = fs.readFileSync(opts.taskFile, "utf8").trim();
    if (!content) {
      throw new Error(`--task-file ${opts.taskFile} is empty`);
    }
    return content;
  }
  return opts.task?.trim() || "";
}

function resolveDelegateManyItems(opts: { itemsJson?: string; itemsFile?: string }) {
  if (opts.itemsJson && opts.itemsFile) {
    throw new Error("Pass --items-json or --items-file, not both.");
  }
  const raw = opts.itemsFile ? fs.readFileSync(opts.itemsFile, "utf8") : opts.itemsJson;
  if (!raw?.trim()) {
    throw new Error("Provide --items-json or --items-file.");
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("delegate-many payload must be a JSON array.");
  }
  return parsed;
}

function output(data: unknown) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function errorPayload(error: string, category?: string) {
  return category ? { status: "error", error, category } : { status: "error", error };
}

function resolveToolNeeds(opts: { toolNeed?: string[] }): string[] | undefined {
  const toolNeeds = Array.isArray(opts.toolNeed)
    ? opts.toolNeed.map((item) => item.trim()).filter(Boolean)
    : [];
  return toolNeeds.length > 0 ? toolNeeds : undefined;
}

function resolveBridgePayload(opts: { payloadJson?: string; payloadFile?: string }) {
  if (opts.payloadJson && opts.payloadFile) {
    throw new Error("Pass --payload-json or --payload-file, not both.");
  }
  const raw = opts.payloadFile
    ? fs.readFileSync(opts.payloadFile, "utf8")
    : (opts.payloadJson ?? fs.readFileSync(0, "utf8"));
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bridge payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function registerBridgeCommand(orch: Command) {
  const bridge = orch
    .command("bridge")
    .description("Compatibility bridge for legacy orchestration JSON-over-stdin callers");

  for (const bridgeCommand of ORCHESTRATION_BRIDGE_COMMANDS) {
    bridge
      .command(bridgeCommand)
      .description(`Run the native orchestration bridge action: ${bridgeCommand}`)
      .option("--payload-json <json>", "Bridge payload JSON")
      .option("--payload-file <path>", "Read bridge payload JSON from file")
      .option("--json", "Output JSON", true)
      .action(async (opts) => {
        try {
          const payload = resolveBridgePayload(opts);
          output(await runOrchestrationBridgeCommand(bridgeCommand, payload));
        } catch (error) {
          output(errorPayload((error as Error).message, "bridge_error"));
          process.exitCode = 1;
        }
      });
  }
}

export function registerOrchestratorCommand(program: Command) {
  const orch = program
    .command("orchestrator")
    .description("Delegate and track offloaded work from direct sessions");

  orch
    .command("prepare")
    .description("Classify a direct-session request and decide inline/continue/delegate")
    .requiredOption("--text <text>", "Incoming user request")
    .option("--surface <surface>", "Surface context (default: session channel/general)")
    .option("--has-browser-need", "Browser or page interaction is required", false)
    .option("--has-repo-mutation", "Repo/file mutation is required", false)
    .option("--has-timed-commitment", "Timed or ongoing work is required", false)
    .option("--tool-need <name...>", "Tool needs for the worker")
    .option("--is-multi-step", "Request is explicitly multi-step", false)
    .option(
      "--allow-auto-delegate",
      "Allow non-direct-answer work to plan a delegate action",
      false,
    )
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await prepareDispatchRequestFromSession({
          text: opts.text,
          sessionKey,
          surface: opts.surface,
          hasBrowserNeed: Boolean(opts.hasBrowserNeed),
          hasRepoMutation: Boolean(opts.hasRepoMutation),
          hasTimedCommitment: Boolean(opts.hasTimedCommitment),
          toolNeeds: resolveToolNeeds(opts),
          isMultiStep: Boolean(opts.isMultiStep),
          allowAutoDelegate: Boolean(opts.allowAutoDelegate),
        }),
      );
    });

  orch
    .command("delegate-explicit")
    .description("Build a native delegate plan without spawning the worker yet")
    .option("--routing-class <class>", `Routing class (${DELEGATABLE_ROUTING_CLASSES_TEXT})`)
    .option("--routingClass <class>", "Alias for --routing-class")
    .requiredOption("--status-summary <text>", "Compact status summary")
    .option("--task <text>", "Task description")
    .option("--task-file <path>", "Read task from file")
    .option("--surface <surface>", "Surface context (default: session channel/general)")
    .option("--tool-need <name...>", "Tool needs for the worker")
    .option("--mutation-target <path...>", "Explicit mutation targets for delegated work")
    .option("--timeout-seconds <n>", "Worker run timeout in seconds", parseInt)
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const routingClass = opts.routingClass?.trim();
      if (!routingClass) {
        output(errorPayload("Missing --routing-class.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      if (opts.task && opts.taskFile) {
        output(errorPayload("Pass --task or --task-file, not both.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      let task: string;
      try {
        task = resolveTask(opts);
      } catch (error) {
        output(errorPayload((error as Error).message, "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      if (!task) {
        output(errorPayload("Provide --task or --task-file.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const result = await delegateExplicitRequestFromSession({
        sessionKey,
        routingClass,
        task,
        statusSummary: opts.statusSummary,
        surface: opts.surface,
        toolNeeds: resolveToolNeeds(opts),
        mutationTargets: Array.isArray(opts.mutationTarget)
          ? opts.mutationTarget.map((item: string) => item.trim()).filter(Boolean)
          : undefined,
        timeoutSeconds: opts.timeoutSeconds,
      });
      output(result);
      if (result.status !== "accepted") {
        process.exitCode = 1;
      }
    });

  orch
    .command("delegate")
    .description("Delegate tracked work to a worker session")
    .option("--routing-class <class>", `Routing class (${DELEGATABLE_ROUTING_CLASSES_TEXT})`)
    .option("--routingClass <class>", "Alias for --routing-class")
    .requiredOption("--status-summary <text>", "Compact status summary")
    .option("--task <text>", "Task description")
    .option("--task-file <path>", "Read task from file")
    .option("--surface <surface>", "Surface context (default: session channel/general)")
    .option("--tool-need <name...>", "Tool needs for the worker")
    .option("--timeout-seconds <n>", "Worker run timeout in seconds", parseInt)
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const routingClass = opts.routingClass?.trim();
      if (!routingClass) {
        output(errorPayload("Missing --routing-class.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      if (opts.task && opts.taskFile) {
        output(errorPayload("Pass --task or --task-file, not both.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      let task: string;
      try {
        task = resolveTask(opts);
      } catch (error) {
        output(errorPayload((error as Error).message, "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      if (!task) {
        output(errorPayload("Provide --task or --task-file.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const result = await delegateFromSession({
        sessionKey,
        routingClass,
        task,
        statusSummary: opts.statusSummary,
        surface: opts.surface,
        toolNeeds: opts.toolNeed,
        timeoutSeconds: opts.timeoutSeconds,
      });
      output(result);
      if (result.status !== "accepted") {
        process.exitCode = 1;
      }
    });

  orch
    .command("commit")
    .description("Persist a running delegated worker into the native orchestration runtime")
    .requiredOption("--mission-id <id>", "Mission ID to commit")
    .requiredOption("--worker-id <id>", "Worker ID to commit")
    .option("--routing-class <class>", `Routing class (${DELEGATABLE_ROUTING_CLASSES_TEXT})`)
    .option("--routingClass <class>", "Alias for --routing-class")
    .option("--mechanism-id <id>", "Mechanism/runtime id for the worker")
    .option("--surface <surface>", "Surface context (default: session channel/general)")
    .option("--worker-session-key <key>", "Worker session key")
    .option("--process-session-id <id>", "Worker process session id")
    .option("--suppression-key <key>", "Deterministic suppression key")
    .option("--status-summary <text>", "Compact status summary")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      const routingClass = opts.routingClass?.trim();
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      if (!routingClass) {
        output(errorPayload("Missing --routing-class.", "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const result = await commitDelegatedWorkerFromSession({
        sessionKey,
        missionId: opts.missionId,
        workerId: opts.workerId,
        routingClass,
        mechanismId: opts.mechanismId,
        surface: opts.surface,
        workerSessionKey: opts.workerSessionKey,
        processSessionId: opts.processSessionId,
        suppressionKey: opts.suppressionKey,
        statusSummary: opts.statusSummary,
      });
      output(result);
      if (result.status !== "accepted") {
        process.exitCode = 1;
      }
    });

  orch
    .command("delegate-many")
    .description("Delegate several independent tracked workers in one call")
    .option("--items-json <json>", "JSON array of delegate specs")
    .option("--items-file <path>", "Read JSON array of delegate specs from file")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      let items: unknown[];
      try {
        items = resolveDelegateManyItems(opts);
      } catch (error) {
        output(errorPayload((error as Error).message, "delegate_rejected"));
        process.exitCode = 1;
        return;
      }
      const result = await delegateManyFromSession({
        sessionKey,
        items: items as Parameters<typeof delegateManyFromSession>[0]["items"],
      });
      output(result);
      if (result.status === "error") {
        process.exitCode = 1;
      }
    });

  orch
    .command("complete")
    .description("Mark a delegated mission terminal in the native orchestration runtime")
    .requiredOption("--mission-id <id>", "Mission ID to complete")
    .requiredOption("--worker-id <id>", "Worker ID to complete")
    .option("--state <state>", "Terminal state (completed, failed, aborted, timed_out)")
    .option("--status-summary <text>", "Terminal status summary")
    .option("--reply-text <text>", "Compact reply text override")
    .option("--artifact-path <path>", "Artifact path")
    .option(
      "--delivery-state <state>",
      "Delivery state (pending, delivered, session_queued, permanent_failure)",
    )
    .option("--no-clear-binding", "Leave the active mission binding intact")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await completeMissionFromSession({
          sessionKey,
          missionId: opts.missionId,
          workerId: opts.workerId,
          state: opts.state,
          statusSummary: opts.statusSummary,
          replyText: opts.replyText,
          artifactPath: opts.artifactPath,
          deliveryState: opts.deliveryState,
          clearBinding: opts.clearBinding,
        }),
      );
    });

  orch
    .command("heartbeat")
    .description("Refresh a running delegated mission heartbeat")
    .requiredOption("--mission-id <id>", "Mission ID to refresh")
    .requiredOption("--worker-id <id>", "Worker ID to refresh")
    .option("--status-summary <text>", "Progress summary")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await heartbeatMissionFromSession({
          sessionKey,
          missionId: opts.missionId,
          workerId: opts.workerId,
          statusSummary: opts.statusSummary,
        }),
      );
    });

  orch
    .command("status")
    .description("Query mission status (defaults to caller session's active mission)")
    .option("--mission-id <id>", "Specific mission ID to query")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await statusFromSession({
          sessionKey,
          missionId: opts.missionId?.trim(),
        }),
      );
    });

  orch
    .command("list")
    .description("List orchestrator missions for this session or across direct sessions")
    .option("--active-only", "Only show running missions", false)
    .option("--all-direct-sessions", "Show missions bound to all direct sessions", false)
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await listMissionsFromSession({
          sessionKey,
          activeOnly: Boolean(opts.activeOnly),
          allDirectSessions: Boolean(opts.allDirectSessions),
        }),
      );
    });

  orch
    .command("cancel")
    .description("Abort a running mission and clear its binding")
    .requiredOption("--mission-id <id>", "Mission ID to abort")
    .option("--status-summary <text>", "Abort status summary")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      const result = await cancelMissionFromSession({
        sessionKey,
        missionId: opts.missionId?.trim(),
        statusSummary: opts.statusSummary?.trim(),
      });
      output(result);
      if (result.action !== "cancelled") {
        process.exitCode = 1;
      }
    });

  orch
    .command("query-status")
    .description("Query canonical mission status by mission id")
    .requiredOption("--mission-id <id>", "Mission ID to query")
    .option("--session-key <key>", "Session key override (debug only)")
    .option("--json", "Output JSON", true)
    .action(async (opts) => {
      const sessionKey = resolveSessionKey(opts);
      if (!sessionKey) {
        output(
          errorPayload(
            "No session key. Set OPENCLAW_SESSION_KEY or pass --session-key.",
            "invalid_session",
          ),
        );
        process.exitCode = 1;
        return;
      }
      output(
        await queryMissionStatusFromSession({
          missionId: opts.missionId,
        }),
      );
    });

  registerBridgeCommand(orch);
}
