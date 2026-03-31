import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot, loadConfig } from "../config/config.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  evaluateOrchestratorContinuityFreshness,
  isOrchestrationChannelEnabled,
  loadOrchestrationRuntimeConfig,
} from "./runtime-config.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR;

async function withRuntimeConfigTempDir<T>(
  run: (root: string, workspaceDir: string) => Promise<T>,
) {
  return await withTempDir({ prefix: "openclaw-orchestration-config-" }, async (root) => {
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

describe("orchestration runtime config", () => {
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

  it("loads workspace compatibility overlays into the source-owned runtime config", async () => {
    await withRuntimeConfigTempDir(async (_root, workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "skills", "clawbot-autoresearch", "runtime.json"),
        JSON.stringify(
          {
            orchestration: {
              enabledChannels: ["telegram"],
              spawnSuppression: { cooldownSeconds: 45 },
              directSessionContinuity: { maxWorkerNotices: 7 },
            },
          },
          null,
          2,
        ),
      );

      const config = loadOrchestrationRuntimeConfig(loadConfig());
      expect(config.enabledChannels).toEqual(["telegram"]);
      expect(config.spawnSuppression.cooldownSeconds).toBe(45);
      expect(config.directSessionContinuity.maxWorkerNotices).toBe(7);
      expect(isOrchestrationChannelEnabled("agent:main:telegram:direct:544575267", config)).toBe(
        true,
      );
      expect(isOrchestrationChannelEnabled("agent:main:whatsapp:direct:+64270000000", config)).toBe(
        false,
      );
    });
  });

  it("evaluates continuity freshness from transcript size, compactions, and worker notices", async () => {
    await withRuntimeConfigTempDir(async (root, workspaceDir) => {
      await fs.writeFile(
        path.join(workspaceDir, "skills", "clawbot-autoresearch", "runtime.json"),
        JSON.stringify(
          {
            orchestration: {
              directSessionContinuity: {
                maxTranscriptBytes: 32,
                maxCompactions: 1,
                maxWorkerNotices: 2,
              },
            },
          },
          null,
          2,
        ),
      );

      const transcriptPath = path.join(root, "sessions", "large.jsonl");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "x".repeat(128));

      const freshness = evaluateOrchestratorContinuityFreshness({
        entry: {
          sessionId: "s-1",
          updatedAt: Date.now(),
          sessionFile: transcriptPath,
          compactionCount: 2,
          workerNoticeCount: 3,
        },
        config: loadOrchestrationRuntimeConfig(loadConfig()),
      });
      expect(freshness).toMatchObject({
        needsRotation: true,
        reasons: ["transcript_bytes", "compactions", "worker_notices"],
      });
      expect(freshness.transcriptBytes).toBeGreaterThan(32);
    });
  });
});
