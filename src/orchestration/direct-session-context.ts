import type { WorkspaceBootstrapFile } from "../agents/workspace.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import {
  type SessionEntry,
  type SessionMissionEvent,
  updateSessionStoreEntry,
} from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { getRecentSessionContentWithResetFallback } from "../hooks/bundled/session-memory/transcript.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readPendingMissionNotificationRecords } from "../tasks/task-registry-mission-runtime.js";

const log = createSubsystemLogger("orchestration/direct-session-context");

const DIRECT_SESSION_CONTEXT_PATH = "runtime://direct-session-context/BOOTSTRAP.md";
const DIRECT_SESSION_RECENT_MESSAGE_COUNT = 12;
const DIRECT_SESSION_RECENT_CONTEXT_MAX_CHARS = 4_000;
const DIRECT_SESSION_ACTIVE_MISSIONS_MAX = 4;
const DIRECT_SESSION_MISSION_RESULTS_MAX = 5;

export type DirectSessionBootstrapContext = {
  bootstrapFile?: WorkspaceBootstrapFile;
  consumedPendingMissionIds: string[];
};

function compactText(value: string | null | undefined, maxChars = 320): string | undefined {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function parseMissionEventDeliveredAt(value: number | string | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function isDirectSessionScope(sessionKey: string | undefined): boolean {
  const raw = sessionKey?.trim();
  if (!raw) {
    return false;
  }
  const rest = (parseAgentSessionKey(raw)?.rest ?? raw).trim().toLowerCase();
  if (!rest) {
    return false;
  }
  return (
    rest === "main" ||
    rest.startsWith("direct:") ||
    rest.startsWith("dm:") ||
    rest.includes(":direct:") ||
    rest.includes(":dm:")
  );
}

function formatMissionResult(record: {
  missionId?: string | null;
  state?: string | null;
  summary?: string | null;
  artifactPath?: string | null;
}): string | null {
  const missionId = compactText(record.missionId, 24);
  const state = compactText(record.state, 24) ?? "unknown";
  const summary = compactText(record.summary, 120);
  const artifactPath = compactText(record.artifactPath, 100);
  const line = compactText(
    `${missionId || "mission"} ${state}${summary ? ` — ${summary}` : ""}${artifactPath ? ` | artifact: ${artifactPath}` : ""}`,
    180,
  );
  return line ?? null;
}

function readUnreadMissionEvents(entry: SessionEntry | undefined): SessionMissionEvent[] {
  const events = Array.isArray(entry?.recentMissionEvents)
    ? entry.recentMissionEvents.filter((record): record is SessionMissionEvent => Boolean(record))
    : [];
  if (events.length === 0) {
    return [];
  }
  const lastSeen = parseMissionEventDeliveredAt(entry?.lastSeenMissionEventAt);
  return events
    .filter((record) => parseMissionEventDeliveredAt(record.deliveredAt) > lastSeen)
    .toSorted(
      (left, right) =>
        parseMissionEventDeliveredAt(right.deliveredAt) -
        parseMissionEventDeliveredAt(left.deliveredAt),
    );
}

function resolveActiveMissionIds(entry: SessionEntry | undefined): string[] {
  const fromEntry = typeof entry?.activeMissionId === "string" ? [entry.activeMissionId] : [];
  const fromCapsule = Array.isArray(entry?.continuityCapsule?.activeMissionIds)
    ? entry.continuityCapsule.activeMissionIds
    : [];
  return [...new Set([...fromEntry, ...fromCapsule].map((value) => value?.trim()).filter(Boolean))];
}

async function markMissionEventsSeen(sessionKey: string, deliveredAt: number): Promise<void> {
  if (!sessionKey.trim() || !Number.isFinite(deliveredAt) || deliveredAt <= 0) {
    return;
  }
  const loaded = loadSessionEntry(sessionKey);
  await updateSessionStoreEntry({
    storePath: loaded.storePath,
    sessionKey: loaded.canonicalKey,
    update: async (existing) => {
      const current = parseMissionEventDeliveredAt(existing?.lastSeenMissionEventAt);
      if (current >= deliveredAt) {
        return null;
      }
      return {
        lastSeenMissionEventAt: deliveredAt,
        updatedAt: Date.now(),
      };
    },
  });
}

function buildMissionLines(entry: SessionEntry | undefined): {
  lines: string[];
  consumedMissionEventAt: number;
  consumedPendingMissionIds: string[];
} {
  const lines: string[] = [];
  const pendingIds = new Set(
    readPendingMissionNotificationRecords(entry)
      .map((record) => record.missionId?.trim())
      .filter(Boolean),
  );

  const activeMissionIds = resolveActiveMissionIds(entry);
  if (activeMissionIds.length > 0) {
    const visible = activeMissionIds.slice(0, DIRECT_SESSION_ACTIVE_MISSIONS_MAX).join(", ");
    lines.push(
      `- Active missions: ${visible}${activeMissionIds.length > DIRECT_SESSION_ACTIVE_MISSIONS_MAX ? `, +${activeMissionIds.length - DIRECT_SESSION_ACTIVE_MISSIONS_MAX} more` : ""}`,
    );
  }

  const unreadEvents = readUnreadMissionEvents(entry);
  if (unreadEvents.length > 0) {
    const unreadSummary = unreadEvents
      .slice(0, DIRECT_SESSION_MISSION_RESULTS_MAX)
      .map(formatMissionResult)
      .filter(Boolean)
      .join("; ");
    lines.push(
      `- New mission results: ${unreadSummary}${unreadEvents.length > DIRECT_SESSION_MISSION_RESULTS_MAX ? `; +${unreadEvents.length - DIRECT_SESSION_MISSION_RESULTS_MAX} more` : ""}`,
    );
    return {
      lines,
      consumedMissionEventAt: Math.max(
        ...unreadEvents.map((record) => parseMissionEventDeliveredAt(record.deliveredAt)),
      ),
      consumedPendingMissionIds: Array.from(
        new Set(
          unreadEvents
            .map((record) => record.missionId?.trim())
            .filter((missionId): missionId is string =>
              Boolean(missionId && pendingIds.has(missionId)),
            ),
        ),
      ),
    };
  }

  const delivered = entry?.lastDeliveredMission;
  const deliveredMissionId = delivered?.missionId?.trim();
  const deliveredSummary = formatMissionResult(delivered ?? {});
  if (deliveredSummary) {
    lines.push(`- Last delivered worker result: ${deliveredSummary}`);
  }

  return {
    lines,
    consumedMissionEventAt: 0,
    consumedPendingMissionIds:
      deliveredMissionId && pendingIds.has(deliveredMissionId) ? [deliveredMissionId] : [],
  };
}

export async function resolveDirectSessionBootstrapContext(params: {
  sessionKey?: string;
  sessionFile?: string;
}): Promise<DirectSessionBootstrapContext> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey || !isDirectSessionScope(sessionKey)) {
    return { consumedPendingMissionIds: [] };
  }

  const loaded = loadSessionEntry(sessionKey);
  const entry = loaded.entry;
  const lines = [
    "# Runtime Direct Context",
    "- Direct sessions stay conversational. Delegate tracked execution with `openclaw orchestrator`.",
    "- Workspace files and runtime session state are canonical. Prefer them over guessed continuity.",
  ];

  const continuity = compactText(
    entry?.continuitySummary ?? entry?.continuityCapsule?.summary,
    320,
  );
  if (continuity) {
    lines.push(`- Continuity: ${continuity}`);
  }

  const missionContext = buildMissionLines(entry);
  lines.push(...missionContext.lines);

  if (missionContext.consumedMissionEventAt > 0) {
    try {
      await markMissionEventsSeen(loaded.canonicalKey, missionContext.consumedMissionEventAt);
    } catch (error) {
      log.warn("failed to mark mission events seen for direct-session context", {
        sessionKey: loaded.canonicalKey,
        error,
      });
    }
  }

  const transcriptPath =
    (typeof params.sessionFile === "string" && params.sessionFile.trim()) ||
    entry?.sessionFile?.trim() ||
    "";
  const recentConversation = transcriptPath
    ? await getRecentSessionContentWithResetFallback(
        transcriptPath,
        DIRECT_SESSION_RECENT_MESSAGE_COUNT,
      )
    : null;
  if (recentConversation) {
    lines.push(
      "",
      "## Recent Conversation",
      clampText(recentConversation.trim(), DIRECT_SESSION_RECENT_CONTEXT_MAX_CHARS),
    );
  }

  if (!continuity && missionContext.lines.length === 0 && !recentConversation) {
    return {
      consumedPendingMissionIds: missionContext.consumedPendingMissionIds,
    };
  }

  return {
    bootstrapFile: {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      path: DIRECT_SESSION_CONTEXT_PATH,
      content: `${lines.join("\n")}\n`,
      missing: false,
    },
    consumedPendingMissionIds: missionContext.consumedPendingMissionIds,
  };
}
