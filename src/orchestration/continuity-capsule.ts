import type { SessionContinuityCapsule } from "../config/sessions/types.js";

function normalizeMissionIds(values: Array<string | null | undefined> | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

export function buildMissionContinuityCapsule(params: {
  updatedAt: number;
  summary?: string | null;
  activeMissionIds?: Array<string | null | undefined>;
  recentMissionIds?: Array<string | null | undefined>;
}): SessionContinuityCapsule | null {
  const summary = params.summary?.trim() || null;
  const activeMissionIds = normalizeMissionIds(params.activeMissionIds);
  const recentMissionIds = normalizeMissionIds(params.recentMissionIds);
  if (!summary && activeMissionIds.length === 0 && recentMissionIds.length === 0) {
    return null;
  }
  return {
    updatedAt: params.updatedAt,
    ...(summary ? { summary } : {}),
    ...(activeMissionIds.length > 0 ? { activeMissionIds } : {}),
    ...(recentMissionIds.length > 0 ? { recentMissionIds } : {}),
  };
}
