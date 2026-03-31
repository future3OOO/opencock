import { compactText } from "./format.js";
import type { OrchestrationMissionStatus } from "./runtime-primitives.js";

function compactMissionOverviewPart(mission: OrchestrationMissionStatus): string {
  const missionId = mission.missionId.slice(0, 20);
  const routingClass = mission.routingClass ?? "worker";
  const state = mission.state || "unknown";
  const statusSummary = compactText(mission.statusSummary, 120) ?? "";
  let text = `${missionId} [${routingClass}] ${state}`;
  if (statusSummary) {
    text += ` - ${statusSummary}`;
  }
  return text.slice(0, 180);
}

export function buildSessionMissionOverview(
  missions: OrchestrationMissionStatus[],
): string | undefined {
  if (missions.length === 0) {
    return undefined;
  }
  const active = missions.filter((mission) => mission.state === "running");
  const recent = missions.filter((mission) => mission.state !== "running");
  const parts: string[] = [];
  if (active.length > 0) {
    const activeParts = active
      .slice(0, 4)
      .map((mission) => compactMissionOverviewPart(mission))
      .join("; ");
    parts.push(
      `Active missions (${active.length}): ${activeParts}${active.length > 4 ? `; +${active.length - 4} more` : ""}`,
    );
  }
  if (recent.length > 0) {
    const recentParts = recent
      .slice(0, 3)
      .map((mission) => compactMissionOverviewPart(mission))
      .join("; ");
    parts.push(`Recent results: ${recentParts}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return compactText(parts.join(" "), 320);
}
