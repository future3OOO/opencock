import fs from "node:fs";
import { type SessionEntry, updateSessionStoreEntry } from "../config/sessions.js";
import { normalizeOptionalText } from "./format.js";
import type { OrchestrationRuntimeConfig } from "./runtime-config.defaults.js";
import type { OrchestrationFreshnessReason } from "./runtime-config.types.js";

export type OrchestratorContinuityFreshness = {
  needsRotation: boolean;
  reasons: OrchestrationFreshnessReason[];
  transcriptBytes: number;
};

function resolveSessionTranscriptBytes(entry: SessionEntry | undefined): number {
  const sessionFile = normalizeOptionalText(entry?.sessionFile);
  if (!sessionFile) {
    return 0;
  }
  try {
    return Math.max(0, fs.statSync(sessionFile).size);
  } catch {
    return 0;
  }
}

export function evaluateOrchestratorContinuityFreshness(params: {
  entry: SessionEntry | undefined;
  config: OrchestrationRuntimeConfig;
}): OrchestratorContinuityFreshness {
  const entry = params.entry;
  const transcriptBytes = resolveSessionTranscriptBytes(entry);
  const reasons: OrchestrationFreshnessReason[] = [];
  if (transcriptBytes > params.config.directSessionContinuity.maxTranscriptBytes) {
    reasons.push("transcript_bytes");
  }
  if ((entry?.compactionCount ?? 0) > params.config.directSessionContinuity.maxCompactions) {
    reasons.push("compactions");
  }
  if ((entry?.workerNoticeCount ?? 0) > params.config.directSessionContinuity.maxWorkerNotices) {
    reasons.push("worker_notices");
  }
  return {
    needsRotation: reasons.length > 0,
    reasons,
    transcriptBytes,
  };
}

export async function resetOrchestratorContinuityState(params: {
  storePath: string;
  sessionKey: string;
  reasons: OrchestrationFreshnessReason[];
}) {
  const resetAt = Date.now();
  return await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    update: async () => ({
      workerNoticeCount: 0,
      continuitySummary: null,
      continuityCapsule: null,
      continuityUpdatedAt: resetAt,
      freshnessResetAt: resetAt,
      freshnessResetReasons: [...params.reasons],
    }),
  });
}
