const MISSION_WAKE_RUNTIME_KEY = "__openclaw_mission_wake_runtime__";

export type MissionWakeRuntime = {
  dispatchForSession: (sessionKey: string) => Promise<boolean>;
  recoverPending: () => Promise<void>;
};

type MissionWakeRuntimeGlobals = typeof globalThis & {
  [MISSION_WAKE_RUNTIME_KEY]?: MissionWakeRuntime;
};

export function getMissionWakeRuntime(): MissionWakeRuntime | undefined {
  return (globalThis as MissionWakeRuntimeGlobals)[MISSION_WAKE_RUNTIME_KEY];
}

export function setMissionWakeRuntime(runtime: MissionWakeRuntime): void {
  (globalThis as MissionWakeRuntimeGlobals)[MISSION_WAKE_RUNTIME_KEY] = runtime;
}

export function clearMissionWakeRuntime(): void {
  delete (globalThis as MissionWakeRuntimeGlobals)[MISSION_WAKE_RUNTIME_KEY];
}
