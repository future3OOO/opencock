import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertStableRuntimeEntrypoints } from "../../scripts/check-stable-runtime-entrypoints.mjs";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createTempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stable-runtime-"));
  cleanupDirs.push(dir);
  return dir;
}

async function writeFixture(rootDir: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const filePath = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }),
  );
}

describe("check-stable-runtime-entrypoints", () => {
  it("accepts builds that expose stable runtime entrypoints", async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, {
      "dist/entry.js": 'await import("./run-main.js");\n',
      "dist/register.subclis-abc123.js": 'await import("./gateway-cli.js");\n',
      "dist/gateway-cli.js": "export const gateway = true;\n",
      "dist/run-main.js": 'await import("./health.js");\n',
      "dist/health.js": 'export * from "./health-xyz789.js";\n',
      "dist/health-xyz789.js": "export const health = true;\n",
      "dist/reply.runtime.js": 'export * from "./reply.runtime-abc123.js";\n',
      "dist/reply.runtime-abc123.js": "export const reply = true;\n",
      "dist/compact.runtime.js": 'export * from "./compact.runtime-def456.js";\n',
      "dist/compact.runtime-def456.js": "export const compact = true;\n",
    });

    expect(assertStableRuntimeEntrypoints({ rootDir })).toMatchObject({
      healthTarget: "health-xyz789.js",
      replyRuntimeTarget: "reply.runtime-abc123.js",
      compactRuntimeTarget: "compact.runtime-def456.js",
    });
  });

  it("fails when the stable import edges regress back to hashed-only paths", async () => {
    const rootDir = await createTempRoot();
    await writeFixture(rootDir, {
      "dist/entry.js": 'await import("./run-main-hashed.js");\n',
      "dist/register.subclis-abc123.js": 'await import("./gateway-cli-hashed.js");\n',
      "dist/gateway-cli.js": "export const gateway = true;\n",
      "dist/run-main.js": 'await import("./health-hashed.js");\n',
      "dist/health.js": 'export * from "./health-xyz789.js";\n',
      "dist/health-xyz789.js": "export const health = true;\n",
      "dist/reply.runtime.js": 'export * from "./reply.runtime-abc123.js";\n',
      "dist/reply.runtime-abc123.js": "export const reply = true;\n",
      "dist/compact.runtime.js": 'export * from "./compact.runtime-def456.js";\n',
      "dist/compact.runtime-def456.js": "export const compact = true;\n",
    });

    expect(() => assertStableRuntimeEntrypoints({ rootDir })).toThrow(
      /entry\.js must import "\.\/run-main\.js"/,
    );
  });
});
