// tests/upload/client.test.ts
import { describe, expect, test } from "bun:test";
import { apiUrl, UploadError, uploadResults } from "../../src/upload/client";
import type { Results } from "../../src/report/results";

const hash = (c: string) => c.repeat(64);
const img = (h: string) => ({ sha256: h, bytes: 3, file: null });

function doc(hashes: string[]): Results {
  const side = (h?: string) => ({ url: "u", width: 1, height: 1, image: h ? img(h) : null });
  const comparisons = hashes.map((h, i) => ({ dev: side(h), prod: side(i === 0 ? h : undefined), diff: { image: null } }));
  return { comparisons } as unknown as Results;
}

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
type Script = (c: Call) => Response | Error | Promise<Response | Error>;

function fake(script: Script) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const call = { method: init.method ?? "GET", url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const r = await script(call);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { calls, f };
}
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
const target = { url: "https://srv", project: "site" };
const sleep = () => Promise.resolve();

function happy(missing: string[]): Script {
  return (c) => {
    if (c.url.endsWith("/runs")) return json(201, { runId: 7, url: "https://srv/r/7", missing });
    if (c.method === "PUT") return new Response(null, { status: 201 });
    return json(200, { runId: 7, url: "https://srv/r/7" });
  };
}

describe("uploadResults", () => {
  test("sends the document, then only missing images, then complete", async () => {
    const [a, b] = [hash("a"), hash("b")];
    const bytes = new Uint8Array([1, 2, 3]);
    const { calls, f } = fake(happy([a]));
    const r = await uploadResults(target, doc([a, b]), new Map([[a, bytes], [b, new Uint8Array([9])]]), { fetch: f, sleep });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://srv/api/projects/site/runs",
      `PUT https://srv/api/images/${a}`,
      "POST https://srv/api/runs/7/complete",
    ]);
    expect(calls[1]!.headers["content-type"]).toBe("image/png");
    expect(calls[1]!.body).toEqual(bytes);
    expect(r).toEqual({ runId: 7, url: "https://srv/r/7", sent: 1, skipped: 1 });
  });

  test("puts each distinct hash once", async () => {
    const a = hash("a");
    const { calls, f } = fake(happy([a, a]));
    const r = await uploadResults(target, doc([a, a]), new Map([[a, new Uint8Array([1])]]), { fetch: f, sleep });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(0);
  });

  test("uploads a run with no images", async () => {
    const { calls, f } = fake(happy([]));
    const r = await uploadResults(target, doc([]), new Map(), { fetch: f, sleep });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(calls[1]!.url).toBe("https://srv/api/runs/7/complete");
    expect(r).toMatchObject({ sent: 0, skipped: 0 });
  });

  test("a missing hash with no bytes throws UploadError", async () => {
    const { f } = fake(happy([hash("a")]));
    await expect(uploadResults(target, doc([hash("a")]), new Map(), { fetch: f, sleep })).rejects.toBeInstanceOf(UploadError);
  });

  test("retries a 503 then succeeds; a 400 is not retried", async () => {
    let n = 0;
    const waits: number[] = [];
    const { calls, f } = fake((c) => (c.url.endsWith("/runs") && n++ < 1 ? new Response("down", { status: 503 }) : happy([])(c)));
    await uploadResults(target, doc([]), new Map(), { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([250]);

    const bad = fake(() => new Response("bad slug", { status: 400 }));
    const err = await uploadResults(target, doc([]), new Map(), { fetch: bad.f, sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toBe("POST /api/projects/site/runs: HTTP 400: bad slug");
    expect(bad.calls).toHaveLength(1);
  });

  test("a 409 from complete re-sends the listed hashes once", async () => {
    const a = hash("a");
    let completes = 0;
    const { calls, f } = fake((c) => {
      if (c.url.endsWith("/complete")) return completes++ === 0 ? json(409, { missing: [a] }) : json(200, { runId: 7, url: "u" });
      return happy([])(c);
    });
    const r = await uploadResults(target, doc([a]), new Map([[a, new Uint8Array([1])]]), { fetch: f, sleep });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "PUT", "POST"]);
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(0);
  });

  test("a second 409 throws", async () => {
    const a = hash("a");
    const { f } = fake((c) => (c.url.endsWith("/complete") ? json(409, { missing: [a] }) : happy([])(c)));
    await expect(uploadResults(target, doc([a]), new Map([[a, new Uint8Array([1])]]), { fetch: f, sleep })).rejects.toBeInstanceOf(UploadError);
  });

  test("a network error after the retries throws UploadError", async () => {
    const { calls, f } = fake(() => new Error("ECONNRESET"));
    await expect(uploadResults(target, doc([]), new Map(), { fetch: f, sleep, retries: 3 })).rejects.toBeInstanceOf(UploadError);
    expect(calls).toHaveLength(4);
  });

  test("joins server URLs with a trailing slash or path prefix", async () => {
    expect(apiUrl("https://x/momus/", "/api/runs")).toBe("https://x/momus/api/runs");
    expect(apiUrl("https://x//", "/api/runs")).toBe("https://x/api/runs");
    expect(apiUrl("https://x", "/api/runs")).toBe("https://x/api/runs");
    const { calls, f } = fake(happy([]));
    await uploadResults({ url: "https://x/momus/", project: "site" }, doc([]), new Map(), { fetch: f, sleep });
    expect(calls[0]!.url).toBe("https://x/momus/api/projects/site/runs");
  });

  test("never runs more than 4 PUTs at once", async () => {
    const hs = "abcdefghij".split("").map(hash);
    let inflight = 0, peak = 0;
    const { f } = fake(async (c) => {
      if (c.method !== "PUT") return happy(hs)(c);
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response(null, { status: 201 });
    });
    const imgs = new Map(hs.map((h) => [h, new Uint8Array([1])] as const));
    const r = await uploadResults(target, doc(hs), imgs, { fetch: f, sleep });
    expect(peak).toBe(4);
    expect(r.sent).toBe(10);
  });
});
