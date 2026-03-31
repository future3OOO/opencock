import {
  commitDelegatedWorkerFromSession,
  completeMissionFromSession,
  delegateExplicitRequestFromSession,
  heartbeatMissionFromSession,
  listOrchestratorMissionsFromSession,
  prepareDispatchRequestFromSession,
  queryMissionStatusFromSession,
  querySessionStatusFromSession,
} from "./control-plane.js";
import { cancelMissionFromSession } from "./service.js";

export const ORCHESTRATION_BRIDGE_COMMANDS = [
  "prepare",
  "delegate",
  "commit",
  "complete",
  "heartbeat",
  "status",
  "query-status",
  "list",
  "cancel",
] as const;

export type OrchestrationBridgeCommand = (typeof ORCHESTRATION_BRIDGE_COMMANDS)[number];

type BridgePayload = Record<string, unknown>;

function stringValue(payload: BridgePayload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function optionalStringValue(payload: BridgePayload, key: string): string | undefined {
  const value = stringValue(payload, key).trim();
  return value ? value : undefined;
}

function booleanValue(payload: BridgePayload, key: string): boolean {
  return Boolean(payload[key]);
}

function stringArrayValue(payload: BridgePayload, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function integerValue(payload: BridgePayload, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export async function runOrchestrationBridgeCommand(
  command: OrchestrationBridgeCommand,
  payload: BridgePayload,
) {
  switch (command) {
    case "prepare":
      return await prepareDispatchRequestFromSession({
        text: stringValue(payload, "text"),
        sessionKey: stringValue(payload, "sessionKey"),
        surface: optionalStringValue(payload, "surface"),
        hasBrowserNeed: booleanValue(payload, "hasBrowserNeed"),
        hasRepoMutation: booleanValue(payload, "hasRepoMutation"),
        hasTimedCommitment: booleanValue(payload, "hasTimedCommitment"),
        toolNeeds: stringArrayValue(payload, "toolNeeds"),
        isMultiStep: booleanValue(payload, "isMultiStep"),
        allowAutoDelegate: booleanValue(payload, "allowAutoDelegate"),
      });
    case "delegate":
      return await delegateExplicitRequestFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        routingClass: stringValue(payload, "routingClass"),
        task: stringValue(payload, "task"),
        statusSummary: stringValue(payload, "statusSummary"),
        surface: optionalStringValue(payload, "surface"),
        toolNeeds: stringArrayValue(payload, "toolNeeds"),
        timeoutSeconds: integerValue(payload, "runTimeoutSeconds"),
      });
    case "commit":
      return await commitDelegatedWorkerFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        missionId: stringValue(payload, "missionId"),
        workerId: stringValue(payload, "workerId"),
        routingClass: stringValue(payload, "routingClass"),
        mechanismId: optionalStringValue(payload, "mechanismId"),
        surface: optionalStringValue(payload, "surface"),
        workerSessionKey: optionalStringValue(payload, "workerSessionKey"),
        processSessionId: optionalStringValue(payload, "processSessionId"),
        suppressionKey: optionalStringValue(payload, "suppressionKey"),
        statusSummary: optionalStringValue(payload, "statusSummary"),
      });
    case "complete":
      return await completeMissionFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        missionId: stringValue(payload, "missionId"),
        workerId: stringValue(payload, "workerId"),
        state: optionalStringValue(payload, "state"),
        statusSummary: optionalStringValue(payload, "statusSummary"),
        replyText: optionalStringValue(payload, "replyText"),
        artifactPath: optionalStringValue(payload, "artifactPath"),
        deliveryState: optionalStringValue(payload, "deliveryState"),
        clearBinding:
          payload.clearBinding === undefined ? true : booleanValue(payload, "clearBinding"),
      });
    case "heartbeat":
      return await heartbeatMissionFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        missionId: stringValue(payload, "missionId"),
        workerId: stringValue(payload, "workerId"),
        statusSummary: optionalStringValue(payload, "statusSummary"),
      });
    case "status": {
      const missionId = optionalStringValue(payload, "missionId");
      if (missionId) {
        return await queryMissionStatusFromSession({ missionId });
      }
      return await querySessionStatusFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
      });
    }
    case "query-status":
      return await queryMissionStatusFromSession({
        missionId: stringValue(payload, "missionId"),
      });
    case "list":
      return await listOrchestratorMissionsFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        activeOnly: booleanValue(payload, "activeOnly"),
        allDirectSessions: booleanValue(payload, "allDirectSessions"),
      });
    case "cancel":
      return await cancelMissionFromSession({
        sessionKey: stringValue(payload, "sessionKey"),
        missionId: optionalStringValue(payload, "missionId"),
        statusSummary: optionalStringValue(payload, "statusSummary"),
      });
  }
}
