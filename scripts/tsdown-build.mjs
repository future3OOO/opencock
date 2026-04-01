#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const INEFFECTIVE_DYNAMIC_IMPORT_RE = /\[INEFFECTIVE_DYNAMIC_IMPORT\]/;
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");

function removeDistPluginNodeModulesSymlinks(rootDir, fsImpl = fs) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fsImpl.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fsImpl.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fsImpl.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fsImpl.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

export function pruneStaleRuntimeSymlinks(params = {}) {
  const cwd = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist"), fsImpl);
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist-runtime"), fsImpl);
}

export function shouldSkipBuildClean(extraArgs = []) {
  return extraArgs.includes("--no-clean");
}

export function cleanRuntimeBuildOutputs(params = {}) {
  const cwd = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  for (const dirName of ["dist", "dist-runtime"]) {
    fsImpl.rmSync(path.join(cwd, dirName), { recursive: true, force: true });
  }
}

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !normalizedLine.includes("node_modules/")
    ) {
      return normalizedLine;
    }
  }

  return null;
}

export function runTsdownBuild(params = {}) {
  const extraArgs = params.extraArgs ?? process.argv.slice(2);
  const cwd = params.rootDir ?? process.cwd();
  if (shouldSkipBuildClean(extraArgs)) {
    pruneStaleRuntimeSymlinks({ rootDir: cwd, fs: params.fs });
  } else {
    cleanRuntimeBuildOutputs({ rootDir: cwd, fs: params.fs });
  }

  const spawnSyncImpl = params.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(
    "pnpm",
    ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }

  if (result.status === 0 && INEFFECTIVE_DYNAMIC_IMPORT_RE.test(`${stdout}\n${stderr}`)) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    return 1;
  }

  const fatalUnresolvedImport =
    result.status === 0 ? findFatalUnresolvedImport(`${stdout}\n${stderr}`.split("\n")) : null;

  if (fatalUnresolvedImport) {
    console.error(`Build emitted [UNRESOLVED_IMPORT] outside extensions: ${fatalUnresolvedImport}`);
    return 1;
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runTsdownBuild());
}
