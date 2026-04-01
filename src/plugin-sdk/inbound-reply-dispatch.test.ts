import { beforeEach, describe, expect, it, vi } from "vitest";

type AppendUserMessageResult = Awaited<
  ReturnType<typeof import("../config/sessions/transcript.js").appendUserMessageToSessionTranscript>
>;
type DispatchBufferedReplyFn = Parameters<
  typeof import("./inbound-reply-dispatch.js").recordInboundSessionAndDispatchReply
>[0]["dispatchReplyWithBufferedBlockDispatcher"];
type DispatchBufferedReplyParams = Parameters<DispatchBufferedReplyFn>[0];

const appendUserMessageToSessionTranscriptMock = vi.fn<
  (args?: unknown) => Promise<AppendUserMessageResult>
>(async () => ({
  ok: true,
  sessionFile: "/tmp/inbound-transcript.jsonl",
  messageId: "msg-inbound-1",
}));

vi.mock("./channel-reply-pipeline.js", () => ({
  createChannelReplyPipeline: vi.fn(() => ({ onModelSelected: undefined })),
}));

vi.mock("./reply-payload.js", () => ({
  createNormalizedOutboundDeliverer: vi.fn(
    (deliver: (payload: unknown) => Promise<void>) => deliver,
  ),
}));

vi.mock("../config/sessions/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions/transcript.js")>(
    "../config/sessions/transcript.js",
  );
  return {
    ...actual,
    appendUserMessageToSessionTranscript: (...args: unknown[]) =>
      appendUserMessageToSessionTranscriptMock(...args),
  };
});

describe("recordInboundSessionAndDispatchReply", () => {
  beforeEach(() => {
    appendUserMessageToSessionTranscriptMock.mockClear();
  });

  it("persists inbound user turns to the session transcript before dispatch", async () => {
    const { recordInboundSessionAndDispatchReply } = await import("./inbound-reply-dispatch.js");
    const recordInboundSession = vi.fn(async () => {});
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: DispatchBufferedReplyParams) => {
        await params.dispatcherOptions.deliver({ text: "reply text" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      },
    );
    const deliver = vi.fn(async () => {});

    await recordInboundSessionAndDispatchReply({
      cfg: {} as never,
      channel: "whatsapp",
      agentId: "agent-main",
      routeSessionKey: "agent:main:whatsapp:direct:+15551234567",
      storePath: "/tmp/openclaw-session-store.json",
      ctxPayload: {
        SessionKey: "agent:main:whatsapp:direct:+15551234567",
        Provider: "whatsapp",
        Surface: "whatsapp",
        BodyForCommands: "hello there",
        MessageSid: "wamid-1",
        CommandAuthorized: true,
      },
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
      deliver,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn(),
    });

    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(appendUserMessageToSessionTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-main",
        sessionKey: "agent:main:whatsapp:direct:+15551234567",
        storePath: "/tmp/openclaw-session-store.json",
        idempotencyKey: "inbound:agent:main:whatsapp:direct:+15551234567:wamid-1",
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" }, { kind: "final" });
  });

  it("reports transcript append failures without blocking reply dispatch", async () => {
    appendUserMessageToSessionTranscriptMock.mockResolvedValueOnce({
      ok: false as const,
      reason: "disk unavailable",
    });
    const { recordInboundSessionAndDispatchReply } = await import("./inbound-reply-dispatch.js");
    const onRecordError = vi.fn();
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
      async (params: DispatchBufferedReplyParams) => {
        await params.dispatcherOptions.deliver({ text: "reply text" }, { kind: "final" });
        return { queuedFinal: true, counts: { block: 0, final: 1, tool: 0 } };
      },
    );

    await recordInboundSessionAndDispatchReply({
      cfg: {} as never,
      channel: "whatsapp",
      agentId: "agent-main",
      routeSessionKey: "agent:main:whatsapp:direct:+15551234567",
      storePath: "/tmp/openclaw-session-store.json",
      ctxPayload: {
        SessionKey: "agent:main:whatsapp:direct:+15551234567",
        Provider: "whatsapp",
        Surface: "whatsapp",
        BodyForCommands: "hello there",
        MessageSid: "wamid-1",
        CommandAuthorized: true,
      },
      recordInboundSession: vi.fn(async () => {}),
      dispatchReplyWithBufferedBlockDispatcher,
      deliver: vi.fn(async () => {}),
      onRecordError,
      onDispatchError: vi.fn(),
    });

    expect(onRecordError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "failed to persist inbound transcript: disk unavailable",
      }),
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
});
