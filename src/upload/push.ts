// src/upload/push.ts
import type { ComparisonRecord } from "../types";
import type { RunRow, ComparisonRow } from "../store/db";
import { buildResults, sha256Hex } from "../report/results";
import { uploadResults, type UploadOptions, type UploadResult, type UploadTarget } from "./client";

/** Every distinct image across dev, prod and diff, keyed by content hash, so a
 * prod image repeated across rows is held (and sent) once. */
export function collectImages(rows: ComparisonRecord[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const r of rows) {
    for (const b of [r.devImage, r.prodImage, r.diffImage]) {
      if (b) out.set(sha256Hex(b), b);
    }
  }
  return out;
}

/** No imageFile: `file` is null in the uploaded document, which the server
 * ignores; it fetches images by hash. */
export async function pushRun(
  run: RunRow, rows: ComparisonRow[], target: UploadTarget, opts?: UploadOptions,
): Promise<UploadResult> {
  return uploadResults(target, buildResults(run, rows), collectImages(rows), opts);
}

/** Runs the push after `run` and returns `code` unchanged whatever happens:
 * the server must never change a CI result (ADR-0049). */
export async function uploadAfterRun(
  code: number,
  push: () => Promise<UploadResult>,
  log: { out: (s: string) => void; err: (s: string) => void } = { out: console.log, err: console.error },
): Promise<number> {
  try {
    const r = await push();
    log.out(`Uploaded run #${r.runId} to ${r.url}`);
  } catch (e) {
    log.err(`Warning: upload failed; the run's result is unchanged: ${e instanceof Error ? e.message : String(e)}`);
  }
  return code;
}
