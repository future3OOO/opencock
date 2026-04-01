import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_STABLE_RUNTIME_ENTRYPOINTS = [
  "gateway-cli.js",
  "health.js",
  "run-main.js",
  "reply.runtime.js",
  "compact.runtime.js",
];

function requireFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing stable runtime entrypoint: ${path.basename(filePath)}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function requireRegex(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message);
  }
}

function requireAliasedSibling(distDir, aliasFile, targetPrefix) {
  const aliasPath = path.join(distDir, aliasFile);
  const aliasSource = requireFile(aliasPath);
  const match = aliasSource.match(
    new RegExp(`["']\\./(${targetPrefix}-[A-Za-z0-9_-]+\\.js)["']`, "u"),
  );
  if (!match?.[1]) {
    throw new Error(`${aliasFile} does not point at a hashed ${targetPrefix} sibling`);
  }
  const targetPath = path.join(distDir, match[1]);
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${aliasFile} points at missing build artifact ${match[1]}`);
  }
  return match[1];
}

export function assertStableRuntimeEntrypoints(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`dist directory not found: ${distDir}`);
  }

  for (const fileName of REQUIRED_STABLE_RUNTIME_ENTRYPOINTS) {
    requireFile(path.join(distDir, fileName));
  }

  const entrySource = requireFile(path.join(distDir, "entry.js"));
  requireRegex(
    entrySource,
    /import\("\.\/run-main\.js"\)/u,
    'entry.js must import "./run-main.js" via the stable entrypoint',
  );

  const registerSubclis = fs
    .readdirSync(distDir)
    .filter((fileName) => /^register\.subclis(?:-[A-Za-z0-9_-]+)?\.js$/u.test(fileName));
  if (registerSubclis.length === 0) {
    throw new Error("dist is missing register.subclis output");
  }
  let gatewayCliReferenced = false;
  for (const fileName of registerSubclis) {
    const source = requireFile(path.join(distDir, fileName));
    if (source.includes('import("./gateway-cli.js")')) {
      gatewayCliReferenced = true;
      break;
    }
  }
  if (!gatewayCliReferenced) {
    throw new Error(
      'register.subclis output must import "./gateway-cli.js" via the stable entrypoint',
    );
  }

  const runMainSource = requireFile(path.join(distDir, "run-main.js"));
  requireRegex(
    runMainSource,
    /import\("\.\/health\.js"\)/u,
    'run-main.js must import "./health.js" via the stable entrypoint',
  );

  const healthTarget = requireAliasedSibling(distDir, "health.js", "health");
  const replyRuntimeTarget = requireAliasedSibling(distDir, "reply.runtime.js", "reply\\.runtime");
  const compactRuntimeTarget = requireAliasedSibling(
    distDir,
    "compact.runtime.js",
    "compact\\.runtime",
  );

  return {
    distDir,
    healthTarget,
    replyRuntimeTarget,
    compactRuntimeTarget,
    registerSubclis,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = assertStableRuntimeEntrypoints();
  process.stdout.write(
    `[stable-runtime-entrypoints] ok (${path.basename(result.healthTarget)}, ${path.basename(result.replyRuntimeTarget)}, ${path.basename(result.compactRuntimeTarget)})\n`,
  );
}
