// src/config/redact.ts
import type { ResolvedConfig, SideSetup } from "./schema";
import { canonicalJson } from "../targets/target";

export const REDACTED = "[redacted]";

/** A setup with its secrets replaced: fill values and the storageState file.
 * Selectors, step order and every other value stay, so a changed login flow is
 * still a changed setup (RFC-0004). */
export function redactSetup(s: SideSetup): SideSetup {
  if (s.storageState !== undefined) return { storageState: REDACTED };
  return { steps: s.steps!.map((st) => ("fill" in st ? { fill: [st.fill[0], REDACTED] as [string, string] } : st)) };
}

/** What the baseline gate compares: prod's setup only, since only prod shaped
 * the baseline's pixels. null when there is no setup, which is also what a
 * baseline from before setup existed reads as. */
export function setupIdentity(config: Pick<ResolvedConfig, "setup">): string | null {
  return config.setup ? canonicalJson(redactSetup(config.setup.prod)) : null;
}

/** Header names stay, so a stored config still shows which headers a run
 * sent; the values are where an access token lives (ADR-0045). */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, REDACTED]));
}

/** The config as stored on runs and the snapshot, and as hashed. The .sqlite
 * is often committed, so it never holds a credential or a hash of one. */
export function redactConfig(config: ResolvedConfig): ResolvedConfig {
  const hasHeaders = Object.keys(config.requestHeaders).length > 0;
  if (!config.setup && !hasHeaders) return config;
  const requestHeaders = redactHeaders(config.requestHeaders);
  if (!config.setup) return { ...config, requestHeaders };
  return {
    ...config, requestHeaders,
    setup: { dev: redactSetup(config.setup.dev), prod: redactSetup(config.setup.prod) },
  };
}
