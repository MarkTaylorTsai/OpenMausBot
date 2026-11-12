import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { serveStatic } from "./static-files.ts";

vi.mock("node:fs", { spy: true });

const dir = mkdtempSync(join(tmpdir(), "omb-static-"));
writeFileSync(join(dir, "index.html"), "app");
writeFileSync(join(dir, "rail.html"), "rail");
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "assets", "rail-1a2b.js"), "js");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function get(path: string, staticDir: string = dir) {
  const answer: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
  const res = {
    writeHead(status: number, headers: Record<string, string>) { answer.status = status; answer.headers = headers; return res; },
    end(data: Buffer) { answer.body = String(data); },
  } as unknown as ServerResponse;
  return { served: serveStatic(res, path, staticDir), ...answer };
}

describe("serveStatic", () => {
  it("answers the window's rail with its own small page, never cached", () => {
    const rail = get("/rail");
    expect(rail.body).toBe("rail");
    expect(rail.headers).toMatchObject({ "content-type": "text/html", "cache-control": "no-cache", "x-frame-options": "DENY" });
  });

  it("answers the app's paths with the app, and keeps hashed assets for good", () => {
    expect(get("/").body).toBe("app");
    expect(get("/settings").body).toBe("app");
    expect(get("/rail/more").body).toBe("app");
    expect(get("/assets/rail-1a2b.js").headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("reads a file once for any number of requests, and again when it changes or comes back", () => {
    const file = join(dir, "assets", "page-9f.js");
    const reads = () => vi.mocked(readFileSync).mock.calls.filter(([path]) => path === file).length;
    writeFileSync(file, "one");
    const first = get("/assets/page-9f.js");
    expect(get("/assets/page-9f.js")).toEqual(first);
    expect(first).toMatchObject({ served: true, status: 200, body: "one", headers: { "content-type": "text/javascript", "cache-control": "public, max-age=31536000, immutable" } });
    expect(reads()).toBe(1);

    writeFileSync(file, "three");
    expect(get("/assets/page-9f.js").body).toBe("three");
    writeFileSync(file, "seven");
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(get("/assets/page-9f.js").body, "the same size with another modification time").toBe("seven");
    expect(get("/assets/page-9f.js").body).toBe("seven");
    expect(reads()).toBe(3);

    rmSync(file);
    expect(get("/assets/page-9f.js")).toMatchObject({ body: "app", headers: { "content-type": "text/html", "cache-control": "no-cache" } });
    writeFileSync(file, "seven");
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    expect(get("/assets/page-9f.js").body).toBe("seven");
    expect(get("/assets", dir)).toMatchObject({ body: "app", headers: { "cache-control": "no-cache" } });
    expect(get("/x", join(dir, "missing")).served).toBe(false);
  });
});
