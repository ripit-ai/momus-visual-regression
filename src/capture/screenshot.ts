// src/capture/screenshot.ts
import type { Browser, BrowserContext, ElementHandle, Page, Request } from "playwright-core";
import { newContext, type StorageState } from "./browser";
import { runSteps } from "./steps";
import { disableAnimationsCss, maskCss } from "./stabilize";
import { RecipeSchema, type CaptureRecipe } from "../config/schema";
import type { Recipe } from "../targets/target";
import type { CaptureResult, UnloadedImage } from "../types";

export interface StabilizeOptions {
  waitUntil: "load" | "domcontentloaded" | "networkidle";
  settleMs: number;
  timeoutMs: number;
  disableAnimations: boolean;
  mask: string[];
  remove: string[];
  // RFC-0006. Optional because a baseline from before it has none of them;
  // the gate reads each absence as the behavior that baseline was captured with.
  waitForImages?: boolean;
  /** ISO date that `Date` is pinned to; unset = the real clock. */
  clock?: string;
  reducedMotion?: "reduce" | "no-preference";
  colorScheme?: "light" | "dark" | "no-preference";
  /** Capture each baseline image twice (snapshot only). Not a capture setting. */
  verify?: boolean;
}

/** Remove every element matching `selectors` from the DOM before capture, so
 * their layout space collapses (unlike `mask`, which only hides). Searches the
 * document AND every open shadow root (so web-component / portal UI like the
 * Next.js dev indicator, which lives in a shadow root, is reachable —
 * `document.querySelectorAll` alone does not pierce shadow DOM). Invalid
 * selectors are skipped, never aborting the capture. Closed shadow roots are
 * unreachable by any script and are left as-is. */
export async function removeSelectors(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length === 0) return;
  await page.evaluate((sels) => {
    // Collect the document plus every open shadow root, recursively.
    const roots: (Document | ShadowRoot)[] = [];
    const collect = (root: Document | ShadowRoot) => {
      roots.push(root);
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) collect(el.shadowRoot);
      });
    };
    collect(document);

    for (const sel of sels) {
      for (const root of roots) {
        try {
          root.querySelectorAll(sel).forEach((el) => el.remove());
        } catch {
          /* ignore an invalid selector rather than aborting the capture */
        }
      }
    }
  }, selectors);
}

/** Scroll the page top-to-bottom in steps, pausing so lazy content triggers —
 * IntersectionObserver-based lazy loading only fires when elements enter the
 * viewport, and neither a static load nor a full-page screenshot scrolls — then
 * return to the top. Bounded by `maxMs` so infinite-scroll pages can't hang the
 * capture: counted in ~100 ms steps, not by `Date.now()`, which
 * `stabilize.clock` freezes. `scroll-behavior` is forced to `auto` so a site's
 * smooth-scroll CSS doesn't turn each step into a slow animation. */
export async function autoScroll(page: Page, maxMs: number): Promise<void> {
  await page.evaluate(async (budget) => {
    const doc = document.documentElement;
    const prevBehavior = doc.style.scrollBehavior;
    doc.style.scrollBehavior = "auto";
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let prevY = -1;
    for (let step = Math.ceil(budget / 100); step > 0; step--) {
      window.scrollBy(0, Math.floor(window.innerHeight * 0.8));
      await sleep(100);
      const y = window.scrollY;
      if (y === prevY) break; // can't advance further (bottom or stuck)
      prevY = y;
      if (y + window.innerHeight >= doc.scrollHeight) {
        await sleep(150); // let the last viewport's lazy content start loading
        break;
      }
    }
    window.scrollTo(0, 0);
    doc.style.scrollBehavior = prevBehavior;
  }, maxMs);
}

/** Scope auth headers (e.g. CF-Access tokens) to same-origin requests only.
 * Sending them cross-origin triggers CORS preflights on font CDNs that don't
 * expect custom headers, silently blocking web font downloads. */
