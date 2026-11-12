// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot } from "@/state/store";

const held = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: held.state as AppState, dispatch: () => {} }) };
});
const { ThreadRefsProvider, useThreadRefs } = await import("./ThreadRefs");

const bot = (id: string, title: string): Bot => ({
  id, threadId: `${id}-main`, name: id, title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
  modelSelection: { instanceId: "fake", model: "test" }, tasks: [{ threadId: `${id}-main`, title, createdAt: 1 }],
});

it("hands its readers the same value until a thread or the open bot changes", () => {
  const values: unknown[] = [];
  const Reader = () => { values.push(useThreadRefs()); return null; };
  const root = createRoot(document.createElement("div"));
  const draw = (state: AppState) => {
    held.state = state;
    flushSync(() => root.render(createElement(ThreadRefsProvider, null, createElement(Reader))));
  };
  let state: AppState = { ...initialState, bots: [bot("scout", "Main"), bot("ada", "Plan")], selectedId: "scout" };
  draw(state);
  const first = values.at(-1);
  expect(first).toMatchObject({ currentBotId: "scout", threads: [{ threadId: "scout-main", title: "Main" }, { threadId: "ada-main", title: "Plan" }] });

  state = { ...state, connected: !state.connected };
  draw(state);
  state = { ...state, bots: state.bots.map((each) => ({ ...each, busy: true, unread: true })) };
  draw(state);
  expect(values.at(-1), "a bot's turn names no new thread").toBe(first);

  state = { ...state, bots: state.bots.map((each) => each.id === "ada" ? { ...each, tasks: [{ threadId: "ada-main", title: "Launch plan", createdAt: 1 }] } : each) };
  draw(state);
  const renamed = values.at(-1);
  expect(renamed).not.toBe(first);
  expect(renamed).toMatchObject({ threads: [{ title: "Main" }, { title: "Launch plan" }] });

  state = { ...state, selectedId: "ada" };
  draw(state);
  expect(values.at(-1)).toMatchObject({ currentBotId: "ada" });
  expect((values.at(-1) as { threads: unknown }).threads).toBe((renamed as { threads: unknown }).threads);
  root.unmount();
});
