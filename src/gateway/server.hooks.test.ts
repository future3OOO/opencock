import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  mergeSessionEntry,
  resolveSessionStoreEntry,
  resolveStorePath,
  updateSessionStore,
} from "../config/sessions.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { DEDUPE_TTL_MS } from "./server-constants.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const resolveMainKey = () => resolveMainSessionKeyFromConfig();
const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
});

function buildHookJsonHeaders(options?: {
  token?: string | null;
  headers?: Record<string, string>;
}): Record<string, string> {
  const token = options?.token === undefined ? HOOK_TOKEN : options.token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  };
}

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown> | string,
  options?: {
    token?: string | null;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: buildHookJsonHeaders(options),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setMainAndHooksAgents(): void {
  testState.agentsConfig = {
    list: [{ id: "main", default: true }, { id: "hooks" }],
  };
}

function mockIsolatedRunOkOnce(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValueOnce({
    status: "ok",
    summary: "done",
  });
}

function mockIsolatedRunOk(): void {
  cronIsolatedRun.mockClear();
  cronIsolatedRun.mockResolvedValue({
    status: "ok",
    summary: "done",
  });
}

async function postAgentHookWithIdempotency(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const response = await postHook(
    port,
    "/hooks/agent",
    { message: "Do it", name: "Email" },
    { headers: { "Idempotency-Key": idempotencyKey, ...headers } },
  );
  expect(response.status).toBe(200);
  return response;
}

async function expectFirstHookDelivery(
  port: number,
  idempotencyKey: string,
  headers?: Record<string, string>,
) {
  const first = await postAgentHookWithIdempotency(port, idempotencyKey, headers);
  const firstBody = (await first.json()) as { runId?: string };
  expect(firstBody.runId).toBeTruthy();
  await waitForSystemEvent();
  drainSystemEvents(resolveMainKey());
  return firstBody;
}

async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 10) {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
}