export async function scopeRequestHeaders(page: Page, url: string, headers?: Record<string, string>): Promise<void> {
  if (!headers || Object.keys(headers).length === 0) return;
  const pageOrigin = new URL(url).origin;
  await page.route("**/*", (route, request) => {
    if (new URL(request.url()).origin === pageOrigin) {
      route.continue({ headers: { ...request.headers(), ...headers } });
    } else {
      route.continue();
    }
  });
}

/** Wait until every `<img>` has loaded (or failed) and decoded, bounded by
 * `maxMs`. Needed after autoScroll: an image it triggered starts loading after
 * the page already reached networkidle, and Playwright's load states are
 * sticky, so waiting for networkidle again returns at once. The bound is
 * inside the page, so the evaluate always settles rather than being left
 * pending on an image that never loads. */
export async function waitForImages(page: Page, maxMs: number): Promise<void> {
  if (maxMs <= 0) return;
  await page.evaluate((budget) => Promise.race([
    // An image that isn't rendered (display:none, or inside it) can't change
    // the pixels, and a lazy one there is never even requested: waiting on it
    // would spend the whole budget on every capture.
    Promise.all(Array.from(document.images).filter((img) => img.getClientRects().length > 0).map(async (img) => {
      if (!img.complete) {
        await new Promise((r) => {
          img.addEventListener("load", r, { once: true });
          img.addEventListener("error", r, { once: true });
        });
      }
      // A broken image rejects decode(); it's as rendered as it will get.
      await img.decode().catch(() => {});
    })),
    // Timers keep running under stabilize.clock (setFixedTime pins only Date).
    new Promise((r) => setTimeout(r, budget)),
  ]), maxMs);
}

/** What the network did with the page's image requests. */
export interface ImageRequests {
  /** Requests that failed and didn't later succeed, by URL, with the reason. */
  failed: Map<string, string>;
  /** Requests still without an answer, by URL. */
  inflight: Map<string, number>;
}

/** Watch the page's image requests: which failed (an HTTP error, or a
 * connection that broke) and which are still in flight. Keyed by the URL the
 * page asked for, which after a redirect is the first hop's: that is the URL
 * the `<img>` or the stylesheet carries. An aborted request is the page
 * changing its mind (a swapped `src`, a cancelled lazy load), not a failure,
 * and a later success for the same URL (the page retried) clears it.
 * Listening starts before navigation, so nothing is missed. */
export function trackImageFailures(page: Page): ImageRequests {
  const failed = new Map<string, string>();
  const inflight = new Map<string, number>();
  const asked = (req: Request): string => {
    let first = req;
    for (let prev = first.redirectedFrom(); prev; prev = first.redirectedFrom()) first = prev;
    return first.url();
  };
  const settle = (url: string) => {
    const n = (inflight.get(url) ?? 0) - 1;
    if (n > 0) inflight.set(url, n); else inflight.delete(url);
  };
  // Every hop of a redirect is a request that also finishes, so the count
  // reaches zero only when the last one has.
  page.on("request", (req) => {
    if (req.resourceType() === "image") inflight.set(asked(req), (inflight.get(asked(req)) ?? 0) + 1);
  });
  page.on("requestfinished", (req) => {
    if (req.resourceType() === "image") settle(asked(req));
  });
  page.on("response", (res) => {
    if (res.request().resourceType() !== "image") return;
    const url = asked(res.request());
    if (res.status() >= 400) failed.set(url, `HTTP ${res.status()}`);
    else if (res.status() < 300) failed.delete(url);
  });
  page.on("requestfailed", (req) => {
    if (req.resourceType() !== "image") return;
    settle(asked(req));
    const why = req.failure()?.errorText ?? "request failed";
    if (/abort|cancel/i.test(why)) return;
    failed.set(asked(req), why);
  });
  return { failed, inflight };
}

/** Where the page keeps the `<img>` load errors it saw. */
const IMAGE_ERRORS = "__momusImageErrors";

