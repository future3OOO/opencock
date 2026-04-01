import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveClaudeProjectMemoryDir(params: {
  workspaceDir: string;
  homeDir?: string;
}): string | null {
  const homeDir = params.homeDir?.trim() || process.env.HOME?.trim() || os.homedir();
  const workspaceDir = params.workspaceDir.trim();
  if (!homeDir || !workspaceDir) {
    return null;
  }
  const projectId = workspaceDir.replace(/[^a-z0-9]/gi, "-");
  return path.join(homeDir, ".claude", "projects", projectId, "memory");
}

export async function syncClaudeProjectMemory(params: {
  workspaceDir: string;
  content: string;
  homeDir?: string;
}): Promise<string | null> {
  const memoryDir = resolveClaudeProjectMemoryDir(params);
  if (!memoryDir) {
    return null;
  }
  const filePath = path.join(memoryDir, "MEMORY.md");
  await fs.mkdir(memoryDir, { recursive: true });
  const nextContent = params.content.trim() ? `${params.content.trim()}\n` : "";
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  if (existing !== nextContent) {
    await fs.writeFile(filePath, nextContent, "utf8");
  }
  return filePath;
}
