import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { getTaskById, resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { withTempDir } from "../test-helpers/temp-dir.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR;

async function withExternalRuntimeTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-external-runtime-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    process.env.OPENCLAW_WORKSPACE_DIR = path.join(root, "workspace");
    await fs.mkdir(
      path.join(process.env.OPENCLAW_WORKSPACE_DIR, "skills", "clawbot-autoresearch"),
      { recursive: true },
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
    try {
      return await run(root);
    } finally {
      resetTaskRegistryForTests();
    }
  });
}

describe("external orchestration runtime", () => {
  afterEach(() => {
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    resetTaskRegistryForTests({ persist: false });
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

  it("registers quarantined external work as a source-owned lost cli task", async () => {
    await withExternalRuntimeTempDir(async () => {
      const { registerExternalTaskFromSession } = await import("./external-runtime.js");
      const result = await registerExternalTaskFromSession({
        sessionKey: "agent:main:main",
        routingClass: "coding",
        label: "session-separation-signup",
        task: "Quarantined dirty live workspace changes for later continuation",
        sourceId: "worker-signup-1",
        runId: "worker-signup-1",
        statusSummary: "migrated from live workspace; no active execution mechanism yet",
        worktreePath: "/tmp/worktree",
        branch: "worker/signup",
        artifactPath: "/tmp/patch.diff",
      });

      expect(result).toMatchObject({
        status: "accepted",
        action: "registered",
        sourceId: "worker-signup-1",
        runId: "worker-signup-1",
        routingClass: "coding",
      });
      expect(result.status).toBe("accepted");
      if (result.status !== "accepted") {
        throw new Error(`registerExternalTaskFromSession rejected: ${result.error}`);
      }
      const task = getTaskById(result.taskId);
      expect(task).toMatchObject({
        runtime: "cli",
        sourceId: "worker-signup-1",
        requesterSessionKey: "agent:main:main",
        runId: "worker-signup-1",
        label: "session-separation-signup",
        status: "lost",
        deliveryStatus: "not_applicable",
        orchestrationWorkerId: "worker-signup-1",
        orchestrationRoutingClass: "coding",
        orchestrationStatusSummary:
          "migrated from live workspace; no active execution mechanism yet",
        progressSummary: expect.stringContaining("worktree=/tmp/worktree"),
        error: "migrated from live workspace; no active execution mechanism yet",
      });
    });
  });
});
