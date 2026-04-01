import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRuntimeEntrypointManifest,
  pruneStaleRuntimeEntrypointArtifacts,
  writeRuntimeEntrypointManifest,
} from "../../scripts/runtime-entrypoint-manifest.mjs";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createTempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-entrypoints-"));
  cleanupDirs.push(dir);
  return dir;
}

async function seedRuntimeAliases(rootDir: string) {
  const distDir = path.join(rootDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, "health.js"), 'export * from "./health-AbCd1234.js";\n');
  await fs.writeFile(path.join(distDir, "health-AbCd1234.js"), "export const health = true;\n");
  await fs.writeFile(path.join(distDir, "health-Old11111.js"), "export const old = true;\n");
  await fs.writeFile(
    path.join(distDir, "health-format-KeepMe.js"),
    "export const format = true;\n",
  );
  await fs.writeFile(
    path.join(distDir, "reply.runtime.js"),
    'export * from "./reply.runtime-ZxY987.js";\n',
  );
  await fs.writeFile(path.join(distDir, "reply.runtime-ZxY987.js"), "export const reply = true;\n");
  await fs.writeFile(
    path.join(distDir, "reply.runtime-Legacy000.js"),
    "export const legacy = true;\n",
  );
  await fs.writeFile(
    path.join(distDir, "compact.runtime.js"),
    'export * from "./compact.runtime-QwErTy12.js";\n',
  );
  await fs.writeFile(
    path.join(distDir, "compact.runtime-QwErTy12.js"),
    "export const compact = true;\n",
  );
  await fs.writeFile(
    path.join(distDir, "compact.runtime-OldOld99.js"),
    "export const compactLegacy = true;\n",
  );
  return distDir;
}

describe("runtime entrypoint manifest", () => {
  it("collects aliased runtime targets and stale siblings by exact family", async () => {
    const rootDir = await createTempRoot();
    await seedRuntimeAliases(rootDir);

    const manifest = collectRuntimeEntrypointManifest({ rootDir });

    expect(manifest.aliases["health.js"]).toEqual({
      targetFile: "health-AbCd1234.js",
      familyStem: "health",
      staleSiblings: ["health-Old11111.js"],
    });
    expect(manifest.aliases["reply.runtime.js"]).toEqual({
      targetFile: "reply.runtime-ZxY987.js",
      familyStem: "reply.runtime",
      staleSiblings: ["reply.runtime-Legacy000.js"],
    });
    expect(manifest.aliases["compact.runtime.js"]).toEqual({
      targetFile: "compact.runtime-QwErTy12.js",
      familyStem: "compact.runtime",
      staleSiblings: ["compact.runtime-OldOld99.js"],
    });
  });

  it("prunes only stale siblings for the aliased runtime families", async () => {
    const rootDir = await createTempRoot();
    const distDir = await seedRuntimeAliases(rootDir);
    const manifest = collectRuntimeEntrypointManifest({ rootDir });

    const pruned = pruneStaleRuntimeEntrypointArtifacts({ rootDir, manifest });

    expect(pruned).toEqual([
      { aliasFile: "health.js", removed: ["health-Old11111.js"] },
      { aliasFile: "reply.runtime.js", removed: ["reply.runtime-Legacy000.js"] },
      { aliasFile: "compact.runtime.js", removed: ["compact.runtime-OldOld99.js"] },
    ]);
    await expect(fs.stat(path.join(distDir, "health-AbCd1234.js"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(distDir, "health-format-KeepMe.js"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(distDir, "health-Old11111.js"))).rejects.toThrow();
  });

  it("writes a manifest after pruning stale runtime siblings", async () => {
    const rootDir = await createTempRoot();
    const distDir = await seedRuntimeAliases(rootDir);

    const { manifestPath, manifest } = writeRuntimeEntrypointManifest({ rootDir });

    expect(path.basename(manifestPath)).toBe("runtime-entrypoints.json");
    expect(manifest.pruned).toEqual([
      { aliasFile: "health.js", removed: ["health-Old11111.js"] },
      { aliasFile: "reply.runtime.js", removed: ["reply.runtime-Legacy000.js"] },
      { aliasFile: "compact.runtime.js", removed: ["compact.runtime-OldOld99.js"] },
    ]);
    const onDisk = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      aliases: Record<string, { staleSiblings: string[] }>;
    };
    expect(onDisk.aliases["health.js"].staleSiblings).toEqual([]);
    expect(onDisk.aliases["reply.runtime.js"].staleSiblings).toEqual([]);
    expect(onDisk.aliases["compact.runtime.js"].staleSiblings).toEqual([]);
    await expect(fs.stat(path.join(distDir, "reply.runtime-Legacy000.js"))).rejects.toThrow();
  });
});
