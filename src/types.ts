// src/types.ts
import type { TargetSourceName } from "./targets/target";

/** A bounding box of changed pixels, in the frame both sides share: padding
 * is only ever added right and bottom (ADR-0003), so (x, y) is the same spot
 * in dev, prod, and the diff. */
export interface Region { x: number; y: number; width: number; height: number }

/** An image the page asked for that wasn't there when the screenshot was
 * taken: `failed` (the request errored or the bytes didn't decode) or
 * `pending` (still loading when `stabilize.timeoutMs` ran out). The capture
 * itself succeeded, so this is a warning on it, never an error (ADR-0044). */
export interface UnloadedImage {
  url: string;
  state: "failed" | "pending";
  /** Why, when the network said: "HTTP 504", "net::ERR_CONNECTION_RESET". */
  detail?: string;
}

/** Raw PNG capture for one side of a comparison. */
export interface CaptureResult {
  ok: boolean;
  png?: Uint8Array;
  error?: string;
  /** Rendered images that didn't load (the first 20 found). Absent when all did. */
  unloadedImages?: UnloadedImage[];
  /** A baseline image that rendered differently across two captures
   * (`stabilize.verify`), and where. Set only on baseline reads. */
  unstableRegions?: Region[];
}

/** Result of diffing a captured pair. */
export interface DiffResult {
  width: number;
  height: number;
  diffPixels: number;
  diffScore: number;   // diffPixels / (width*height), 0..1
  diffPng: Uint8Array;
  /** Each side's own size before padding: a is the first image (dev). */
  aWidth: number;
  aHeight: number;
  bWidth: number;
  bHeight: number;
  /** The largest change regions, and how many there were in all. */
  regions: Region[];
  regionCount: number;
}

/** `added`/`removed`: the target is in only one of the live list and the
 * baseline (RFC-0001, ADR-0022). Never an error; never a silent pass.
 * `unstable`: the baseline image itself wasn't repeatable (RFC-0006,
 * ADR-0034), so its diff is shown but doesn't fail the gate. */
export type ComparisonStatus = "ok" | "error" | "added" | "removed" | "unstable";

/** A fully processed comparison ready to persist. */
export interface ComparisonRecord {
  /** Target identity. Omitted fields mean a page: id = label = path, source = pages. */
  targetId?: string;
  source?: TargetSourceName;
  label?: string;
  path: string;
  viewport: number;
  devUrl: string;
  prodUrl: string;
  devImage?: Uint8Array;
  prodImage?: Uint8Array;
  diffImage?: Uint8Array;
  width?: number;
  height?: number;
  diffPixels?: number;
  diffScore?: number;
  /** The failScore that applied (after per-path overrides). Set on compared
   * rows only; stored so an old run re-renders with its own gate. */
  failScore?: number;
  passed?: boolean;
  status: ComparisonStatus;
  error?: string;
  /** Each side's own size before padding; absent on rows from before v5. */
  devWidth?: number;
  devHeight?: number;
  prodWidth?: number;
  prodHeight?: number;
  /** The largest change regions (capped), and how many there were in all. */
  regions?: Region[];
  regionCount?: number;
  /** Where the baseline image changed between two captures (status `unstable`). */
  unstableRegions?: Region[];
  /** How many times dev was re-captured before this outcome (`retries`). */
  retries?: number;
  /** Images that didn't load on each side's capture; absent when all did,
   * and on rows from before v7. Shown as a warning, never gated (ADR-0044). */
  devUnloadedImages?: UnloadedImage[];
  prodUnloadedImages?: UnloadedImage[];
}
