// tests/capture/unloaded.integration.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { PNG } from "pngjs";
import { launchBrowser, type BrowserEngine } from "../../src/capture/browser";
import { capture, MAX_UNLOADED_IMAGES, type StabilizeOptions } from "../../src/capture/screenshot";
import { launchable, TEST_ENGINES } from "../helpers/engines";

// ADR-0046: a capture says which rendered images weren't there for it.

const STAB: StabilizeOptions = {
  waitUntil: "load", settleMs: 0, timeoutMs: 10000, disableAnimations: true, mask: [], remove: [],
  waitForImages: true, reducedMotion: "reduce", colorScheme: "light",
};

const RED = PNG.sync.write(Object.assign(new PNG({ width: 20, height: 20 }), {
  data: Buffer.alloc(20 * 20 * 4, Buffer.from([255, 0, 0, 255])),
}));
// No width, height or viewBox: an image with no intrinsic size, which loads fine.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="blue"/></svg>`;

// A 1×1 transparent GIF, inline: it always loads.
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const img = (src: string, attrs = "") => `<img src="${src}" width="20" height="20" alt="" ${attrs}>`;
const pages: Record<string, string> = {
  "/ok": `${img("/ok.png")}${img("/sizeless.svg")}<div style="width:20px;height:20px;background:url(/ok.png)"></div>`,
  // Port 1 never answers (Chromium refuses to dial it, the others are refused), so there is no HTTP status at all.
  "/broken": `${img("/ok.png")}${img("/gone.png")}${img("/not-an-image.png")}${img("http://127.0.0.1:1/refused.png")}`,
  // Same URL twice: one image, reported once.
  "/twice": `${img("/gone.png")}${img("/gone.png")}`,
  "/background": `<div style="width:20px;height:20px;background-image:url('/gone.png')"></div>
    <video poster="/gone-poster.png" width="20" height="20"></video>`,
  // What can't change the pixels isn't reported: not rendered, masked, removed, or a beacon.
  "/unseen": `<div style="display:none">${img("/gone.png?hidden")}</div>
    <div class="ad">${img("/gone.png?masked")}</div><div class="widget">${img("/gone.png?removed")}</div>
    <img src="/gone.png?beacon" width="1" height="1" alt="">
    <div style="display:none;background:url(/gone.png?bg)"></div><img alt="no src">`,
  "/pending": `${img("/ok.png")}${img("/never.png")}`,
  "/many": Array.from({ length: MAX_UNLOADED_IMAGES + 5 }, (_, i) => img(`/gone.png?${i}`)).join(""),
  "/element": `<div id="card">${img("/gone.png?inside")}</div>${img("/gone.png?outside")}`,
  // The first URL fails and the page shows something else in its place.
  "/retried": `<img src="/flaky.png" width="20" height="20" alt="" onerror="this.onerror=null;this.src='/flaky.png?retry'">`,
  // What a component library does: swap a failed image for an inline placeholder.
  "/placeholder": `<img src="/gone.png?hero" width="20" height="20" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">`,
  // Known limit: a failed image the page takes away leaves nothing to point at.
  "/dropped": `<img src="/gone.png?dropped" width="20" height="20" alt="" onerror="this.remove()">
    <img src="/gone.png?hidden" width="20" height="20" alt="" onerror="this.style.display='none'">`,
  // capture.element where the element is the image, or carries the background.
  // The CSS size keeps the box in WebKit, which lays a broken image out at 0×0 and can't screenshot that.
  "/element-itself": `<img id="logo" src="/gone.png?logo" width="20" height="20" alt="" style="display:block;width:20px;height:20px">
    <div id="hero" style="width:20px;height:20px;background-image:url('/gone.png?hero-bg')"></div>`,
  // Never requested: a lazy image far outside the viewport, in a box that doesn't scroll.
  "/lazy-clipped": `${img("/ok.png")}<div style="width:20px;height:20px;overflow:hidden;position:relative">
    <img src="/never.png?lazy" loading="lazy" width="20" height="20" alt="" style="position:absolute;left:100000px;top:0"></div>`,
  "/redirected-background": `<div style="width:20px;height:20px;background-image:url('/moved.png')"></div>`,
  // Failed and replaced, but not something momus would have shown anyway.
  "/replaced-unseen": `<div class="ad"><img src="/gone.png?masked" width="20" height="20" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER}'"></div>
    <div class="widget"><img src="/gone.png?removed" width="20" height="20" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER}'"></div>
    <div style="display:none"><img src="/gone.png?hidden" width="20" height="20" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER}'"></div>
    <img src="/gone.png?beacon" width="1" height="1" alt="" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">
    <script>new Image().src = "/gone.png?detached";</script>`,
};

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const png = () => new Response(new Uint8Array(RED), { headers: { "content-type": "image/png" } });
      if (path === "/ok.png") return png();
      if (path === "/sizeless.svg") return new Response(SVG, { headers: { "content-type": "image/svg+xml" } });
      if (path === "/not-an-image.png") return new Response("<html>login</html>", { headers: { "content-type": "image/png" } });
      if (path === "/flaky.png") return new URL(req.url).search ? png() : new Response("busy", { status: 503 });
      if (path === "/never.png") return new Promise<Response>(() => {}); // stop(true) ends it
      if (path === "/moved.png") return Response.redirect("/gone.png?after-redirect", 302);
      const body = pages[path];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(`<!doctype html><html><body style="margin:0">${body}</body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
});
afterAll(async () => { await server.stop(true); });

const url = (p: string) => `http://localhost:${server.port}${p}`;
const names = (res: Awaited<ReturnType<typeof capture>>) =>
  (res.unloadedImages ?? []).map((u) => `${new URL(u.url).pathname}${new URL(u.url).search} ${u.state}`).sort();

for (const engine of TEST_ENGINES) {
  const maybe = (await launchable(engine)) ? test : test.skip;
  const tag = `[${engine}]`;
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  const open = async () => (browser ??= await launchBrowser(engine as BrowserEngine));
  afterAll(async () => { await browser?.close(); });

  maybe(`${tag} a page whose images all loaded reports nothing, a sizeless SVG included`, async () => {
    const res = await capture(await open(), url("/ok"), 375, STAB);
    expect(res.ok).toBe(true);
    expect(res.unloadedImages).toBeUndefined();
  });

  maybe(`${tag} a 404, an undecodable body and a refused connection are each reported as failed`, async () => {
    const res = await capture(await open(), url("/broken"), 375, STAB);
    expect(res.ok).toBe(true); // the capture worked; this is a warning on it
    expect(names(res)).toEqual(["/gone.png failed", "/not-an-image.png failed", "/refused.png failed"]);
    const byPath = new Map(res.unloadedImages!.map((u) => [new URL(u.url).pathname, u]));
    expect(byPath.get("/gone.png")!.detail).toBe("HTTP 404");
    expect(byPath.get("/not-an-image.png")!.detail).toBeUndefined(); // the network was fine; the bytes weren't
    // The engine's own words for it, where it gives any.
    if (engine === "chromium") expect(byPath.get("/refused.png")!.detail).toStartWith("net::ERR_");
  });

  maybe(`${tag} one URL used twice is reported once`, async () => {
    expect(names(await capture(await open(), url("/twice"), 375, STAB))).toEqual(["/gone.png failed"]);
  });

  maybe(`${tag} a failed CSS background and video poster are reported`, async () => {
    const res = await capture(await open(), url("/background"), 375, STAB);
    expect(names(res)).toEqual(["/gone-poster.png failed", "/gone.png failed"]);
  });

  maybe(`${tag} hidden, masked, removed and 1×1 images are not reported`, async () => {
    const res = await capture(await open(), url("/unseen"), 375, { ...STAB, mask: [".ad"], remove: [".widget"] });
    expect(res.ok).toBe(true);
    expect(res.unloadedImages).toBeUndefined();
  });

  maybe(`${tag} an image still loading at the timeout is pending, unless the capture wasn't waiting for images`, async () => {
    const waited = await capture(await open(), url("/pending"), 375, { ...STAB, waitUntil: "domcontentloaded", timeoutMs: 2000 });
    expect(names(waited)).toEqual(["/never.png pending"]);
    const notWaiting = await capture(await open(), url("/pending"), 375,
      { ...STAB, waitUntil: "domcontentloaded", timeoutMs: 2000, waitForImages: false });
    expect(notWaiting.ok).toBe(true);
    expect(notWaiting.unloadedImages).toBeUndefined();
  });

  maybe(`${tag} the list is capped`, async () => {
    const res = await capture(await open(), url("/many"), 375, STAB);
    expect(res.unloadedImages!.length).toBe(MAX_UNLOADED_IMAGES);
  });

  maybe(`${tag} capture.element reports only the images inside it`, async () => {
    const res = await capture(await open(), url("/element"), 375, STAB, false, undefined,
      { recipe: { steps: [], capture: { element: "#card" } } });
    expect(names(res)).toEqual(["/gone.png?inside failed"]);
  });

  maybe(`${tag} a failed image the page replaced is still reported, with what replaced it`, async () => {
    const swapped = await capture(await open(), url("/placeholder"), 375, { ...STAB, settleMs: 300 });
    expect(swapped.ok).toBe(true);
    expect(names(swapped)).toEqual(["/gone.png?hero failed"]);
    // The placeholder is named, cut short: a data: URL can be very long.
    expect(swapped.unloadedImages![0]!.detail).toBe(`HTTP 404; replaced by the page with ${PLACEHOLDER.slice(0, 60)}…`);
    // A retry under another URL looks the same from here: say so and let the reviewer judge.
    const retried = await capture(await open(), url("/retried"), 375, { ...STAB, settleMs: 300 });
    expect(names(retried)).toEqual(["/flaky.png failed"]);
    expect(retried.unloadedImages![0]!.detail).toEndWith("/flaky.png?retry");
  });

  maybe(`${tag} a failed image the page removed or hid is not reported (a known limit)`, async () => {
    const res = await capture(await open(), url("/dropped"), 375, { ...STAB, settleMs: 300 });
    expect(res.ok).toBe(true);
    expect(res.unloadedImages).toBeUndefined();
  });

  maybe(`${tag} capture.element checks the element itself, as an image and as a background`, async () => {
    await open();
    const element = (selector: string) => capture(browser!, url("/element-itself"), 375, STAB, false, undefined,
      { recipe: { steps: [], capture: { element: selector } } });
    expect(names(await element("#logo"))).toEqual(["/gone.png?logo failed"]);
    expect(names(await element("#hero"))).toEqual(["/gone.png?hero-bg failed"]);
  });

  maybe(`${tag} a lazy image the browser never requested is not pending`, async () => {
    const res = await capture(await open(), url("/lazy-clipped"), 375, { ...STAB, waitUntil: "domcontentloaded", timeoutMs: 3000 });
    expect(res.ok).toBe(true);
    expect(res.unloadedImages).toBeUndefined();
  });

  maybe(`${tag} a background that fails after a redirect is reported under the URL the page used`, async () => {
    expect(names(await capture(await open(), url("/redirected-background"), 375, STAB))).toEqual(["/moved.png failed"]);
  });

  maybe(`${tag} replaced images that are masked, removed, hidden, 1×1 or never attached are not reported`, async () => {
    const res = await capture(await open(), url("/replaced-unseen"), 375, { ...STAB, settleMs: 300, mask: [".ad"], remove: [".widget"] });
    expect(res.ok).toBe(true);
    expect(res.unloadedImages).toBeUndefined();
  });
}
