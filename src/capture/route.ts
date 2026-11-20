// src/capture/route.ts
import type { Page } from "playwright-core";

/** True when `hostname` is covered by one of `patterns`: an exact host, or with
 * a leading `*.`, any subdomain of it (not the bare domain, so `*.example.com`
 * can't silently block the site itself). Patterns are validated and
 * lower-cased by the config schema; URL hostnames are already lower-case. */
export function hostBlocked(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((p) =>
    p.startsWith("*.") ? hostname.endsWith(p.slice(1)) : hostname === p);
}

export interface RouteOptions {
  /** Sent on same-origin requests only (see below). */
  headers?: Record<string, string>;
  /** `stabilize.blockHosts`: requests to these are aborted. */
  blockHosts?: readonly string[];
}

/** One request handler for everything momus does to the page's traffic. A
 * single handler, rather than one per concern, so their order is explicit:
 * a blocked request is aborted before any header is added to it.
 *
 * Auth headers (e.g. CF-Access tokens) go to same-origin requests only.
 * Sending them cross-origin triggers CORS preflights on font CDNs that don't
 * expect custom headers, silently blocking web font downloads. */
export async function routeRequests(page: Page, url: string, opts: RouteOptions): Promise<void> {
  const headers = opts.headers && Object.keys(opts.headers).length > 0 ? opts.headers : undefined;
  const blockHosts = opts.blockHosts ?? [];
  if (!headers && blockHosts.length === 0) return;
  const pageOrigin = new URL(url).origin;
  await page.route("**/*", (route, request) => {
    const target = new URL(request.url());
    if (hostBlocked(target.hostname, blockHosts)) return route.abort("blockedbyclient");
    if (headers && target.origin === pageOrigin) {
      return route.continue({ headers: { ...request.headers(), ...headers } });
    }
    return route.continue();
  });
}
