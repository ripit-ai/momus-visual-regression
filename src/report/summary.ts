// src/report/summary.ts
import { failsGate, STRICT_GATE, type GateOptions } from "../pipeline/verdict";
import type { ComparisonRecord, UnloadedImage } from "../types";

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  added: number;
  removed: number;
  /** Shown for review, never in passed/failed or the verdict (ADR-0034). */
  unstable: number;
  /** Comparisons where a side was captured with images that didn't load.
   * A warning on whatever the outcome was, never an outcome (ADR-0044). */
  unloaded: number;
  verdict: "PASS" | "FAIL";
  /** Highest-diffScore ok comparison; omitted when there are no ok comparisons.
   * `path` carries the target's label. */
  worst?: { path: string; viewport: number; pct: string };
  viewports: number[];
}

/** Per-item status class used by both styling and the filter. */
export function itemClass(r: ComparisonRecord): "pass" | "fail" | "error" | "added" | "removed" | "unstable" {
  if (r.status === "error" || r.status === "added" || r.status === "removed" || r.status === "unstable") {
    return r.status;
  }
  return r.passed ? "pass" : "fail";
}

export function summarize(records: ComparisonRecord[], gate: GateOptions = STRICT_GATE): ReportSummary {
  let passed = 0, failed = 0, errored = 0, added = 0, removed = 0, unstable = 0, unloaded = 0;
  let worst: ReportSummary["worst"];
  let worstScore = -1;

  for (const r of records) {
    if (hasUnloadedImages(r)) unloaded++;
    if (r.status === "error") { errored++; continue; }
    if (r.status === "added") { added++; continue; }
    if (r.status === "removed") { removed++; continue; }
    if (r.status === "unstable") { unstable++; continue; }
    if (r.passed) passed++; else failed++;
    const score = r.diffScore ?? 0;
    if (score > worstScore) {
      worstScore = score;
      worst = { path: r.label ?? r.path, viewport: r.viewport, pct: (score * 100).toFixed(2) };
    }
  }

  // Viewport 0 marks a source-level error row, which belongs to no width.
  const viewports = [...new Set(records.map((r) => r.viewport).filter((v) => v > 0))].sort((a, b) => a - b);
  return {
    total: records.length,
    passed, failed, errored, added, removed, unstable, unloaded,
    verdict: records.some((r) => failsGate(r, gate)) ? "FAIL" : "PASS",
    worst, viewports,
  };
}

export function hasUnloadedImages(r: ComparisonRecord): boolean {
  return Boolean(r.devUnloadedImages?.length || r.prodUnloadedImages?.length);
}

/** Said when a baseline is frozen with holes in it: every later run diffs
 * against these captures, and nothing re-captures prod (ADR-0044). null when
 * every image loaded. `retries` is the configured count: with none, the
 * message says the setting exists; with some, they were already spent. */
export function unloadedBaselineWarning(images: Array<{ unloadedImages?: unknown[] }>, retries: number): string | null {
  const count = images.filter((im) => im.unloadedImages?.length).length;
  if (count === 0) return null;
  return `Warning: ${count} baseline ${count === 1 ? "capture has" : "captures have"} images that did not load` +
    `${retries > 0 ? `, after ${retries} ${retries === 1 ? "retry" : "retries"}` : ""}. ` +
    "Diffs against them may show a missing image, not a change. Re-capture with `momus snapshot`" +
    (retries > 0 ? "." : ", or set `retries` to have such captures taken again automatically.");
}

function unloadedSide(side: "dev" | "prod", images: UnloadedImage[] | undefined): string | null {
  if (!images?.length) return null;
  const shown = images.slice(0, 3).map((u) =>
    `${u.url} (${u.state === "pending" ? "still loading" : u.detail ?? "failed to load"})`);
  const more = images.length > shown.length ? `, and ${images.length - shown.length} more` : "";
  return `${side} was captured without ${images.length === 1 ? "1 image" : `${images.length} images`}: ${shown.join(", ")}${more}.`;
}

/** "prod was captured without 2 images: …", one line per side that has any
 * (ADR-0044). Plain text; the caller escapes it. */
export function unloadedNotes(r: ComparisonRecord): string[] {
  return [unloadedSide("dev", r.devUnloadedImages), unloadedSide("prod", r.prodUnloadedImages)]
    .filter((n): n is string => n !== null);
}

/** "dev is 40 px taller than prod", from each side's own size (RFC-0006).
 * null when the sizes match, or aren't known (rows from before v5). */
export function dimensionNote(r: ComparisonRecord): string | null {
  const { devWidth: dw, devHeight: dh, prodWidth: pw, prodHeight: ph } = r;
  if (dw === undefined || dh === undefined || pw === undefined || ph === undefined) return null;
  const parts: string[] = [];
  if (dh !== ph) parts.push(`${Math.abs(dh - ph)} px ${dh > ph ? "taller" : "shorter"}`);
  if (dw !== pw) parts.push(`${Math.abs(dw - pw)} px ${dw > pw ? "wider" : "narrower"}`);
  return parts.length ? `dev is ${parts.join(" and ")} than prod` : null;
}