describe("gateway server hooks", () => {
  test("handles auth, wake, and agent flows", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      const resNoAuth = await postHook(port, "/hooks/wake", { text: "Ping" }, { token: null });
      expect(resNoAuth.status).toBe(401);

      const resWake = await postHook(port, "/hooks/wake", { text: "Ping", mode: "next-heartbeat" });
      expect(resWake.status).toBe(200);
      const wakeEvents = await waitForSystemEvent();
      expect(wakeEvents.some((e) => e.includes("Ping"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgent = await postHook(port, "/hooks/agent", { message: "Do it", name: "Email" });
      expect(resAgent.status).toBe(200);
      const agentEvents = await waitForSystemEvent();
      expect(agentEvents.some((e) => e.includes("Hook Email: done"))).toBe(true);
      const firstCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        deliveryContract?: string;
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(firstCall?.deliveryContract).toBe("shared");
      expect(firstCall?.job?.payload?.externalContentSource).toBe("webhook");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentModel = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        model: "openai/gpt-4.1-mini",
      });
      expect(resAgentModel.status).toBe(200);
      await waitForSystemEvent();
      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { payload?: { model?: string } };
      };
      expect(call?.job?.payload?.model).toBe("openai/gpt-4.1-mini");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentWithId = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
      });
      expect(resAgentWithId.status).toBe(200);
      await waitForSystemEvent();
      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(routedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAgentUnknown = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "missing-agent",
      });
      expect(resAgentUnknown.status).toBe(200);
      await waitForSystemEvent();
      const fallbackCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(fallbackCall?.job?.agentId).toBe("main");
      drainSystemEvents(resolveMainKey());

      const resQuery = await postHook(
        port,
        "/hooks/wake?token=hook-secret",
        { text: "Query auth" },
        { token: null },
      );
      expect(resQuery.status).toBe(400);

      const resBadChannel = await postHook(port, "/hooks/agent", {
        message: "Nope",
        channel: "sms",
      });
      expect(resBadChannel.status).toBe(400);
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);

      const resHeader = await postHook(
        port,
        "/hooks/wake",
        { text: "Header auth" },
        { token: null, headers: { "x-openclaw-token": HOOK_TOKEN } },
      );
      expect(resHeader.status).toBe(200);
      const headerEvents = await waitForSystemEvent();
      expect(headerEvents.some((e) => e.includes("Header auth"))).toBe(true);
      drainSystemEvents(resolveMainKey());

      const resGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
        method: "GET",
        headers: { Authorization: "Bearer hook-secret" },
      });
      expect(resGet.status).toBe(405);

      const resBlankText = await postHook(port, "/hooks/wake", { text: " " });
      expect(resBlankText.status).toBe(400);

      const resBlankMessage = await postHook(port, "/hooks/agent", { message: " " });
      expect(resBlankMessage.status).toBe(400);

      const resBadJson = await postHook(port, "/hooks/wake", "{");
      expect(resBadJson.status).toBe(400);
    });
  });

  test("preserves mapped hook provenance across async dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      mappings: [
        {
          match: { path: "gmail" },
          action: "agent",
          messageTemplate: "New email from {{messages[0].from}}",
          sessionKey: "main",
        },
      ],
    };
    setMainAndHooksAgents();

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const response = await postHook(port, "/hooks/gmail", {
        source: "gmail",
        messages: [{ id: "msg-1", from: "Ada", subject: "Hello", snippet: "Hi", body: "Body" }],
      });
      expect(response.status).toBe(200);
      await waitForSystemEvent();

      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sessionKey?: string;
        job?: { payload?: { externalContentSource?: string } };
      };
      expect(call?.sessionKey).toBe("main");
      expect(call?.job?.payload?.externalContentSource).toBe("gmail");
      drainSystemEvents(resolveMainKey());
    });
  });

  test("rejects request sessionKey unless hooks.allowRequestSessionKey is enabled", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const denied = await postHook(port, "/hooks/agent", {
        message: "Do it",
        sessionKey: "agent:main:dm:u99999",
      });
      expect(denied.status).toBe(400);
      const deniedBody = (await denied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowRequestSessionKey");
    });
  });

  test("respects hooks session policy for request + mapping session keys", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      defaultSessionKey: "hook:ingress",
      mappings: [
        {
          match: { path: "mapped-ok" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "hook:mapped:{{payload.id}}",
        },
        {
          match: { path: "mapped-bad" },
          action: "agent",
          messageTemplate: "Mapped: {{payload.subject}}",
          sessionKey: "agent:main:main",
        },
      ],
    };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });

      const defaultRoute = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ message: "No key" }),
      });
      expect(defaultRoute.status).toBe(200);
      await waitForSystemEvent();
      const defaultCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(defaultCall?.sessionKey).toBe("hook:ingress");
      drainSystemEvents(resolveMainKey());

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "done" });
      const mappedOk = await fetch(`http://127.0.0.1:${port}/hooks/mapped-ok`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer hook-secret",
        },
        body: JSON.stringify({ subject: "hello", id: "42" }),
      });
      expect(mappedOk.status).toBe(200);
      await waitForSystemEvent();
      const mappedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string }
        | undefined;
      expect(mappedCall?.sessionKey).toBe("hook:mapped:42");
      drainSystemEvents(resolveMainKey());

      const requestBadPrefix = await postHook(port, "/hooks/agent", {
        message: "Bad key",
        sessionKey: "agent:main:main",
      });
      expect(requestBadPrefix.status).toBe(400);

      const mappedBadPrefix = await postHook(port, "/hooks/mapped-bad", { subject: "hello" });
      expect(mappedBadPrefix.status).toBe(400);
    });
  });

  test("normalizes duplicate target-agent prefixes before isolated dispatch", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:", "agent:"],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();

      const resAgent = await postHook(port, "/hooks/agent", {
        message: "Do it",
        name: "Email",
        agentId: "hooks",
        sessionKey: "agent:hooks:slack:channel:c123",
      });
      expect(resAgent.status).toBe(200);
      await waitForSystemEvent();

      const routedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | { sessionKey?: string; job?: { agentId?: string } }
        | undefined;
      expect(routedCall?.job?.agentId).toBe("hooks");
      expect(routedCall?.sessionKey).toBe("slack:channel:c123");
      drainSystemEvents(resolveMainKey());
    });
  });

  test("dedupes repeated /hooks/agent deliveries by idempotency key", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-1");
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const second = await postAgentHookWithIdempotency(port, "hook-idem-1");
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      expect(peekSystemEvents(resolveMainKey())).toHaveLength(0);
    });
  });

  test("dedupes hook retries even when trusted-proxy client IP changes", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    expect(configPath).toBeTruthy();
    await fs.writeFile(
      configPath!,
      JSON.stringify({ gateway: { trustedProxies: ["127.0.0.1"] } }, null, 2),
      "utf-8",
    );

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "198.51.100.10",
      });
      const second = await postAgentHookWithIdempotency(port, "hook-idem-forwarded", {
        "X-Forwarded-For": "203.0.113.25",
      });
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
    });
  });

  test("does not retain oversized idempotency keys for replay dedupe", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const oversizedKey = "x".repeat(257);

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      await expectFirstHookDelivery(port, oversizedKey);
      await postAgentHookWithIdempotency(port, oversizedKey);
      await waitForSystemEvent();

      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("expires hook idempotency entries from first delivery time", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOk();
      const firstBody = await expectFirstHookDelivery(port, "fixed-window-idem");

      nowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS - 1);
      const second = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { runId?: string };
      expect(secondBody.runId).toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + DEDUPE_TTL_MS + 1);
      const third = await postHook(
        port,
        "/hooks/agent",
        { message: "Do it", name: "Email" },
        { headers: { "Idempotency-Key": "fixed-window-idem" } },
      );
      expect(third.status).toBe(200);
      const thirdBody = (await third.json()) as { runId?: string };
      expect(thirdBody.runId).toBeTruthy();
      expect(thirdBody.runId).not.toBe(firstBody.runId);
      expect(cronIsolatedRun).toHaveBeenCalledTimes(2);
    });
  });

  test("enforces hooks.allowedAgentIds for explicit agent routing", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: ["hooks"],
      mappings: [
        {
          match: { path: "mapped" },
          action: "agent",
          agentId: "main",
          messageTemplate: "Mapped: {{payload.subject}}",
        },
      ],
    };
    setMainAndHooksAgents();
    await withGatewayServer(async ({ port }) => {
      mockIsolatedRunOkOnce();
      const resNoAgent = await postHook(port, "/hooks/agent", { message: "No explicit agent" });
      expect(resNoAgent.status).toBe(200);
      await waitForSystemEvent();
      const noAgentCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(noAgentCall?.job?.agentId).toBeUndefined();
      drainSystemEvents(resolveMainKey());

      mockIsolatedRunOkOnce();
      const resAllowed = await postHook(port, "/hooks/agent", {
        message: "Allowed",
        agentId: "hooks",
      });
      expect(resAllowed.status).toBe(200);
      await waitForSystemEvent();
      const allowedCall = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as {
        job?: { agentId?: string };
      };
      expect(allowedCall?.job?.agentId).toBe("hooks");
      drainSystemEvents(resolveMainKey());

      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "main",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");

      const resMappedDenied = await postHook(port, "/hooks/mapped", { subject: "hello" });
      expect(resMappedDenied.status).toBe(400);
      const mappedDeniedBody = (await resMappedDenied.json()) as { error?: string };
      expect(mappedDeniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("denies explicit agentId when hooks.allowedAgentIds is empty", async () => {
    testState.hooksConfig = {
      enabled: true,
      token: HOOK_TOKEN,
      allowedAgentIds: [],
    };
    testState.agentsConfig = {
      list: [{ id: "main", default: true }, { id: "hooks" }],
    };
    await withGatewayServer(async ({ port }) => {
      const resDenied = await postHook(port, "/hooks/agent", {
        message: "Denied",
        agentId: "hooks",
      });
      expect(resDenied.status).toBe(400);
      const deniedBody = (await resDenied.json()) as { error?: string };
      expect(deniedBody.error).toContain("hooks.allowedAgentIds");
      expect(peekSystemEvents(resolveMainKey()).length).toBe(0);
    });
  });

  test("throttles repeated hook auth failures and resets after success", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      const firstFail = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(firstFail.status).toBe(401);

      let throttled: Response | null = null;
      for (let i = 0; i < 20; i++) {
        throttled = await postHook(port, "/hooks/wake", { text: "blocked" }, { token: "wrong" });
      }
      expect(throttled?.status).toBe(429);
      expect(throttled?.headers.get("retry-after")).toBeTruthy();

      const allowed = await postHook(port, "/hooks/wake", { text: "auth reset" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());

      const failAfterSuccess = await postHook(
        port,
        "/hooks/wake",
        { text: "blocked" },
        { token: "wrong" },
      );
      expect(failAfterSuccess.status).toBe(401);
    });
  });

  test("rejects non-POST hook requests without consuming auth failure budget", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      let lastGet: Response | null = null;
      for (let i = 0; i < 21; i++) {
        lastGet = await fetch(`http://127.0.0.1:${port}/hooks/wake`, {
          method: "GET",
          headers: { Authorization: "Bearer wrong" },
        });
      }
      expect(lastGet?.status).toBe(405);
      expect(lastGet?.headers.get("allow")).toBe("POST");

      const allowed = await postHook(port, "/hooks/wake", { text: "still works" });
      expect(allowed.status).toBe(200);
      await waitForSystemEvent();
      drainSystemEvents(resolveMainKey());
    });
  });

  test("dispatches mission wakes from pending mission notifications without fallback spam", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async () => {
      const cfg = loadConfig();
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      await updateSessionStore(storePath, async (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey: "agent:main:main" });
        store[resolved.normalizedKey] = mergeSessionEntry(resolved.existing, {
          pendingMissionNotifications: {
            "mission-hook-1": {
              missionId: "mission-hook-1",
              workerId: "worker-hook-1",
              finalState: "completed",
              statusSummary: "Source-owned mission wake is ready.",
              artifactPath: null,
              deliveredAtMs: Date.now(),
              attempts: 0,
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });
      });

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "wake delivered",
        delivered: true,
      });

      const runtime = (
        globalThis as typeof globalThis & {
          __openclaw_mission_wake_runtime__?: {
            dispatchForSession: (sessionKey: string) => Promise<boolean>;
          };
        }
      ).__openclaw_mission_wake_runtime__;
      expect(runtime).toBeTruthy();
      await runtime!.dispatchForSession("agent:main:main");

      await waitForAssertion(() => {
        expect(cronIsolatedRun.mock.calls.length).toBeGreaterThanOrEqual(1);
      });

      const call = (cronIsolatedRun.mock.calls[0] as unknown[] | undefined)?.[0] as
        | {
            sessionKey?: string;
            job?: { sessionKey?: string; payload?: { deliver?: boolean; message?: string } };
          }
        | undefined;
      expect(call?.sessionKey).toBe("agent:main:main");
      expect(call?.job?.sessionKey).toBe("agent:main:main");
      expect(call?.job?.payload?.deliver).toBe(true);
      expect(call?.job?.payload?.message).toContain("mission-hook-1");
      expect(peekSystemEvents(resolveMainKey())).toEqual([]);

      await waitForAssertion(() => {
        const store = loadSessionStore(storePath, { skipCache: true });
        expect(store["agent:main:main"]?.pendingMissionNotifications).toBeNull();
      });
    });
  });

  test("keeps mission wake pending when the isolated turn does not deliver", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async () => {
      const cfg = loadConfig();
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      await updateSessionStore(storePath, async (store) => {
        const resolved = resolveSessionStoreEntry({ store, sessionKey: "agent:main:main" });
        store[resolved.normalizedKey] = mergeSessionEntry(resolved.existing, {
          pendingMissionNotifications: {
            "mission-hook-2": {
              missionId: "mission-hook-2",
              workerId: "worker-hook-2",
              finalState: "completed",
              statusSummary: "Delivery should stay pending.",
              artifactPath: null,
              deliveredAtMs: Date.now(),
              attempts: 0,
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });
      });

      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({
        status: "ok",
        summary: "not delivered",
        delivered: false,
      });

      const runtime = (
        globalThis as typeof globalThis & {
          __openclaw_mission_wake_runtime__?: {
            dispatchForSession: (sessionKey: string) => Promise<boolean>;
          };
        }
      ).__openclaw_mission_wake_runtime__;
      expect(runtime).toBeTruthy();
      await runtime!.dispatchForSession("agent:main:main");

      await waitForAssertion(() => {
        expect(cronIsolatedRun).toHaveBeenCalledTimes(1);
      });

      expect(peekSystemEvents(resolveMainKey())).toEqual([]);
      const store = loadSessionStore(storePath, { skipCache: true });
      expect(
        store["agent:main:main"]?.pendingMissionNotifications?.["mission-hook-2"],
      ).toMatchObject({
        missionId: "mission-hook-2",
      });
      expect(
        store["agent:main:main"]?.pendingMissionNotifications?.["mission-hook-2"]?.attempts ?? 0,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
