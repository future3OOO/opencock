import { loadSessionEntry } from "../gateway/session-utils.js";
import { reconcileTaskLookupToken } from "../tasks/task-registry.reconcile.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { isOrchestratedMissionTask } from "./runtime-primitives.js";
import {
  clearSessionMissionBindingIfMatches,
  readSessionMissionBinding,
  type SessionMissionBinding,
} from "./session-state.js";

function findTaskByWorkerId(sessionKey: string, workerId: string): TaskRecord | undefined {
  const task = reconcileTaskLookupToken(workerId);
  if (
    task &&
    isOrchestratedMissionTask(task) &&
    task.requesterSessionKey === sessionKey &&
    task.orchestrationWorkerId === workerId
  ) {
    return task;
  }
  return undefined;
}

function resolveBoundTask(
  sessionKey: string,
  binding: SessionMissionBinding,
): TaskRecord | undefined {
  if (binding.activeMissionId) {
    const missionTask = reconcileTaskLookupToken(binding.activeMissionId);
    if (
      missionTask &&
      isOrchestratedMissionTask(missionTask) &&
      missionTask.requesterSessionKey === sessionKey
    ) {
      return missionTask;
    }
  }
  if (binding.focusedWorkerId) {
    return findTaskByWorkerId(sessionKey, binding.focusedWorkerId);
  }
  return undefined;
}

export type ReconciledSessionMissionBinding = {
  sessionKey: string;
  binding: SessionMissionBinding;
  task?: TaskRecord;
  cleared: boolean;
};

export async function reconcileSessionMissionBinding(params: {
  sessionKey: string;
}): Promise<ReconciledSessionMissionBinding> {
  const loaded = loadSessionEntry(params.sessionKey);
  const sessionKey = loaded.canonicalKey;
  const binding = readSessionMissionBinding(loaded.entry);
  if (!binding.activeMissionId && !binding.focusedWorkerId) {
    return {
      sessionKey,
      binding,
      cleared: false,
    };
  }
  const task = resolveBoundTask(sessionKey, binding);
  if (task?.status === "running") {
    return {
      sessionKey,
      binding,
      task,
      cleared: false,
    };
  }
  const cleared = await clearSessionMissionBindingIfMatches({
    sessionKey,
    missionId: binding.activeMissionId,
    workerId: binding.focusedWorkerId,
  });
  return {
    sessionKey,
    binding: {
      activeMissionId: null,
      focusedWorkerId: null,
    },
    task,
    cleared,
  };
}
