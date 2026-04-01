import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanRuntimeBuildOutputs,
  pruneStaleRuntimeSymlinks,
  runTsdownBuild,
  shouldSkipBuildClean,
} from "../../scripts/tsdown-build.mjs";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createTempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tsdown-build-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("tsdown build wrapper", () => {
  it("treats --no-clean as an explicit opt-out", () => {
    expect(shouldSkipBuildClean(["--watch"])).toBe(false);
    expect(shouldSkipBuildClean(["--watch", "--no-clean"])).toBe(true);
  });

  it("removes dist outputs on standard builds", async () => {
    const rootDir = await createTempRoot();
    const distDir = path.join(rootDir, "dist");
    const distRuntimeDir = path.join(rootDir, "dist-runtime");
    await fs.mkdir(distDir, { recursive: true });
    await fs.mkdir(distRuntimeDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "entry.js"), "stub\n", "utf8");
    await fs.writeFile(path.join(distRuntimeDir, "entry.js"), "stub\n", "utf8");

    cleanRuntimeBuildOutputs({ rootDir });

    await expect(fs.stat(distDir)).rejects.toThrow();
    await expect(fs.stat(distRuntimeDir)).rejects.toThrow();
  });

  it("only strips runtime symlink overlays when --no-clean is used", async () => {
    const rootDir = await createTempRoot();
    const extensionDir = path.join(rootDir, "dist", "extensions", "sample");
    await fs.mkdir(extensionDir, { recursive: true });
    const targetDir = path.join(rootDir, "node_modules-target");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, path.join(extensionDir, "node_modules"));

    pruneStaleRuntimeSymlinks({ rootDir });

    await expect(fs.lstat(path.join(extensionDir, "node_modules"))).rejects.toThrow();
  });

  it("cleans by default before invoking tsdown", async () => {
    const rootDir = await createTempRoot();
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "entry.js"), "stale\n", "utf8");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    const exitCode = runTsdownBuild({ rootDir, spawnSyncImpl, extraArgs: [] });

    expect(exitCode).toBe(0);
    await expect(fs.stat(distDir)).rejects.toThrow();
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
  });

  it("keeps dist when --no-clean is requested", async () => {
    const rootDir = await createTempRoot();
    const distDir = path.join(rootDir, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "entry.js"), "kept\n", "utf8");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    const exitCode = runTsdownBuild({ rootDir, spawnSyncImpl, extraArgs: ["--no-clean"] });

    expect(exitCode).toBe(0);
    await expect(fs.readFile(path.join(distDir, "entry.js"), "utf8")).resolves.toBe("kept\n");
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
  });
});
