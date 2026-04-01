import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  applyInputProvenanceToUserMessage,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { parseSessionThreadInfo } from "./delivery-info.js";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import { loadSessionStore, normalizeStoreSessionKey } from "./store.js";
import type { SessionEntry } from "./types.js";

function stripQuery(value: string): string {
  const noHash = value.split("#")[0] ?? value;
  return noHash.split("?")[0] ?? noHash;
}

function extractFileNameFromMediaUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripQuery(trimmed);
  try {
    const parsed = new URL(cleaned);
    const base = path.basename(parsed.pathname);
    if (!base) {
      return null;
    }
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    const base = path.basename(cleaned);
    if (!base || base === "/" || base === ".") {
      return null;
    }
    return base;
  }
}

export function resolveMirroredTranscriptText(params: {
  text?: string;
  mediaUrls?: string[];
}): string | null {
  const text = params.text ?? "";
  const trimmed = text.trim();
  if (trimmed) {
    return trimmed;
  }

  const mediaUrls = params.mediaUrls?.filter((url) => url && url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    const names = mediaUrls
      .map((url) => extractFileNameFromMediaUrl(url))
      .filter((name): name is string => Boolean(name && name.trim()));
    if (names.length > 0) {
      return names.join(", ");
    }
    return "media";
  }
  return null;
}

async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
}): Promise<void> {
  if (fs.existsSync(params.sessionFile)) {
    return;
  }
  await fs.promises.mkdir(path.dirname(params.sessionFile), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.promises.writeFile(params.sessionFile, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const threadIdFromSessionKey = parseSessionThreadInfo(params.sessionKey).threadId;
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(
          params.sessionId,
          params.agentId,
          params.threadId ?? threadIdFromSessionKey,
        )
      : undefined;
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
      fallbackSessionFile,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}

export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  idempotencyKey?: string;
  /** Optional override for store path (mostly for tests). */
  storePath?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
}): Promise<{ ok: true; sessionFile: string; messageId: string } | { ok: false; reason: string }> {
  const mirrorText = resolveMirroredTranscriptText({
    text: params.text,
    mediaUrls: params.mediaUrls,
  });
  if (!mirrorText) {
    return { ok: false, reason: "empty text" };
  }

  return await appendMessageToSessionTranscript({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    sessionId: params.sessionId,
    sessionEntry: params.sessionEntry,
    sessionFile: params.sessionFile,
    message: {
      role: "assistant" as const,
      content: [{ type: "text", text: mirrorText }],
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    },
  });
}

