import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { resolveClaudeProjectMemoryDir, syncClaudeProjectMemory } from "./claude-project-memory.js";

describe("Claude project memory sync", () => {
  it("writes runtime memory into the Claude project directory", async () => {
    await withTempDir({ prefix: "openclaw-claude-project-memory-" }, async (root) => {
      const workspaceDir = "/tmp/opencock-lab/workspace";
      const memoryDir = resolveClaudeProjectMemoryDir({ workspaceDir, homeDir: root });
      expect(memoryDir).toBe(
        path.join(root, ".claude", "projects", "-tmp-opencock-lab-workspace", "memory"),
      );

      const filePath = await syncClaudeProjectMemory({
        workspaceDir,
        homeDir: root,
        content: "# Runtime Direct Context\n- hello",
      });

      expect(filePath).toBe(path.join(memoryDir!, "MEMORY.md"));
      expect(await fs.readFile(filePath!, "utf8")).toBe("# Runtime Direct Context\n- hello\n");
    });
  });

  it("falls back to the active home directory when no home override is provided", () => {
    const result = resolveClaudeProjectMemoryDir({
      workspaceDir: "/tmp/example",
      homeDir: "",
    });
    expect(result).toBe(
      path.join(
        process.env.HOME?.trim() || os.homedir(),
        ".claude",
        "projects",
        "-tmp-example",
        "memory",
      ),
    );
  });
});
