// tests/capture/route.integration.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { launchBrowser } from "../../src/capture/browser";
import { capture } from "../../src/capture/screenshot";
import { runSetup } from "../../src/capture/setup";
import { ConfigSchema } from "../../src/config/schema";
import { launchable } from "../helpers/engines";

const canLaunch = await launchable("chromium");
const maybe = canLaunch ? test : test.skip;
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => { if (canLaunch) browser = await launchBrowser("chromium"); });
afterAll(async () => { await browser?.close(); });

const STAB = { waitUntil: "load" as const, settleMs: 0, timeoutMs: 5000, disableAnimations: true, mask: [], remove: [] };

/** The site at `localhost`, and a "third party" at `127.0.0.1` that counts the
 * requests it receives: a different host name, so it can be blocked on its own. */
function sites() {
  const tracker = { hits: 0 };
  const third = Bun.serve({
    port: 0,
    fetch: () => {
      tracker.hits++;
      return new Response("document.body.dataset.tracked = 'yes';", { headers: { "content-type": "text/javascript" } });
    },
  });
  const site = Bun.serve({
    port: 0,
    fetch: () => new Response(
      `<html><body><h1>hi</h1><script src="http://127.0.0.1:${third.port}/t.js"></script></body></html>`,
      { headers: { "content-type": "text/html" } }),
  });
  return { tracker, url: `http://localhost:${site.port}/`, stop: () => { site.stop(); third.stop(); } };
}

maybe("a blocked host is never contacted, and the page is still captured", async () => {
  const s = sites();
  try {
    const res = await capture(browser, s.url, 1280, { ...STAB, blockHosts: ["127.0.0.1"] });
    expect(res.ok).toBe(true);
    expect(s.tracker.hits).toBe(0);
  } finally { s.stop(); }
});

maybe("without blockHosts the same third party is contacted", async () => {
  // Guards the test above: it would pass vacuously if the script never loaded.
  const s = sites();
  try {
    const res = await capture(browser, s.url, 1280, STAB);
    expect(res.ok).toBe(true);
    expect(s.tracker.hits).toBe(1);
  } finally { s.stop(); }
});

maybe("setup blocks the same hosts", async () => {
  const s = sites();
  try {
    const config = ConfigSchema.parse({
      dev: s.url, prod: s.url, viewports: [1280],
      stabilize: { timeoutMs: 5000, blockHosts: ["127.0.0.1"] },
      setup: { steps: [{ goto: "/" }, { waitFor: "h1" }] },
    });
    await runSetup(browser, "prod", config);
    expect(s.tracker.hits).toBe(0);
  } finally { s.stop(); }
});
