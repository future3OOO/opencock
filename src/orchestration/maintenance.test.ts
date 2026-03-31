import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createTaskRecord } from "../tasks/task-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { shouldMarkOrchestrationTaskStale } from "./maintenance.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR;

async function withMaintenanceTempDir<T>(run: (root: string, workspaceDir: string) => Promise<T>) {
  return await withTempDir({ prefix: "openclaw-orchestration-maintenance-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    const workspaceDir = path.join(root, "workspace");
    process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir;
    await fs.mkdir(path.join(workspaceDir, "skills", "clawbot-autoresearch"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        },
        null,
        2,
      ),
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    return await run(root, workspaceDir);
  });
}

describe("orchestration maintenance", () => {
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
  });

  it("marks active orchestrated tasks stale when the configured heartbeat window expires", async () => {
    await withMaintenanceTempDir(async (_root, workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "skills", "clawbot-autoresearch", "runtime.json"),
        JSON.stringify(
          {
            orchestration: {
              heartbeat: {
                staleMultiplier: 2,
                perRoutingClass: {
                  coding: 10,
                },
              },
            },
          },
          null,
          2,
        ),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();

      const task = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        runId: "run-maintenance-stale",
        task: "Stale coding task",
        status: "running",
        deliveryStatus: "pending",
        orchestrationRoutingClass: "coding",
      });

      expect(
        shouldMarkOrchestrationTaskStale({
          task: {
            ...task,
            lastEventAt: Date.now() - 30_000,
          },
          now: Date.now(),
        }),
      ).toEqual({
        stale: true,
        reason: "orchestration heartbeat stale: coding",
      });
    });
  });

  it("ignores non-active or non-orchestrated tasks", async () => {
    await withMaintenanceTempDir(async () => {
      const terminal = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        runId: "run-maintenance-terminal",
        task: "Done task",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        orchestrationRoutingClass: "coding",
      });
      const plain = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        runId: "run-maintenance-plain",
        task: "Plain task",
        status: "running",
        deliveryStatus: "pending",
      });

      expect(shouldMarkOrchestrationTaskStale({ task: terminal })).toEqual({ stale: false });
      expect(shouldMarkOrchestrationTaskStale({ task: plain })).toEqual({ stale: false });
    });
  });
});
