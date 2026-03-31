export const DELEGATABLE_ROUTING_CLASSES = [
  "research",
  "coding",
  "browser",
  "timed-work",
  "multi-step",
  "external-action",
  "content-creation",
  "instagram-cycle",
  "self-improvement",
] as const;

export type DelegatableRoutingClass = (typeof DELEGATABLE_ROUTING_CLASSES)[number];

export function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function compactText(value: string | null | undefined, maxChars = 320): string | undefined {
  const trimmed = normalizeOptionalText(
    typeof value === "string" ? value.replace(/\s+/g, " ") : (value ?? undefined),
  );
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function isDelegatableRoutingClass(value: string): value is DelegatableRoutingClass {
  return (DELEGATABLE_ROUTING_CLASSES as readonly string[]).includes(value);
}

export function buildWorkerTask(params: {
  task: string;
  missionId: string;
  routingClass: string;
  sessionKey: string;
  surface: string;
  toolNeeds?: string[];
}): string {
  const toolNeeds = Array.isArray(params.toolNeeds)
    ? params.toolNeeds.map((item) => item.trim()).filter(Boolean)
    : [];
  const guidanceLines =
    params.routingClass === "self-improvement"
      ? [
          "Execution rules:",
          "- This is benchmarked mutation work. Use the clawbot-autoresearch lane, not manual one-off rewrites.",
          "- Run exactly: `python3 skills/clawbot-autoresearch/scripts/run_continuous_learning.py --json`",
          "- Do not hand-stitch init_run.py / run_batch.py / close_run.py unless the wrapper is broken.",
          "- Report benchmark deltas, kept/discarded outcome, and any no-candidate result truthfully.",
        ]
      : [
          "Execution rules:",
          "- Use the smallest sufficient tool plan; batch related reads, searches, and edits instead of one-by-one loops.",
          "- Treat broad checklists as goals, not a requirement to inspect every item exhaustively unless full coverage is required for correctness.",
          "- Do not narrate every next step between tools; gather evidence first and write the final output once unless an intermediate artifact is genuinely required.",
        ];
  const toolClause =
    toolNeeds.length > 0
      ? ` Preferred tools or skills: ${Array.from(new Set(toolNeeds)).toSorted().join(", ")}.`
      : "";
  return (
    `Mission ${params.missionId}. Routing class: ${params.routingClass}. Surface: ${params.surface}. ` +
    `Parent session: ${params.sessionKey}. Carry out the user's request in this dedicated ` +
    `worker session and report back with concrete results.${toolClause}\n\n` +
    `${guidanceLines.join("\n")}\n\n` +
    `User request:\n${params.task.trim()}`
  );
}

export function buildCompactReceipt(
  missionId: string,
  workerId: string,
  routingClass: string,
): string {
  return `Delegated ${routingClass} -> worker ${workerId.slice(0, 20)} mission ${missionId.slice(0, 20)}`.slice(
    0,
    200,
  );
}

export function buildCompactCompletion(
  missionId: string,
  state: string,
  summary: string | null | undefined,
): string {
  const compactSummary = compactText(summary, 240);
  const text = compactSummary
    ? `Mission ${missionId.slice(0, 20)} ${state}: ${compactSummary}`
    : `Mission ${missionId.slice(0, 20)} ${state}`;
  return text.slice(0, 280);
}
