// tests/commands/upload.test.ts
import { test, expect, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uploadCommand } from "../../src/commands/upload";
import { parseCliArgs } from "../../src/cli";
import { openDb, startRun, saveComparison, finishRun } from "../../src/store/db";

let dir = "";
afterEach(() => { mock.restore(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

function project(server = true): { cfg: string; db: string } {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-upload-cmd-"));
  const db = join(dir, "m.sqlite"), cfg = join(dir, "momus.config.json");
  writeFileSync(cfg, JSON.stringify({
    dev: "https://d.example.com", prod: "https://p.example.com", output: { db, report: join(dir, "r.html") },
    ...(server ? { server: { url: "https://srv", project: "site" } } : {}),
  }));
  return { cfg, db };
}
function seed(dbPath: string, n: number): number[] {
  const db = openDb(dbPath);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = startRun(db, { devBaseUrl: "d", prodBaseUrl: "p", configJson: "{}", startedAt: `t${i}` });
    saveComparison(db, id, { path: `/${i}`, viewport: 1280, devUrl: "d", prodUrl: "p", status: "ok", diffScore: 0, passed: true,
      devImage: new Uint8Array([i, 1]), prodImage: new Uint8Array([i, 2]) });
    finishRun(db, id, "complete", "f");
    ids.push(id);
  }
  db.close();
  return ids;
}
function capture() {
  const out: string[] = [], err: string[] = [];
  spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return { out, err };
}
/** A server that wants every image and records the document it was sent. */
function fakeServer(status = 201) {
  const docs: any[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/runs") && init.method === "POST") {
      if (status !== 201) return new Response("nope", { status });
      const d = JSON.parse(init.body as string);
      docs.push(d);
      const missing = d.comparisons.flatMap((c: any) => [c.dev.image?.sha256, c.prod.image?.sha256]).filter(Boolean);
      return new Response(JSON.stringify({ runId: 5, url: "https://srv/runs/5", missing }), { status: 201 });
    }
    if (init.method === "PUT") return new Response(null, { status: 201 });
    return new Response(JSON.stringify({ runId: 5, url: "https://srv/runs/5" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, docs };
}
const sleep = () => Promise.resolve();

test("uploads the latest run and prints its URL", async () => {
  const c = capture();
  const p = project();
  const ids = seed(p.db, 2);
  const s = fakeServer();
  expect(await uploadCommand(parseCliArgs(["upload", "--config", p.cfg]), { fetch: s.f, sleep })).toBe(0);
  expect(s.docs[0].run.id).toBe(ids[1]);
  expect(c.out).toContain("https://srv/runs/5");
});

test("--run picks a run", async () => {
  capture();
  const p = project();
  const ids = seed(p.db, 2);
  const s = fakeServer();
  expect(await uploadCommand(parseCliArgs(["upload", "--config", p.cfg, "--run", String(ids[0])]), { fetch: s.f, sleep })).toBe(0);
  expect(s.docs[0].run.id).toBe(ids[0]);
});

test("no server configured exits 2", async () => {
  const c = capture();
  const p = project(false);
  seed(p.db, 1);
  expect(await uploadCommand(parseCliArgs(["upload", "--config", p.cfg]), { fetch: fakeServer().f, sleep })).toBe(2);
  expect(c.err.join("\n")).toContain("no server configured");
});

test("unknown run exits 2 and lists ids", async () => {
  const c = capture();
  const p = project();
  const ids = seed(p.db, 2);
  expect(await uploadCommand(parseCliArgs(["upload", "--config", p.cfg, "--run", "999"]), { fetch: fakeServer().f, sleep })).toBe(2);
  expect(c.err.join("\n")).toContain(`Available: ${ids.join(", ")}`);
});

test("server error exits 2", async () => {
  const c = capture();
  const p = project();
  seed(p.db, 1);
  expect(await uploadCommand(parseCliArgs(["upload", "--config", p.cfg]), { fetch: fakeServer(422).f, sleep })).toBe(2);
  expect(c.err.join("\n")).toContain("Upload failed:");
});
