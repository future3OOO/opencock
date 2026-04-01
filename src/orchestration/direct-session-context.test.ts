import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { resolveDirectSessionBootstrapContext } from "./direct-session-context.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withDirectContextTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-direct-session-context-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    clearConfigCache();
    try {
      return await run(root);
    } finally {
      clearConfigCache();
    }
  });
}

describe("direct-session bootstrap context", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    clearConfigCache();
  });

  it("injects continuity, mission context, and recent conversation for direct sessions", async () => {
    await withDirectContextTempDir(async (root) => {
      const storePath = resolveStorePath(loadConfig().session?.store, { agentId: "main" });
      const sessionFile = path.join(root, "agents", "main", "sessions", "direct-session.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "What happened with the worker?" },
          }),
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "I delegated it." }] },
          }),
        ].join("\n"),
        "utf8",
      );

      await updateSessionStore(storePath, async (store) => {
        store["agent:main:whatsapp:direct:+64270000000"] = mergeSessionEntry(undefined, {
          sessionId: "direct-session",
          sessionFile,
          updatedAt: Date.now(),
          continuitySummary: "The worker was already delegated and is expected to report back.",
          activeMissionId: "mission-direct-1",
          recentMissionEvents: [
            {
              missionId: "mission-direct-1",
              workerId: "worker-direct-1",
              state: "completed",
              summary: "ported the runtime slice",
              artifactPath: null,
              deliveredAt: 1_000,
            },
          ],
          pendingMissionNotifications: {
            "mission-direct-1": {
              missionId: "mission-direct-1",
              workerId: "worker-direct-1",
              finalState: "completed",
              statusSummary: "ported the runtime slice",
              artifactPath: null,
              deliveredAtMs: 1_000,
              attempts: 0,
              expiresAtMs: 61_000,
            },
          },
        });
        return store["agent:main:whatsapp:direct:+64270000000"];
      });

      const result = await resolveDirectSessionBootstrapContext({
        sessionKey: "agent:main:whatsapp:direct:+64270000000",
        sessionFile,
      });

      expect(result.consumedPendingMissionIds).toEqual(["mission-direct-1"]);
      expect(result.bootstrapFile).toMatchObject({
        name: "BOOTSTRAP.md",
        path: "runtime://direct-session-context/BOOTSTRAP.md",
        missing: false,
      });
      expect(result.bootstrapFile?.content).toContain(
        "Delegate tracked execution with `openclaw orchestrator`.",
      );
      expect(result.bootstrapFile?.content).toContain(
        "Continuity: The worker was already delegated and is expected to report back.",
      );
      expect(result.bootstrapFile?.content).toContain("Active missions: mission-direct-1");
      expect(result.bootstrapFile?.content).toContain(
        "New mission results: mission-direct-1 completed — ported the runtime slice",
      );
      expect(result.bootstrapFile?.content).toContain("## Recent Conversation");
      expect(result.bootstrapFile?.content).toContain("user: What happened with the worker?");

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store["agent:main:whatsapp:direct:+64270000000"]?.lastSeenMissionEventAt).toBe(1_000);
    });
  });

  it("skips non-direct sessions", async () => {
    await withDirectContextTempDir(async () => {
      const result = await resolveDirectSessionBootstrapContext({
        sessionKey: "agent:main:subagent:worker-1",
      });

      expect(result.bootstrapFile).toBeUndefined();
      expect(result.consumedPendingMissionIds).toEqual([]);
    });
  });
});
