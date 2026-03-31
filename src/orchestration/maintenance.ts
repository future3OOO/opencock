import type { TaskRecord } from "../tasks/task-registry.types.js";
import {
  DEFAULT_ORCHESTRATION_RUNTIME_CONFIG,
  loadOrchestrationRuntimeConfig,
  type OrchestrationRuntimeRoutingClass,
} from "./runtime-config.js";

const ORCHESTRATION_RUNTIME_ROUTING_CLASSES = new Set<OrchestrationRuntimeRoutingClass>(
  Object.keys(
    DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.heartbeat.perRoutingClass,
  ) as OrchestrationRuntimeRoutingClass[],
);

function isOrchestrationRuntimeRoutingClass(
  value: string,
): value is OrchestrationRuntimeRoutingClass {
  return ORCHESTRATION_RUNTIME_ROUTING_CLASSES.has(value as OrchestrationRuntimeRoutingClass);
}

function resolveHeartbeatReferenceAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.startedAt ?? task.createdAt;
}

export function shouldMarkOrchestrationTaskStale(params: { task: TaskRecord; now?: number }): {
  stale: boolean;
  reason?: string;
} {
  const task = params.task;
  const routingClass = task.orchestrationRoutingClass?.trim();
  if (
    (task.status !== "queued" && task.status !== "running") ||
    !routingClass ||
    !isOrchestrationRuntimeRoutingClass(routingClass)
  ) {
    return { stale: false };
  }
  const config = loadOrchestrationRuntimeConfig();
  const intervalSeconds =
    config.heartbeat.perRoutingClass[routingClass] ?? config.heartbeat.intervalSeconds;
  const staleAfterMs = intervalSeconds * Math.max(1, config.heartbeat.staleMultiplier) * 1000;
  if (staleAfterMs <= 0) {
    return { stale: false };
  }
  const now = params.now ?? Date.now();
  if (now - resolveHeartbeatReferenceAt(task) <= staleAfterMs) {
    return { stale: false };
  }
  return {
    stale: true,
    reason: `orchestration heartbeat stale: ${routingClass}`,
  };
}
