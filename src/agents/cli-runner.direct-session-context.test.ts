import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  mockSuccessfulCliRun,
  setupCliRunnerTestModule,
  stubDirectSessionBootstrapContext,
} from "./cli-runner.test-support.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withCliRunnerTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-cli-direct-context-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    clearConfigCache();
    try {
      return await run(root);
    } finally {
      clearConfigCache();
    }
  });
}

describe("runCliAgent direct-session mission context", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    clearConfigCache();
  });

  it("clears consumed pending mission notifications after a successful reply", async () => {
    await withCliRunnerTempDir(async () => {
      const runCliAgent = await setupCliRunnerTestModule();
      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      await updateSessionStore(storePath, async (store) => {
        store["agent:main:main"] = mergeSessionEntry(undefined, {
          sessionId: "cli-direct-context",
          updatedAt: Date.now(),
          pendingMissionNotifications: {
            "mission-cli-1": {
              missionId: "mission-cli-1",
              workerId: "worker-cli-1",
              finalState: "completed",
              statusSummary: "worker finished cleanly",
              artifactPath: null,
              deliveredAtMs: 1_000,
              attempts: 0,
              expiresAtMs: 61_000,
            },
          },
        });
        return store["agent:main:main"];
      });
      stubDirectSessionBootstrapContext({
        consumedPendingMissionIds: ["mission-cli-1"],
      });
      mockSuccessfulCliRun();

      const result = await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-direct-context-clear",
      });

      expect(result.payloads?.[0]?.text).toBe("ok");
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:main"]?.pendingMissionNotifications ?? null).toBeNull();
    });
  });
});
