import {
  mergeSessionEntry,
  resolveSessionStoreEntry,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { loadSessionEntry } from "../gateway/session-utils.js";

export type SessionMissionBinding = {
  activeMissionId: string | null;
  focusedWorkerId: string | null;
};

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function readSessionMissionBinding(entry?: SessionEntry | null): SessionMissionBinding {
  return {
    activeMissionId: normalizeOptionalText(entry?.activeMissionId),
    focusedWorkerId: normalizeOptionalText(entry?.focusedWorkerId),
  };
}

export async function setSessionMissionBinding(params: {
  sessionKey: string;
  missionId?: string | null;
  workerId?: string | null;
  continuitySummary?: string | null;
}): Promise<string> {
  const loaded = loadSessionEntry(params.sessionKey);
  const sessionKey = loaded.canonicalKey;
  const missionId = normalizeOptionalText(params.missionId);
  const workerId = normalizeOptionalText(params.workerId);
  const continuitySummary = normalizeOptionalText(params.continuitySummary);
  await updateSessionStore(loaded.storePath, async (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    const current = readSessionMissionBinding(existing);
    if (
      current.activeMissionId === missionId &&
      current.focusedWorkerId === workerId &&
      continuitySummary == null
    ) {
      return existing ?? null;
    }
    store[resolved.normalizedKey] = mergeSessionEntry(existing, {
      activeMissionId: missionId,
      focusedWorkerId: workerId,
      ...(continuitySummary != null
        ? {
            continuitySummary,
            continuityUpdatedAt: Date.now(),
          }
        : {}),
      updatedAt: Date.now(),
    });
    for (const legacyKey of resolved.legacyKeys) {
      if (legacyKey !== resolved.normalizedKey) {
        delete store[legacyKey];
      }
    }
    return store[resolved.normalizedKey] ?? null;
  });
  return sessionKey;
}

export async function clearSessionMissionBindingIfMatches(params: {
  sessionKey: string;
  missionId?: string | null;
  workerId?: string | null;
}): Promise<boolean> {
  const loaded = loadSessionEntry(params.sessionKey);
  const sessionKey = loaded.canonicalKey;
  const targetMissionId = normalizeOptionalText(params.missionId);
  const targetWorkerId = normalizeOptionalText(params.workerId);
  let cleared = false;
  await updateSessionStore(loaded.storePath, async (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const existing = resolved.existing;
    const current = readSessionMissionBinding(existing);
    const matchesMission = targetMissionId != null && current.activeMissionId === targetMissionId;
    const matchesWorker = targetWorkerId != null && current.focusedWorkerId === targetWorkerId;
    if (!matchesMission && !matchesWorker) {
      return existing ?? null;
    }
    cleared = true;
    store[resolved.normalizedKey] = mergeSessionEntry(existing, {
      activeMissionId: null,
      focusedWorkerId: null,
      updatedAt: Date.now(),
    });
    for (const legacyKey of resolved.legacyKeys) {
      if (legacyKey !== resolved.normalizedKey) {
        delete store[legacyKey];
      }
    }
    return store[resolved.normalizedKey] ?? null;
  });
  return cleared;
}