/** Remember every rendered `<img>` whose load errored, with the URL that
 * failed. A page may answer a failed image by swapping in a placeholder; by
 * screenshot time the DOM then shows nothing broken, and the picture is still
 * missing (ADR-0044). `error` doesn't bubble, so the listener captures it; an
 * image never attached to the document (a `new Image()` beacon) doesn't reach
 * it at all. Installed before navigation, so server-rendered images are
 * covered. */
export async function recordImageErrors(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as unknown as Record<string, Array<{ el: HTMLImageElement; url: string }>>;
    const log = (w[key] ??= []);
    document.addEventListener("error", (e) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement) || log.length >= 200) return;
      const url = el.currentSrc || el.src;
      if (url && el.getClientRects().length > 0) log.push({ el, url });
    }, true);
  }, IMAGE_ERRORS);
}

/** The most unloaded images kept per capture; a page of 500 broken thumbnails
 * says the same thing as its first 20. */
export const MAX_UNLOADED_IMAGES = 20;

/** The rendered images that aren't there for the screenshot (ADR-0044).
 * waitForImages treats a failed image as settled, which is right for the
 * wait and wrong for the result: the capture looks fine and shows a hole.
 *
 * An `<img>` says so itself. Complete with no pixels and a decode() that
 * rejects is `failed`; decode() is what tells a broken image from an SVG with
 * no intrinsic size, which also reports 0×0. Not complete with its request
 * still in flight is `pending`, reported only when `reportPending`, i.e. the
 * capture did wait for images. A lazy image the browser never asked for (a
 * slide a carousel keeps clipped) is not complete either, and is neither.
 *
 * An `<img>` that errored and now shows a different URL is `failed` too
 * (recordImageErrors): what the page put in its place is a placeholder, or a
 * retry momus can't tell from one.
 *
 * A CSS background or a video poster has no state to read, so for those the
 * network record is the only witness, and the DOM is walked for them only
 * when that record has something in it.
 *
 * Skipped: images that aren't rendered or are hidden (`stabilize.mask`), since
 * they can't change the pixels, and images declared 1×1 or smaller, which are
 * tracking beacons. `root` narrows the search to a `capture.element`, the
 * element itself included. Not seen at all: images inside shadow roots and
 * iframes, and CSS images other than `background-image` (docs/config.md lists
 * the limits). Never throws: a failed check must not fail a capture that
 * worked. */
