import fs from "node:fs";
import type { Command } from "commander";
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

export function registerOrchestratorCommand(program: Command) {
  const orch = program
    .command("orchestrator")
    .description("Delegate and track offloaded work from direct sessions");

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
}
