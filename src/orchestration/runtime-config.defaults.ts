import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { normalizeOptionalText } from "./format.js";
import { normalizeOrchestrationChannel, type OrchestrationChannel } from "./runtime-primitives.js";

type PlainRecord = Record<string, unknown>;

export type OrchestrationRuntimeRoutingClass =
  | "direct-answer"
  | "browser"
  | "instagram-cycle"
  | "content-creation"
  | "coding"
  | "research"
  | "timed-work"
  | "multi-step"
  | "external-action"
  | "self-improvement";

export type OrchestrationPolicyConfig = {
  delegateThresholdSeconds: number;
  delegateIfMutating: boolean;
  delegateIfBrowser: boolean;
  delegateIfTimedWork: boolean;
  delegateIfMultiStep: boolean;
};

export type OrchestrationCleanupConfig = {
  staleTimers: Partial<Record<OrchestrationRuntimeRoutingClass, number | null>>;
  retentionWindowSeconds: number;
};

export type OrchestrationHeartbeatConfig = {
  intervalSeconds: number;
  staleMultiplier: number;
  perRoutingClass: Partial<Record<OrchestrationRuntimeRoutingClass, number>>;
};

export type OrchestrationRetryConfig = {
  perRoutingClass: Partial<
    Record<
      OrchestrationRuntimeRoutingClass,
      {
        maxRetries: number;
        retryDelaySeconds: number;
      }
    >
  >;
};

export type OrchestrationSpawnSuppressionConfig = {
  cooldownSeconds: number;
};

export type OrchestrationContinuityConfig = {
  maxContextFraction: number;
  maxCompactions: number;
  maxTranscriptBytes: number;
  maxWorkerNotices: number;
};

export type OrchestrationSelfImprovementConfig = {
  requireMutationTargets: boolean;
};

export type OrchestrationLimitsConfig = {
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
  maxConcurrent: number;
  runTimeoutSeconds: number;
};

export type OrchestrationRuntimeConfig = {
  enabled: boolean;
  enabledChannels: OrchestrationChannel[];
  directSessionsAreOrchestrators: boolean;
  policy: OrchestrationPolicyConfig;
  cleanup: OrchestrationCleanupConfig;
  heartbeat: OrchestrationHeartbeatConfig;
  retry: OrchestrationRetryConfig;
  spawnSuppression: OrchestrationSpawnSuppressionConfig;
  directSessionContinuity: OrchestrationContinuityConfig;
  selfImprovement: OrchestrationSelfImprovementConfig;
  limits: OrchestrationLimitsConfig;
};

const STALE_TIMER_DEFAULTS: Record<OrchestrationRuntimeRoutingClass, number | null> = {
  "direct-answer": null,
  browser: 600,
  "instagram-cycle": 1800,
  "content-creation": 1200,
  coding: 7200,
  research: 3600,
  "timed-work": null,
  "multi-step": 3600,
  "external-action": 600,
  "self-improvement": 7200,
};

const HEARTBEAT_INTERVAL_DEFAULTS: Record<OrchestrationRuntimeRoutingClass, number> = {
  "direct-answer": 60,
  browser: 90,
  "instagram-cycle": 120,
  "content-creation": 120,
  coding: 300,
  research: 240,
  "timed-work": 120,
  "multi-step": 120,
  "external-action": 60,
  "self-improvement": 300,
};

const RETRY_DEFAULTS: OrchestrationRetryConfig["perRoutingClass"] = {
  "direct-answer": { maxRetries: 0, retryDelaySeconds: 30 },
  browser: { maxRetries: 1, retryDelaySeconds: 30 },
  "instagram-cycle": { maxRetries: 2, retryDelaySeconds: 30 },
  "content-creation": { maxRetries: 1, retryDelaySeconds: 30 },
  coding: { maxRetries: 0, retryDelaySeconds: 30 },
  research: { maxRetries: 1, retryDelaySeconds: 30 },
  "timed-work": { maxRetries: 0, retryDelaySeconds: 30 },
  "multi-step": { maxRetries: 1, retryDelaySeconds: 30 },
  "external-action": { maxRetries: 1, retryDelaySeconds: 30 },
  "self-improvement": { maxRetries: 1, retryDelaySeconds: 30 },
};

