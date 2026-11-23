// src/report/results.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunRow } from "../store/db";
import type { ComparisonRecord, UnloadedImage } from "../types";
import { failsGate } from "../pipeline/verdict";
import { MOMUS_VERSION } from "../version";
import { itemClass, summarize } from "./summary";

/** The `--json` results document (RFC-0008). Part of the 1.x contract
 * (RFC-0009): within a major version fields are only added, and
 * `schemaVersion` changes only when one is removed or changes meaning. */
export const RESULTS_SCHEMA_VERSION = 1;

const int = z.number().int();
const RegionSchema = z.object({ x: int, y: int, width: int, height: int });

/** By content hash, so the 2.0 server can take images separately and dedupe
 * them; `file` is set only when the report wrote the PNG beside itself. */
const ImageSchema = z.object({ sha256: z.string(), bytes: int, file: z.string().nullable() }).nullable();

const UnloadedImageSchema = z.object({
  url: z.string(),
  state: z.enum(["failed", "pending"]),
  /** Why, when the network said, e.g. "HTTP 504". */
  detail: z.string().nullable(),
});

const SideSchema = z.object({
  url: z.string(),
  /** This side's own size before padding; null on rows from before DB v5. */
  width: int.nullable(),
  height: int.nullable(),
  image: ImageSchema,
  /** Images this side was captured without (the first 20 found); empty when all
   * loaded and on rows from before DB v7. A warning, not part of the gate. */
  unloadedImages: z.array(UnloadedImageSchema),
});

const ComparisonSchema = z.object({
  targetId: z.string(),
  source: z.string(),
  label: z.string(),
  path: z.string(),
  /** 0 on a source-level error row, which belongs to no width. */
  viewport: int,
  status: z.enum(["ok", "error", "added", "removed", "unstable"]),
  /** What the report shows: status, with `ok` split into pass and fail. */
  outcome: z.enum(["pass", "fail", "error", "added", "removed", "unstable"]),
  failsGate: z.boolean(),
  diffScore: z.number().nullable(),
  failScore: z.number().nullable(),
  diffPixels: int.nullable(),
  /** The padded size both sides were compared at. */
  width: int.nullable(),
  height: int.nullable(),
  dev: SideSchema,
  prod: SideSchema,
  diff: z.object({ image: ImageSchema }),
  /** The largest change regions (capped); regionCount is how many in all. */
  regions: z.array(RegionSchema),
  regionCount: int.nullable(),
  unstableRegions: z.array(RegionSchema).nullable(),
  retries: int.nullable(),
  error: z.string().nullable(),
});

export const ResultsSchema = z.object({
  schemaVersion: z.literal(RESULTS_SCHEMA_VERSION),
  /** The momus that wrote this document; `run.momusVersion` ran the run. */
  momusVersion: z.string(),
  verdict: z.enum(["PASS", "FAIL"]),
  summary: z.object({
    total: int, passed: int, failed: int, errored: int, added: int, removed: int, unstable: int,
    /** Comparisons with unloaded images on either side; they keep their outcome. */
    unloaded: int,
  }),
  gate: z.object({ allowAdded: z.boolean(), allowRemoved: z.boolean() }),
  run: z.object({
    id: int,
    status: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    devBaseUrl: z.string(),
    prodBaseUrl: z.string(),
    momusVersion: z.string().nullable(),
    engine: z.string().nullable(),
    engineVersion: z.string().nullable(),
    configHash: z.string().nullable(),
    ci: z.object({ commit: z.string().nullable(), branch: z.string().nullable(), pr: z.string().nullable() }),
  }),
  /** The baseline identity recorded on the run: null on runs from before it was. */
  baseline: z.looseObject({
    id: int,
    createdAt: z.string(),
    prodBaseUrl: z.string(),
    browser: z.string(),
    rendering: z.string(),
    viewports: z.array(int),
    engineVersion: z.string().nullable(),
  }).nullable(),
  comparisons: z.array(ComparisonSchema),
});
export type Results = z.infer<typeof ResultsSchema>;

/** The published JSON Schema (docs/results.schema.json). Input mode leaves
 * objects open, so a consumer validating against v1 keeps accepting the
 * fields later 1.x releases add. */
export function resultsJsonSchema(): object {
  return z.toJSONSchema(ResultsSchema, { io: "input" });
}

function unloaded(images: UnloadedImage[] | undefined): z.infer<typeof UnloadedImageSchema>[] {
  return (images ?? []).map((u) => ({ url: u.url, state: u.state, detail: u.detail ?? null }));
}

export type ImageFile = (r: ComparisonRecord, side: "dev" | "prod" | "diff") => string | undefined;

function image(b: Uint8Array | undefined, file: string | undefined): z.infer<typeof ImageSchema> {
  if (!b) return null;
  return { sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length, file: file ?? null };
}

/** One stored run as the results document. Pure: the gate is the one recorded
 * on the run, as for the report, so an old run reads with the verdict it had. */
export function buildResults(run: RunRow, rows: ComparisonRecord[], imageFile: ImageFile = () => undefined): Results {
  const gate = { allowAdded: run.allowAdded, allowRemoved: run.allowRemoved };
  const s = summarize(rows, gate);
  const baseline = run.baselineJson ? JSON.parse(run.baselineJson) : null;
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    momusVersion: MOMUS_VERSION,
    // Same rule as the report header: a run that didn't complete never passes.
    verdict: run.status === "complete" ? s.verdict : "FAIL",
    summary: {
      total: s.total, passed: s.passed, failed: s.failed, errored: s.errored,
      added: s.added, removed: s.removed, unstable: s.unstable, unloaded: s.unloaded,
    },
    gate,
    run: {
      id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null,
      devBaseUrl: run.devBaseUrl, prodBaseUrl: run.prodBaseUrl,
      momusVersion: run.momusVersion ?? null, engine: run.engine ?? null,
      engineVersion: run.engineVersion ?? null, configHash: run.configHash ?? null,
      ci: { commit: run.ci.commit ?? null, branch: run.ci.branch ?? null, pr: run.ci.pr ?? null },
    },
    baseline: baseline && { ...baseline, engineVersion: baseline.engineVersion ?? null },
    comparisons: rows.map((r) => ({
      targetId: r.targetId ?? r.path,
      source: r.source ?? "pages",
      label: r.label ?? r.path,
      path: r.path,
      viewport: r.viewport,
      status: r.status,
      outcome: itemClass(r),
      failsGate: failsGate(r, gate),
      diffScore: r.diffScore ?? null,
      failScore: r.failScore ?? null,
      diffPixels: r.diffPixels ?? null,
      width: r.width ?? null,
      height: r.height ?? null,
      dev: {
        url: r.devUrl, width: r.devWidth ?? null, height: r.devHeight ?? null,
        image: image(r.devImage, imageFile(r, "dev")), unloadedImages: unloaded(r.devUnloadedImages),
      },
      prod: {
        url: r.prodUrl, width: r.prodWidth ?? null, height: r.prodHeight ?? null,
        image: image(r.prodImage, imageFile(r, "prod")), unloadedImages: unloaded(r.prodUnloadedImages),
      },
      diff: { image: image(r.diffImage, imageFile(r, "diff")) },
      regions: r.regions ?? [],
      regionCount: r.regionCount ?? null,
      unstableRegions: r.unstableRegions ?? null,
      retries: r.retries ?? null,
      error: r.error ?? null,
    })),
  };
}
