// tests/capture/unloaded.test.ts
import { test, expect } from "bun:test";
import { findUnloadedImages, trackImageFailures, MAX_UNLOADED_IMAGES, type ImageRequests } from "../../src/capture/screenshot";

// ADR-0046 without a browser: the network record and the Node side of the
// check. What the page itself reports is in unloaded.integration.test.ts.

type Handler = (arg: any) => void;
function fakePage() {
  const handlers = new Map<string, Handler>();
  const page = { on: (event: string, h: Handler) => { handlers.set(event, h); } } as any;
  return { page, emit: (event: string, arg: unknown) => handlers.get(event)!(arg) };
}
const request = (url: string, over: { type?: string; from?: unknown; failure?: string } = {}) => ({
  url: () => url, resourceType: () => over.type ?? "image",
  redirectedFrom: () => over.from ?? null,
  failure: () => (over.failure ? { errorText: over.failure } : null),
});
const response = (req: ReturnType<typeof request>, status: number) => ({ request: () => req, status: () => status });

test("an HTTP error and a broken connection are failures; an abort is not", () => {
  const { page, emit } = fakePage();
  const { failed } = trackImageFailures(page);
  emit("response", response(request("https://x/gone.png"), 404));
  emit("requestfailed", request("https://x/reset.png", { failure: "net::ERR_CONNECTION_RESET" }));
  emit("requestfailed", request("https://x/swapped.png", { failure: "net::ERR_ABORTED" }));
  emit("requestfailed", request("https://x/cancelled.png", { failure: "NS_BINDING_ABORTED" }));
  emit("response", response(request("https://x/app.js", { type: "script" }), 500));
  expect([...failed]).toEqual([["https://x/gone.png", "HTTP 404"], ["https://x/reset.png", "net::ERR_CONNECTION_RESET"]]);
});

test("a later success for the same URL clears the failure", () => {
  const { page, emit } = fakePage();
  const { failed } = trackImageFailures(page);
  emit("response", response(request("https://x/flaky.png"), 503));
  expect(failed.has("https://x/flaky.png")).toBe(true);
  emit("response", response(request("https://x/flaky.png"), 200));
  expect(failed.size).toBe(0);
});

test("a failure after a redirect is recorded under the URL the page asked for", () => {
  const { page, emit } = fakePage();
  const { failed, inflight } = trackImageFailures(page);
  const first = request("https://x/hero.jpg");
  const hop = request("https://cdn/hero.jpg", { from: first });
  emit("request", first);
  emit("response", response(first, 302)); // a redirect is neither a failure nor a success
  emit("request", hop);
  emit("requestfinished", first);
  expect([...inflight.keys()]).toEqual(["https://x/hero.jpg"]); // the hop is still out
  emit("response", response(hop, 404));
  emit("requestfinished", hop);
  expect([...failed]).toEqual([["https://x/hero.jpg", "HTTP 404"]]);
  expect(inflight.size).toBe(0);
});

test("a request is in flight until it finishes or fails", () => {
  const { page, emit } = fakePage();
  const { inflight } = trackImageFailures(page);
  const slow = request("https://x/slow.png");
  const dead = request("https://x/dead.png", { failure: "net::ERR_TIMED_OUT" });
  emit("request", slow);
  emit("request", dead);
  emit("request", request("https://x/app.js", { type: "script" }));
  expect([...inflight.keys()]).toEqual(["https://x/slow.png", "https://x/dead.png"]);
  emit("requestfailed", dead);
  emit("requestfinished", slow);
  expect(inflight.size).toBe(0);
});

const requests = (failed: Array<[string, string]> = [], inflight: string[] = []): ImageRequests =>
  ({ failed: new Map(failed), inflight: new Map(inflight.map((u) => [u, 1])) });
const pageReturning = (found: unknown, seen: { arg?: any } = {}) =>
  ({ evaluate: async (_fn: unknown, arg: unknown) => { seen.arg = arg; return found; } }) as any;

test("the check hands the page the network record and joins it to what the page found", async () => {
  const seen: { arg?: any } = {};
  const found = [
    { url: "https://x/gone.png", state: "failed" },
    { url: "https://x/hero.jpg", state: "failed", note: "replaced by the page with data:image/png;base64,AAAA" },
    { url: "https://x/not-an-image.png", state: "failed" },
    { url: "https://x/slow.png", state: "pending" },
  ];
  const res = await findUnloadedImages(pageReturning(found, seen),
    requests([["https://x/gone.png", "HTTP 404"], ["https://x/hero.jpg", "HTTP 400"]], ["https://x/slow.png"]), true);
  expect(seen.arg).toMatchObject({
    failedUrls: ["https://x/gone.png", "https://x/hero.jpg"], inflightUrls: ["https://x/slow.png"], reportPending: true, root: null,
  });
  expect(res).toEqual([
    { url: "https://x/gone.png", state: "failed", detail: "HTTP 404" },
    { url: "https://x/hero.jpg", state: "failed", detail: "HTTP 400; replaced by the page with data:image/png;base64,AAAA" },
    { url: "https://x/not-an-image.png", state: "failed" }, // the network was fine: no detail
    { url: "https://x/slow.png", state: "pending" },
  ]);
});

test("the list is capped and a long URL is cut", async () => {
  const many = Array.from({ length: MAX_UNLOADED_IMAGES + 5 }, (_, i) => ({ url: `https://x/${i}.png`, state: "failed" }));
  expect((await findUnloadedImages(pageReturning(many), requests(), true)).length).toBe(MAX_UNLOADED_IMAGES);
  const long = `data:image/png;base64,${"A".repeat(5000)}`;
  const [cut] = await findUnloadedImages(pageReturning([{ url: long, state: "failed" }]), requests(), true);
  expect(cut!.url.length).toBe(500);
});

test("a check that throws reports nothing: it must not fail a capture that worked", async () => {
  const closed = { evaluate: async () => { throw new Error("Target page, context or browser has been closed"); } } as any;
  expect(await findUnloadedImages(closed, requests([["https://x/gone.png", "HTTP 404"]]), true)).toEqual([]);
});