const LEGACY_RUNTIME_CONFIG_RELATIVE_PATH = path.join(
  "skills",
  "clawbot-autoresearch",
  "runtime.json",
);

export const DEFAULT_ORCHESTRATION_RUNTIME_CONFIG: OrchestrationRuntimeConfig = {
  enabled: true,
  enabledChannels: ["cli", "telegram", "whatsapp"],
  directSessionsAreOrchestrators: true,
  policy: {
    delegateThresholdSeconds: 30,
    delegateIfMutating: true,
    delegateIfBrowser: true,
    delegateIfTimedWork: true,
    delegateIfMultiStep: true,
  },
  cleanup: {
    staleTimers: { ...STALE_TIMER_DEFAULTS },
    retentionWindowSeconds: 86_400,
  },
  heartbeat: {
    intervalSeconds: 60,
    staleMultiplier: 3,
    perRoutingClass: { ...HEARTBEAT_INTERVAL_DEFAULTS },
  },
  retry: {
    perRoutingClass: { ...RETRY_DEFAULTS },
  },
  spawnSuppression: {
    cooldownSeconds: 30,
  },
  directSessionContinuity: {
    maxContextFraction: 0.25,
    maxCompactions: 1,
    maxTranscriptBytes: 262_144,
    maxWorkerNotices: 20,
  },
  selfImprovement: {
    requireMutationTargets: true,
  },
  limits: {
    maxSpawnDepth: 2,
    maxChildrenPerAgent: 5,
    maxConcurrent: 8,
    runTimeoutSeconds: 7200,
  },
};

function isPlainRecord(value: unknown): value is PlainRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeRecords<T>(base: T, overlay: unknown): T {
  if (overlay == null) {
    return base;
  }
  if (!isPlainRecord(base) || !isPlainRecord(overlay)) {
    return overlay as T;
  }
  const next: PlainRecord = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = next[key];
    next[key] =
      isPlainRecord(existing) && isPlainRecord(value) ? mergeRecords(existing, value) : value;
  }
  return next as T;
}

function readLegacyCompatibilityOverlay(cfg: OpenClawConfig): PlainRecord | undefined {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const runtimeConfigPath = path.join(workspaceDir, LEGACY_RUNTIME_CONFIG_RELATIVE_PATH);
  try {
    const raw = fs.readFileSync(runtimeConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed.orchestration)) {
      return undefined;
    }
    return parsed.orchestration;
  } catch {
    return undefined;
  }
}

function readConfigOverlay(cfg: OpenClawConfig): PlainRecord | undefined {
  const candidate = (cfg as PlainRecord).orchestration;
  return isPlainRecord(candidate) ? candidate : undefined;
}

