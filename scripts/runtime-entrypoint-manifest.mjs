import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASHED_RUNTIME_FILE_RE = /^(?<stem>.+)-(?<hash>[A-Za-z0-9_-]+)\.js$/u;

export const RUNTIME_ENTRYPOINT_ALIAS_SPECS = [
  { aliasFile: "health.js", targetPrefix: "health" },
  { aliasFile: "reply.runtime.js", targetPrefix: "reply\\.runtime" },
  { aliasFile: "compact.runtime.js", targetPrefix: "compact\\.runtime" },
];

function readTextFile(filePath, fsImpl = fs) {
  return fsImpl.readFileSync(filePath, "utf8");
}

function writeJsonFile(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveHashedStem(fileName) {
  const match = fileName.match(HASHED_RUNTIME_FILE_RE);
  return match?.groups?.stem ?? null;
}

function resolveAliasedTarget(distDir, aliasFile, targetPrefix, fsImpl = fs) {
  const aliasPath = path.join(distDir, aliasFile);
  const aliasSource = readTextFile(aliasPath, fsImpl);
  const match = aliasSource.match(
    new RegExp(`["']\\./(${targetPrefix}-[A-Za-z0-9_-]+\\.js)["']`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(`${aliasFile} does not point at a hashed ${targetPrefix} sibling`);
  }
  const targetFile = match[1];
  const targetPath = path.join(distDir, targetFile);
  if (!fsImpl.existsSync(targetPath)) {
    throw new Error(`${aliasFile} points at missing build artifact ${targetFile}`);
  }
  const stem = resolveHashedStem(targetFile);
  if (!stem) {
    throw new Error(`${aliasFile} target is not a hashed runtime artifact: ${targetFile}`);
  }
  return { targetFile, stem };
}

function listRuntimeSiblingFiles(distDir, stem, targetFile, fsImpl = fs) {
  return fsImpl
    .readdirSync(distDir)
    .filter((fileName) => fileName.endsWith(".js"))
    .filter((fileName) => resolveHashedStem(fileName) === stem)
    .filter((fileName) => fileName !== targetFile)
    .toSorted();
}

export function collectRuntimeEntrypointManifest(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const distDir = path.join(rootDir, "dist");
  const aliases = {};

  for (const spec of RUNTIME_ENTRYPOINT_ALIAS_SPECS) {
    const { targetFile, stem } = resolveAliasedTarget(
      distDir,
      spec.aliasFile,
      spec.targetPrefix,
      fsImpl,
    );
    aliases[spec.aliasFile] = {
      targetFile,
      familyStem: stem,
      staleSiblings: listRuntimeSiblingFiles(distDir, stem, targetFile, fsImpl),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    aliases,
  };
}

export function pruneStaleRuntimeEntrypointArtifacts(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const manifest = params.manifest ?? collectRuntimeEntrypointManifest({ rootDir, fs: fsImpl });
  const distDir = path.join(rootDir, "dist");
  const pruned = [];

  for (const [aliasFile, entry] of Object.entries(manifest.aliases ?? {})) {
    const staleFiles = Array.isArray(entry?.staleSiblings) ? entry.staleSiblings : [];
    const removed = [];
    for (const staleFile of staleFiles) {
      const stalePath = path.join(distDir, staleFile);
      if (!fsImpl.existsSync(stalePath)) {
        continue;
      }
      fsImpl.rmSync(stalePath, { force: true });
      removed.push(staleFile);
    }
    pruned.push({ aliasFile, removed });
  }

  return pruned;
}

export function writeRuntimeEntrypointManifest(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const distDir = path.join(rootDir, "dist");
  const manifestPath = path.join(distDir, "runtime-entrypoints.json");
  const initialManifest = collectRuntimeEntrypointManifest({ rootDir, fs: fsImpl });
  const pruned = pruneStaleRuntimeEntrypointArtifacts({
    rootDir,
    fs: fsImpl,
    manifest: initialManifest,
  });
  const finalManifest = collectRuntimeEntrypointManifest({ rootDir, fs: fsImpl });
  const enrichedManifest = {
    ...finalManifest,
    pruned,
  };
  writeJsonFile(manifestPath, enrichedManifest, fsImpl);
  return { manifestPath, manifest: enrichedManifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { manifestPath } = writeRuntimeEntrypointManifest();
  process.stdout.write(`[runtime-entrypoint-manifest] wrote ${manifestPath}\n`);
}
