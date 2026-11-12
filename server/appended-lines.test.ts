import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppendedLines } from "./appended-lines.ts";

describe("reading only what a ledger gained", () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-appended-")); file = join(dir, "ledger.jsonl"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the whole file once, then only the lines added since", () => {
    writeFileSync(file, "one\ntwo\n");
    const lines = new AppendedLines(file);
    expect(lines.read()).toEqual({ restart: true, text: "one\ntwo\n" });
    expect(lines.read()).toEqual({ restart: false, text: "" });
    appendFileSync(file, "three\n");
    appendFileSync(file, "fóur\n");
    expect(lines.read()).toEqual({ restart: false, text: "three\nfóur\n" });
    const long = "x".repeat(500);
    appendFileSync(file, `${long}\n`);
    expect(lines.read()).toEqual({ restart: false, text: `${long}\n` });
    expect(lines.read()).toEqual({ restart: false, text: "" });
  });

  it("starts over when the file shrank, was rewritten to the same length or longer, or was replaced", () => {
    writeFileSync(file, "one\ntwo\n");
    const lines = new AppendedLines(file);
    lines.read();
    writeFileSync(file, "one\n");
    expect(lines.read()).toEqual({ restart: true, text: "one\n" });
    writeFileSync(file, "uno\n");
    expect(lines.read()).toEqual({ restart: true, text: "uno\n" });
    writeFileSync(file, "eins\nzwei\ndrei\n");
    expect(lines.read()).toEqual({ restart: true, text: "eins\nzwei\ndrei\n" });
    const other = join(dir, "other.jsonl");
    writeFileSync(other, "eins\nzwei\ndrei\nvier\n");
    rmSync(file);
    renameSync(other, file);
    expect(lines.read()).toEqual({ restart: true, text: "eins\nzwei\ndrei\nvier\n" });
  });

  it("reads again from the start after a read that ended inside a line", () => {
    writeFileSync(file, "one\ntw");
    const lines = new AppendedLines(file);
    expect(lines.read()).toEqual({ restart: true, text: "one\ntw" });
    appendFileSync(file, "o\nthree\n");
    expect(lines.read()).toEqual({ restart: true, text: "one\ntwo\nthree\n" });
    appendFileSync(file, "four\n");
    expect(lines.read()).toEqual({ restart: false, text: "four\n" });
  });

  it("throws for a missing file and picks up where it was when the file is back", () => {
    const lines = new AppendedLines(file);
    expect(() => lines.read()).toThrow(expect.objectContaining({ code: "ENOENT" }));
    writeFileSync(file, "");
    expect(lines.read()).toEqual({ restart: true, text: "" });
    appendFileSync(file, "one\n");
    expect(lines.read().text).toBe("one\n");
  });
});