export function buildInboundTranscriptText(ctx: MsgContext): string | null {
  const rawText =
    ctx.BodyForCommands ??
    ctx.CommandBody ??
    ctx.RawBody ??
    (typeof ctx.Body === "string" ? ctx.Body : undefined) ??
    "";
  const mirrorText = resolveMirroredTranscriptText({
    text: rawText,
    mediaUrls: ctx.MediaPaths ?? ctx.MediaUrls,
  });
  if (!mirrorText) {
    return null;
  }

  const convInfo: Record<string, string> = {};
  const messageId =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast ?? undefined;
  if (messageId?.trim()) {
    convInfo.message_id = messageId.trim();
  }
  if (ctx.SenderId?.trim()) {
    convInfo.sender_id = ctx.SenderId.trim();
  }
  if (ctx.SenderName?.trim()) {
    convInfo.sender = ctx.SenderName.trim();
  }
  if (typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp)) {
    convInfo.timestamp = new Date(ctx.Timestamp).toISOString();
  }
  const surface = ctx.Surface?.trim() || ctx.Provider?.trim();
  if (surface) {
    convInfo.surface = surface;
  }

  const senderInfo: Record<string, string> = {};
  if (ctx.SenderName?.trim()) {
    senderInfo.label = ctx.SenderE164?.trim()
      ? `${ctx.SenderName.trim()} (${ctx.SenderE164.trim()})`
      : ctx.SenderName.trim();
    senderInfo.name = ctx.SenderName.trim();
  }
  if (ctx.SenderId?.trim()) {
    senderInfo.id = ctx.SenderId.trim();
  }
  if (ctx.SenderE164?.trim()) {
    senderInfo.e164 = ctx.SenderE164.trim();
  }

  const parts: string[] = [];
  if (Object.keys(convInfo).length > 0) {
    parts.push(
      `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify(convInfo, null, 2)}\n\`\`\``,
    );
  }
  if (Object.keys(senderInfo).length > 0) {
    parts.push(
      `Sender (untrusted metadata):\n\`\`\`json\n${JSON.stringify(senderInfo, null, 2)}\n\`\`\``,
    );
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n\n${mirrorText}` : mirrorText;
}

export function resolveInboundTranscriptIdempotencyKey(params: {
  sessionKey: string;
  ctx?: MsgContext;
  explicitIdempotencyKey?: string;
}): string | undefined {
  const explicit = params.explicitIdempotencyKey?.trim();
  if (explicit) {
    return explicit;
  }
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey || !params.ctx) {
    return undefined;
  }
  const messageId =
    params.ctx.MessageSidFull ??
    params.ctx.MessageSid ??
    params.ctx.MessageSidFirst ??
    params.ctx.MessageSidLast;
  const trimmed = messageId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return `inbound:${sessionKey}:${trimmed}`;
}

export async function appendUserMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  ctx?: MsgContext;
  text?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
  inputProvenance?: unknown;
  idempotencyKey?: string;
  storePath?: string;
  timestamp?: number;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
}): Promise<{ ok: true; sessionFile: string; messageId: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const text = params.ctx
    ? buildInboundTranscriptText({
        ...params.ctx,
        ...(typeof params.text === "string" ? { BodyForCommands: params.text } : {}),
        ...(params.mediaPaths ? { MediaPaths: params.mediaPaths } : {}),
        ...(params.mediaTypes ? { MediaTypes: params.mediaTypes } : {}),
      })
    : resolveMirroredTranscriptText({
        text: params.text,
        mediaUrls: params.mediaPaths,
      });
  if (!text) {
    return { ok: false, reason: "empty text" };
  }

  const mediaPaths = params.mediaPaths ?? params.ctx?.MediaPaths;
  const mediaTypes = params.mediaTypes ?? params.ctx?.MediaTypes;
  const mediaFields = resolveTranscriptMediaFields({
    mediaPaths,
    mediaTypes,
  });
  const message = applyInputProvenanceToUserMessage(
    {
      role: "user" as const,
      content: text,
      timestamp: params.timestamp ?? params.ctx?.Timestamp ?? Date.now(),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...mediaFields,
    } as Parameters<SessionManager["appendMessage"]>[0],
    normalizeInputProvenance(params.inputProvenance ?? params.ctx?.InputProvenance),
  ) as Parameters<SessionManager["appendMessage"]>[0];

  return await appendUserMessageEntryToSessionTranscript({
    agentId: params.agentId,
    sessionKey,
    storePath: params.storePath,
    idempotencyKey: params.idempotencyKey,
    sessionId: params.sessionId,
    sessionEntry: params.sessionEntry,
    sessionFile: params.sessionFile,
    message,
  });
}

function resolveTranscriptMediaFields(params: {
  mediaPaths?: string[];
  mediaTypes?: string[];
}): Record<string, unknown> {
  const mediaPaths = params.mediaPaths?.filter((value) => value && value.trim()) ?? [];
  if (mediaPaths.length === 0) {
    return {};
  }
  const mediaTypes = params.mediaTypes?.filter((value) => value && value.trim()) ?? [];
  return {
    MediaPath: mediaPaths[0],
    MediaPaths: mediaPaths,
    ...(mediaTypes.length > 0
      ? {
          MediaType: mediaTypes[0],
          MediaTypes: mediaTypes,
        }
      : {}),
  };
}

async function appendMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  idempotencyKey?: string;
  storePath?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  message: Parameters<SessionManager["appendMessage"]>[0];
}): Promise<{ ok: true; sessionFile: string; messageId: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const sessionTarget = await resolveTranscriptSessionTarget({
    agentId: params.agentId,
    sessionKey,
    storePath,
    sessionId: params.sessionId,
    sessionEntry: params.sessionEntry,
    sessionFile: params.sessionFile,
  });
  if (!sessionTarget.ok) {
    return sessionTarget;
  }

  const { sessionFile, sessionId } = sessionTarget;

  await ensureSessionHeader({ sessionFile, sessionId });

  const existingMessageId = params.idempotencyKey
    ? await transcriptHasIdempotencyKey(sessionFile, params.idempotencyKey)
    : undefined;
  if (existingMessageId) {
    return { ok: true, sessionFile, messageId: existingMessageId };
  }

  const sessionManager = SessionManager.open(sessionFile);
  const messageId = sessionManager.appendMessage(params.message);

  emitSessionTranscriptUpdate({ sessionFile, sessionKey, message: params.message, messageId });
  return { ok: true, sessionFile, messageId };
}

async function appendUserMessageEntryToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  idempotencyKey?: string;
  storePath?: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  message: Parameters<SessionManager["appendMessage"]>[0];
}): Promise<{ ok: true; sessionFile: string; messageId: string } | { ok: false; reason: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return { ok: false, reason: "missing sessionKey" };
  }

  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const sessionTarget = await resolveTranscriptSessionTarget({
    agentId: params.agentId,
    sessionKey,
    storePath,
    sessionId: params.sessionId,
    sessionEntry: params.sessionEntry,
    sessionFile: params.sessionFile,
  });
  if (!sessionTarget.ok) {
    return sessionTarget;
  }

  const { sessionFile, sessionId } = sessionTarget;

  await ensureSessionHeader({ sessionFile, sessionId });

  const existingMessageId = params.idempotencyKey
    ? await transcriptHasIdempotencyKey(sessionFile, params.idempotencyKey)
    : undefined;
  if (existingMessageId) {
    return { ok: true, sessionFile, messageId: existingMessageId };
  }

  const existingEntries = await readTranscriptEntries(sessionFile);
  const messageId = generateTranscriptEntryId(existingEntries);
  const parentId = resolveTranscriptLeafId(existingEntries);
  const transcriptEntry = {
    type: "message" as const,
    id: messageId,
    parentId,
    timestamp: new Date().toISOString(),
    message: params.message,
  };
  await fs.promises.appendFile(sessionFile, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");

  emitSessionTranscriptUpdate({ sessionFile, sessionKey, message: params.message, messageId });
  return { ok: true, sessionFile, messageId };
}

async function resolveTranscriptSessionTarget(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
}): Promise<{ ok: true; sessionId: string; sessionFile: string } | { ok: false; reason: string }> {
  const explicitSessionId = params.sessionId?.trim();
  const explicitSessionFile = params.sessionFile?.trim();
  if (explicitSessionId) {
    const explicitEntry =
      params.sessionEntry && Object.keys(params.sessionEntry).length > 0
        ? params.sessionEntry
        : undefined;
    try {
      const resolved = await resolveSessionTranscriptFile({
        sessionId: explicitSessionId,
        sessionKey: params.sessionKey,
        sessionEntry:
          explicitSessionFile && !explicitEntry
            ? ({ sessionId: explicitSessionId, sessionFile: explicitSessionFile } as SessionEntry)
            : explicitEntry,
        storePath: params.storePath,
        agentId: params.agentId ?? "main",
      });
      return { ok: true, sessionId: explicitSessionId, sessionFile: resolved.sessionFile };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const store = loadSessionStore(params.storePath, { skipCache: true });
  const normalizedKey = normalizeStoreSessionKey(params.sessionKey);
  const entry = (store[normalizedKey] ?? store[params.sessionKey]) as SessionEntry | undefined;
  if (!entry?.sessionId) {
    return { ok: false, reason: `unknown sessionKey: ${params.sessionKey}` };
  }

  try {
    const resolved = await resolveAndPersistSessionFile({
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: store,
      storePath: params.storePath,
      sessionEntry: entry,
      agentId: params.agentId,
      sessionsDir: path.dirname(params.storePath),
    });
    return { ok: true, sessionId: entry.sessionId, sessionFile: resolved.sessionFile };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function readTranscriptEntries(sessionFile: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await fs.promises.readFile(sessionFile, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return parsed && typeof parsed === "object" ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function generateTranscriptEntryId(entries: Array<Record<string, unknown>>): string {
  const ids = new Set(
    entries
      .map((entry) => (typeof entry.id === "string" ? entry.id : undefined))
      .filter((value): value is string => Boolean(value)),
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
  return crypto.randomUUID();
}

function resolveTranscriptLeafId(entries: Array<Record<string, unknown>>): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry.id === "string" && entry.type !== "session") {
      return entry.id;
    }
  }
  return null;
}

async function transcriptHasIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<string | undefined> {
  try {
    const raw = await fs.promises.readFile(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          id?: unknown;
          message?: { idempotencyKey?: unknown };
        };
        if (
          parsed.message?.idempotencyKey === idempotencyKey &&
          typeof parsed.id === "string" &&
          parsed.id
        ) {
          return parsed.id;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
