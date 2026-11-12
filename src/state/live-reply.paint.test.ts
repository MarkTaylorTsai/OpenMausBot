// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const redactions = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("../../shared/redact", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shared/redact")>();
  return { ...original, redactSecretsInText: (text: string) => { redactions.texts.push(text); return original.redactSecretsInText(text); } };
});

const { redactSecretsInText } = await vi.importActual<typeof import("../../shared/redact")>("../../shared/redact");
const { flushLiveReplies, hasLiveReply, liveReplies, liveReplyRows, liveReplyText, noteLiveReplyEvent, noteLiveReplyMessage, resetLiveReplies, useLiveReplies } = await import("./live-reply");

let seq = 0;
const note = (event: Partial<RuntimeEvent>, threadId = "t") =>
  act(() => noteLiveReplyEvent({ eventId: `e${++seq}`, provider: "claudeAgent", threadId, createdAt: "2026-11-11T12:00:00.000Z", turnId: "turn-1", itemId: "item-1", ...event } as RuntimeEvent));
const delta = (text: string, threadId = "t", itemId = "item-1") =>
  note({ type: "content.delta", streamKind: "assistant_text", delta: text, itemId } as Partial<RuntimeEvent>, threadId);
const complete = (text: string, threadId = "t") =>
  note({ type: "item.completed", itemType: "assistant_text", text } as Partial<RuntimeEvent>, threadId);
const shown = (threadId = "t") => liveReplyRows(liveReplies(threadId), []).rows.map((row) => row.text);

const paints: FrameRequestCallback[] = [];
const paint = () => act(() => { for (const callback of paints.splice(0)) callback(0); });
const stops: (() => void)[] = [];

/** A reader that draws the thread's reply: `count` is how often new words made it draw again. */
function hearing(threadId: string) {
  const heard = { count: -1, texts: [] as (string | undefined)[][] };
  const Reader = () => {
    const items = useLiveReplies(threadId);
    heard.count++;
    heard.texts.push(liveReplyRows(items, []).rows.map((row) => row.text));
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Reader)));
  stops.push(() => act(() => root.unmount()));
  return heard;
}

beforeEach(() => {
  vi.useFakeTimers();
  redactions.texts.length = 0;
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetLiveReplies();
  paints.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a streaming reply's readers", () => {
  it("hear the first delta of a paint at once and the rest of a burst once, at the next animation frame", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const heard = hearing("t");
    delta("One ");
    expect(heard.count, "the first words are not held back").toBe(1);
    for (const word of ["two ", "three ", "four "]) delta(word);
    expect(heard.count, "a burst inside one paint tells nobody yet").toBe(1);
    expect(shown(), "though a reader that looks sees every word").toEqual(["One two three four "]);
    paint();
    expect(heard.count).toBe(2);
    paint();
    expect(heard.count, "nothing new: nothing told").toBe(2);
    delta("five ");
    expect(heard.count, "a paint with nothing waiting ends the pacing").toBe(3);
  });

  it("hear the words in a window that paints no frames, from the timer", () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const heard = hearing("t");
    delta("One ");
    delta("two ");
    expect(heard.count).toBe(1);
    act(() => { vi.advanceTimersByTime(100); });
    expect(heard.count).toBe(2);
  });

  it("hear the words where there are no animation frames at all", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const heard = hearing("t");
    delta("One ");
    delta("two ");
    act(() => { vi.advanceTimersByTime(100); });
    expect(heard.count).toBe(2);
  });

  it("hear a reply complete at once, with its whole text, and are not told again at the paint", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const heard = hearing("t");
    delta("All ");
    delta("done ");
    delta("he");
    complete("All done here.");
    expect(heard.count, "the completion does not wait for the paint").toBe(2);
    expect(heard.texts.at(-1)).toEqual(["All done here."]);
    act(() => noteLiveReplyMessage("t", { id: "m1", role: "bot", kind: "text", turnId: "turn-1", itemId: "item-1" }));
    expect(heard.count, "nor does its saved message").toBe(3);
    paint();
    expect(heard.count, "what waited was already told").toBe(3);
    expect(heard.texts.at(-1)).toEqual(["All done here."]);
  });

  it("each thread waits for the paint on its own, and a flush tells every waiting thread now", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => paints.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const a = hearing("a"), b = hearing("b");
    delta("one ", "a", "ia");
    delta("two ", "b", "ib");
    delta("three ", "a", "ia");
    expect([a.count, b.count]).toEqual([1, 0]);
    act(() => flushLiveReplies());
    expect([a.count, b.count]).toEqual([2, 1]);
    paint();
    expect([a.count, b.count]).toEqual([2, 1]);
  });
});

describe("a streaming reply's masked text", () => {
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz012345";

  it("is made once for each text it shows, however often it is read", () => {
    delta("Here is the plan ");
    for (let i = 0; i < 5; i++) { hasLiveReply("t"); shown(); }
    expect(redactions.texts).toEqual(["Here is the plan "]);
    delta("for tod");
    for (let i = 0; i < 5; i++) { hasLiveReply("t"); shown(); }
    expect(redactions.texts, "the word still arriving shows nothing new, so nothing is masked again").toEqual(["Here is the plan ", "Here is the plan for "]);
    delta("ay");
    shown();
    expect(redactions.texts).toHaveLength(2);
    complete("Here is the plan for today.");
    shown(); shown();
    expect(redactions.texts.at(-1)).toBe("Here is the plan for today.");
    expect(redactions.texts).toHaveLength(3);
  });

  it("masks a secret split across deltas exactly as the whole text is masked", () => {
    const parts = ["The key is ", secret.slice(0, 9), secret.slice(9, 20), secret.slice(20), " and ", "that is all. "];
    let whole = "";
    for (const part of parts) {
      delta(part);
      whole += part;
      const visible = whole.slice(0, Math.max(whole.lastIndexOf(" "), whole.lastIndexOf("\n")) + 1);
      expect(shown().join("")).toBe(redactSecretsInText(visible).trim() ? redactSecretsInText(visible) : "");
      expect(shown().join("")).not.toContain(secret.slice(0, 20));
    }
    expect(shown().join("")).not.toContain(secret);
    expect(shown()).toEqual([redactSecretsInText(whole)]);
  });

  it("keeps each item's text its own", () => {
    delta("first words ", "a", "ia");
    delta("other words ", "b", "ib");
    expect(shown("a")).toEqual(["first words "]);
    expect(shown("b")).toEqual(["other words "]);
    expect(liveReplyText({ key: "ia", text: "changed words ", done: true }), "the same item with another text").toBe("changed words ");
    expect(liveReplyText({ text: secret, done: true }), "an item with no key is masked each time").toBe(redactSecretsInText(secret));
  });
});