export async function findUnloadedImages(
  page: Page, requests: ImageRequests, reportPending: boolean, root?: ElementHandle | null,
): Promise<UnloadedImage[]> {
  try {
    const { failed, inflight } = requests;
    const found = await page.evaluate(async ({ failedUrls, inflightUrls, reportPending, root, errorsKey }) => {
      const within = <E extends Element>(selector: string): E[] => {
        const top = root as Element | null;
        const inside = Array.from((top ?? document).querySelectorAll<E>(selector));
        return top?.matches(selector) ? [top as E, ...inside] : inside;
      };
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const out: Array<{ url: string; state: "failed" | "pending"; note?: string }> = [];
      const seen = new Set<string>();
      const add = (url: string, state: "failed" | "pending", note?: string) => {
        if (seen.has(url)) return;
        seen.add(url);
        out.push({ url, state, ...(note ? { note } : {}) });
      };
      // The declared size, not img.width: WebKit lays a broken image out at 0×0.
      const beacon = (img: HTMLImageElement) => {
        const declared = (name: string) => Number.parseInt(img.getAttribute(name) ?? "", 10);
        return declared("width") <= 1 && declared("height") <= 1;
      };
      const loading = new Set(inflightUrls);
      // Each decode() is bounded, so one that never settles can't hang the
      // capture, and they run together, so many of them cost one bound.
      const images = within<HTMLImageElement>("img").filter((img) => (img.currentSrc || img.src) && visible(img) && !beacon(img));
      const states = await Promise.all(images.map(async (img): Promise<"failed" | "pending" | null> => {
        if (!img.complete) return reportPending && loading.has(img.currentSrc || img.src) ? "pending" : null;
        if (img.naturalWidth > 0) return null;
        const broken = await Promise.race([
          img.decode().then(() => false, () => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
        ]);
        return broken ? "failed" : null;
      }));
      images.forEach((img, i) => { if (states[i]) add(img.currentSrc || img.src, states[i]!); });
      // Images whose load errored and that now show something else: nothing
      // in the DOM is broken any more, but the image the page asked for is
      // not what is on screen.
      const top = root as Element | null;
      const errored = (window as unknown as Record<string, Array<{ el: HTMLImageElement; url: string }>>)[errorsKey] ?? [];
      for (const { el, url } of errored) {
        if (seen.has(url) || !el.isConnected || (top && !top.contains(el)) || !visible(el) || beacon(el)) continue;
        const now = el.currentSrc || el.src;
        // Same URL: judged above, still broken or loaded on a retry.
        if (now === url) continue;
        add(url, "failed", `replaced by the page with ${now.length > 60 ? `${now.slice(0, 60)}…` : now}`);
      }
      if (failedUrls.length > 0) {
        const failedSet = new Set(failedUrls);
        const addFailed = (url: string) => { if (failedSet.has(url)) add(url, "failed"); };
        for (const el of within<Element>("*")) {
          const poster = el instanceof HTMLVideoElement ? el.poster : "";
          const bg = getComputedStyle(el).backgroundImage;
          if ((!poster && (!bg || bg === "none")) || !visible(el)) continue;
          if (poster) addFailed(poster);
          for (const m of bg.matchAll(/url\((["']?)(.*?)\1\)/g)) addFailed(m[2]!);
        }
      }
      return out;
    }, { failedUrls: [...failed.keys()], inflightUrls: [...inflight.keys()], reportPending, root: root ?? null, errorsKey: IMAGE_ERRORS });
    return found.slice(0, MAX_UNLOADED_IMAGES).map((f) => {
      const detail = [failed.get(f.url), f.note].filter(Boolean).join("; ");
      // A data: URL can be megabytes; the start of it identifies it well enough.
      return { url: f.url.slice(0, 500), state: f.state, ...(detail ? { detail } : {}) };
    });
  } catch {
    return [];
  }
}

export interface CaptureExtras {
  /** A target's recipe (RFC-0004). Validated here, so a malformed stored
   * recipe becomes an error row instead of a throw. */
  recipe?: Recipe;
  /** The side's session from setup, loaded into the context. */
  storageState?: StorageState;
}

/** Capture a PNG for one url at one viewport width: the full page, or with an
 * optional recipe, its steps run first and `capture.element` screenshotted. Never throws;
 * returns { ok:false, error } on failure so one bad page can't abort a run. */
export async function capture(
  browser: Browser,
  url: string,
  viewportWidth: number,
  opts: StabilizeOptions,
  insecure = false,
  requestHeaders?: Record<string, string>,
  extras: CaptureExtras = {},
): Promise<CaptureResult> {
  let recipe: CaptureRecipe | undefined;
  if (extras.recipe !== undefined) {
    const parsed = RecipeSchema.safeParse(extras.recipe);
    if (!parsed.success) return { ok: false, error: `invalid recipe: ${parsed.error.issues[0]?.message ?? "unknown"}` };
    recipe = parsed.data;
  }
  // Single shared deadline so nav + settle together honor one `timeoutMs` cap
  // (spec §6), rather than allowing up to 2× the configured budget.
  const deadline = Date.now() + opts.timeoutMs;
  // Declared before the try so context/page acquisition happens INSIDE it: if
  // the browser crashed/closed, newContext/newPage reject and we return
  // { ok:false } rather than throwing (upholds "one bad page can't abort a run").
  let context: BrowserContext | undefined;
  try {
    context = await newContext(browser, viewportWidth, insecure, extras.storageState,
      { reducedMotion: opts.reducedMotion, colorScheme: opts.colorScheme });
    const page = await context.newPage();
    const imageRequests = trackImageFailures(page);
    await recordImageErrors(page);
    await scopeRequestHeaders(page, url, requestHeaders);
    // Before navigation, so the page's first script already sees the pinned
    // date. setFixedTime leaves timers running: settle waits still elapse.
    if (opts.clock !== undefined) await page.clock.setFixedTime(new Date(opts.clock));
    // Hard navigation: a genuine load failure (DNS, connection refused, nav
    // timeout) throws here and is recorded as an error (spec §7).
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    // An HTTP error (404/500/…) does NOT throw in Playwright — it returns a
    // response. Treat a non-2xx as a load failure per spec §7. Note: page.goto
    // can also return null (same-document / about:blank / some cached navs);
    // null is treated as success (no HTTP status to reject on).
    if (response && !response.ok()) {
      return { ok: false, error: `HTTP ${response.status()} at ${url}` };
    }
    // Soft settle: if the page loaded but `load`/`networkidle` never settles
    // (long-polling, beacons), capture anyway rather than erroring (spec §7).
    // Use the REMAINING budget; skip if already exhausted (never pass 0 —
    // Playwright treats timeout:0 as "no timeout" / wait forever).
    const remaining = deadline - Date.now();
    if (opts.waitUntil !== "domcontentloaded" && remaining > 0) {
      try {
        await page.waitForLoadState(opts.waitUntil, { timeout: remaining });
      } catch {
        // network never went idle within budget — proceed to capture
      }
    }
    // Trigger below-the-fold lazy loading (IntersectionObserver + native
    // loading="lazy") by scrolling through the page, then let the newly
    // requested resources settle. Bounded by the remaining budget so an
    // infinite-scroll page can't hang the capture.
    let budget = deadline - Date.now();
    if (budget > 0) {
      await autoScroll(page, budget);
      budget = deadline - Date.now();
      if (budget > 0) {
        try {
          await page.waitForLoadState("networkidle", { timeout: budget });
        } catch {
          // scroll-triggered loads didn't fully idle within budget — capture anyway
        }
      }
    }
    const fontBudget = Math.min(5000, Math.max(0, deadline - Date.now()));
    if (fontBudget > 0) {
      await Promise.race([
        page.evaluate(() => document.fonts.ready),
        page.waitForTimeout(fontBudget),
      ]);
    }
    if (opts.waitForImages) await waitForImages(page, deadline - Date.now());

    // Animations off before steps, so a transition a step triggers ends at
    // once; mask and remove after them, so steps can reach anything and
    // whatever they reveal is still masked (ADR-0029).
    if (opts.disableAnimations) await page.addStyleTag({ content: disableAnimationsCss() });
    if (recipe) await runSteps(page, recipe.steps, { timeoutMs: opts.timeoutMs });
    const mask = maskCss(opts.mask);
    if (mask) await page.addStyleTag({ content: mask });
    await removeSelectors(page, opts.remove);
    if (opts.settleMs > 0) await page.waitForTimeout(opts.settleMs);
    // Last, so it sees the page the screenshot sees: after the settle, and
    // with masked and removed elements already out of the picture.
    const unloaded = async (root?: ElementHandle | null) => {
      const images = await findUnloadedImages(page, imageRequests, opts.waitForImages === true, root);
      return images.length > 0 ? { unloadedImages: images } : {};
    };
    if (recipe?.capture) {
      const el = page.locator(recipe.capture.element).first();
      if ((await el.count()) === 0) {
        return { ok: false, error: `capture.element ${JSON.stringify(recipe.capture.element)} matched nothing` };
      }
      // The warning must not cost the capture: no handle, no check.
      const handle = await el.elementHandle({ timeout: opts.timeoutMs }).catch(() => null);
      const warnings = handle ? await unloaded(handle) : {};
      return { ok: true, png: new Uint8Array(await el.screenshot({ type: "png", timeout: opts.timeoutMs })), ...warnings };
    }
    const warnings = await unloaded();
    const png = await page.screenshot({ fullPage: true, type: "png" });
    return { ok: true, png: new Uint8Array(png), ...warnings };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await context?.close();
  }
}
