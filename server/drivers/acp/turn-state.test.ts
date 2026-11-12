import { describe, expect, it } from "vitest";

import { appendReplyText, endTurn, type AcpTurn } from "./turn-state.ts";

const ERROR_BODY = '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}';

/** A turn whose buffered text is `text`, flushed as core.ts does: a non-blank text becomes a reply. */
function turnWith(text: string, state: { stopped?: boolean; replied?: string } = {}) {
  const replies: string[] = [];
  const current = {
    state: { text: state.replied ?? "", stopped: false, producedItem: false, repliedText: false },
    flushAssistantText() {
      const said = current.state.text;
      current.state.text = "";
      if (!said.trim()) return;
      current.state.producedItem = true;
      current.state.repliedText = true;
      replies.push(said);
    },
  };
  if (state.replied) current.flushAssistantText();
  current.state.text = text;
  current.state.stopped = state.stopped ?? false;
  return { current: current as unknown as AcpTurn, replies };
}

describe("endTurn on a reply that is a provider's error body", () => {
  it("keeps an empty reply's existing notice key and provider", () => {
    const { current } = turnWith("");
    expect(endTurn(current, true, null, "Grok")).toEqual({
      ok: false, stopReason: "empty_turn", error: {
        message: "Grok finished without replying.",
        text: { key: "chat.notice.acpEmpty", params: { provider: "Grok" } },
      },
    });
  });

  it("keeps the semantic reset facts when a provider's error body ends the turn", () => {
    const { current, replies } = turnWith('429 {"error":{"message":"usage limit"}} retry-after-ms=300000');
    expect(endTurn(current, true, null, "Grok")).toMatchObject({
      ok: false, stopReason: "quota", error: {
        text: { key: "chat.notice.usageLimitResets", params: { provider: "Grok", resetsAt: expect.any(Number), timeZone: expect.any(String) } },
        limit: "engine", limitResetsAt: expect.any(Number),
      },
    });
    expect(replies).toEqual([]);
  });

  it("after the person's Stop, ends the turn as stopped and keeps what was said", () => {
    const { current, replies } = turnWith(ERROR_BODY, { stopped: true });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: "cancelled" });
    expect(replies).toEqual([ERROR_BODY]);
  });

  it("keeps the body a reply when the turn already replied in words before it", () => {
    const { current, replies } = turnWith(ERROR_BODY, { replied: "Let me check the deploy." });
    expect(endTurn(current, true, null, "omp")).toEqual({ ok: true, stopReason: null });
    expect(replies).toEqual(["Let me check the deploy.", ERROR_BODY]);
  });
});

describe("appendReplyText", () => {
  const streamedOld = (text: string) => {
    const trimmed = text.trimStart();
    return !trimmed.startsWith("<SYSTEM_MESSAGE") && !trimmed.startsWith("The following is a <SYSTEM_MESSAGE") && !trimmed.startsWith("<SYSTEM_NOTIFICATION");
  };
  const replies = [
    "Hello there, this is an ordinary reply that runs on for a while.",
    "  \n\t <SYSTEM_MESSAGE>do not show</SYSTEM_MESSAGE> and more",
    "The following is a <SYSTEM_MESSAGE from the engine",
    "The following is a <SYSTEM_MESSAG",
    "The following is a list: <SYSTEM_MESSAGE",
    "\n\n<SYSTEM_NOTIFICATION id=1>",
    "<SYSTEM_NOTIFICATIO then words",
    "   ",
    "x <SYSTEM_MESSAGE",
  ];

  it("streams each delta exactly when the whole reply so far does not open as a system message, however it is cut", () => {
    for (const reply of replies) {
      for (const size of [1, 2, 3, 7, 16, 40, 1_000]) {
        const state = { text: "" } as AcpTurn["state"];
        for (let at = 0; at < reply.length; at += size) {
          const streamed = appendReplyText(state, reply.slice(at, at + size));
          expect(state.text).toBe(reply.slice(0, at + size));
          expect(streamed, `${JSON.stringify(reply)} cut every ${size} at ${at}`).toBe(streamedOld(state.text));
        }
      }
    }
  });

  it("starts over after the text is flushed, and keeps only the reply's opening", () => {
    const state = { text: "" } as AcpTurn["state"];
    expect(appendReplyText(state, "<SYSTEM_MESSAGE")).toBe(false);
    expect(appendReplyText(state, " hidden")).toBe(false);
    state.text = "";
    expect(appendReplyText(state, "Shown ")).toBe(true);
    for (let i = 0; i < 200; i += 1) expect(appendReplyText(state, "more words ")).toBe(true);
    expect(state.textLead!.length).toBeLessThan(60);
    expect(state.text.length).toBeGreaterThan(2_000);
  });
});