function normalizeEnabledChannels(value: unknown): OrchestrationChannel[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.enabledChannels];
  }
  const channels = new Set<OrchestrationChannel>();
  for (const candidate of value) {
    const normalized = normalizeOptionalText(
      typeof candidate === "string" ? candidate : undefined,
    )?.toLowerCase();
    if (
      normalized === "cli" ||
      normalized === "telegram" ||
      normalized === "whatsapp" ||
      normalized === "unknown"
    ) {
      channels.add(normalized);
    }
  }
  return channels.size > 0
    ? [...channels]
    : [...DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.enabledChannels];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeRuntimeConfig(value: OrchestrationRuntimeConfig): OrchestrationRuntimeConfig {
  return {
    ...value,
    enabled: normalizeBoolean(value.enabled, DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.enabled),
    enabledChannels: normalizeEnabledChannels(value.enabledChannels),
    directSessionsAreOrchestrators: normalizeBoolean(
      value.directSessionsAreOrchestrators,
      DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.directSessionsAreOrchestrators,
    ),
    policy: {
      delegateThresholdSeconds: normalizePositiveInteger(
        value.policy?.delegateThresholdSeconds,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.policy.delegateThresholdSeconds,
      ),
      delegateIfMutating: normalizeBoolean(
        value.policy?.delegateIfMutating,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.policy.delegateIfMutating,
      ),
      delegateIfBrowser: normalizeBoolean(
        value.policy?.delegateIfBrowser,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.policy.delegateIfBrowser,
      ),
      delegateIfTimedWork: normalizeBoolean(
        value.policy?.delegateIfTimedWork,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.policy.delegateIfTimedWork,
      ),
      delegateIfMultiStep: normalizeBoolean(
        value.policy?.delegateIfMultiStep,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.policy.delegateIfMultiStep,
      ),
    },
    cleanup: {
      staleTimers: isPlainRecord(value.cleanup?.staleTimers)
        ? value.cleanup.staleTimers
        : { ...DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.cleanup.staleTimers },
      retentionWindowSeconds: normalizePositiveInteger(
        value.cleanup?.retentionWindowSeconds,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.cleanup.retentionWindowSeconds,
      ),
    },
    heartbeat: {
      intervalSeconds: normalizePositiveInteger(
        value.heartbeat?.intervalSeconds,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.heartbeat.intervalSeconds,
      ),
      staleMultiplier: normalizePositiveInteger(
        value.heartbeat?.staleMultiplier,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.heartbeat.staleMultiplier,
      ),
      perRoutingClass: isPlainRecord(value.heartbeat?.perRoutingClass)
        ? value.heartbeat.perRoutingClass
        : { ...DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.heartbeat.perRoutingClass },
    },
    retry: {
      perRoutingClass: isPlainRecord(value.retry?.perRoutingClass)
        ? value.retry.perRoutingClass
        : { ...DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.retry.perRoutingClass },
    },
    spawnSuppression: {
      cooldownSeconds: normalizePositiveInteger(
        value.spawnSuppression?.cooldownSeconds,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.spawnSuppression.cooldownSeconds,
      ),
    },
    directSessionContinuity: {
      maxContextFraction: normalizePositiveNumber(
        value.directSessionContinuity?.maxContextFraction,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.directSessionContinuity.maxContextFraction,
      ),
      maxCompactions: normalizePositiveInteger(
        value.directSessionContinuity?.maxCompactions,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.directSessionContinuity.maxCompactions,
      ),
      maxTranscriptBytes: normalizePositiveInteger(
        value.directSessionContinuity?.maxTranscriptBytes,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.directSessionContinuity.maxTranscriptBytes,
      ),
      maxWorkerNotices: normalizePositiveInteger(
        value.directSessionContinuity?.maxWorkerNotices,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.directSessionContinuity.maxWorkerNotices,
      ),
    },
    selfImprovement: {
      requireMutationTargets: normalizeBoolean(
        value.selfImprovement?.requireMutationTargets,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.selfImprovement.requireMutationTargets,
      ),
    },
    limits: {
      maxSpawnDepth: normalizePositiveInteger(
        value.limits?.maxSpawnDepth,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.limits.maxSpawnDepth,
      ),
      maxChildrenPerAgent: normalizePositiveInteger(
        value.limits?.maxChildrenPerAgent,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.limits.maxChildrenPerAgent,
      ),
      maxConcurrent: normalizePositiveInteger(
        value.limits?.maxConcurrent,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.limits.maxConcurrent,
      ),
      runTimeoutSeconds: normalizePositiveInteger(
        value.limits?.runTimeoutSeconds,
        DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.limits.runTimeoutSeconds,
      ),
    },
  };
}

export function loadOrchestrationRuntimeConfig(cfg: OpenClawConfig = loadConfig()) {
  const withCompatibility = mergeRecords(
    DEFAULT_ORCHESTRATION_RUNTIME_CONFIG,
    readLegacyCompatibilityOverlay(cfg),
  );
  return normalizeRuntimeConfig(mergeRecords(withCompatibility, readConfigOverlay(cfg)));
}

export function isOrchestrationChannelEnabled(
  sessionKey: string,
  config: OrchestrationRuntimeConfig,
): boolean {
  if (!config.enabled) {
    return false;
  }
  const channel = normalizeOrchestrationChannel(sessionKey);
  return config.enabledChannels.includes(channel);
}
