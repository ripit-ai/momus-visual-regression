// tests/report/results.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildResults, resultsJsonSchema, ResultsSchema, RESULTS_SCHEMA_VERSION } from "../../src/report/results";
import type { RunRow } from "../../src/store/db";
import type { ComparisonRecord } from "../../src/types";
import { MOMUS_VERSION } from "../../src/version";

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 7, startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:01:00Z", status: "complete",
  devBaseUrl: "https://dev.example.com", prodBaseUrl: "https://www.example.com", configJson: "{}",
  momusVersion: "1.0.0", engine: "chromium", engineVersion: "131.0", configHash: "abc",
  baselineId: 3,
  baselineJson: JSON.stringify({
    id: 3, createdAt: "2026-10-31T00:00:00Z", prodBaseUrl: "https://www.example.com", browser: "chromium",
    rendering: "pinned", viewports: [375, 1280], stabilize: { settleMs: 500 }, engineVersion: "131.0",
  }),
  allowAdded: false, allowRemoved: false, ci: { commit: "deadbeef", pr: "12" },
  ...over,
});
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const failing: ComparisonRecord = {
  targetId: "/about", source: "pages", label: "/about", path: "/about", viewport: 375,
  devUrl: "https://dev.example.com/about", prodUrl: "https://www.example.com/about",
  devImage: png, prodImage: png, diffImage: png, width: 375, height: 940,
  diffPixels: 3700, diffScore: 0.0106, failScore: 0.01, passed: false, status: "ok",
  devWidth: 375, devHeight: 940, prodWidth: 375, prodHeight: 900,
  regions: [{ x: 8, y: 15, width: 230, height: 69 }], regionCount: 1, retries: 0,
};
const errored: ComparisonRecord = {
  path: "/broken", viewport: 1280, devUrl: "https://dev.example.com/broken",
  prodUrl: "https://www.example.com/broken", status: "error", error: "Timeout 15000ms exceeded",
};

test("the document validates against its own schema", () => {
  const doc = buildResults(run(), [failing, errored]);
  expect(ResultsSchema.safeParse(doc).success).toBe(true);
  expect(doc.schemaVersion).toBe(RESULTS_SCHEMA_VERSION);
  expect(doc.momusVersion).toBe(MOMUS_VERSION);
});

test("verdict and counts follow the run's own gate", () => {
  const doc = buildResults(run(), [failing, errored]);
  expect(doc.verdict).toBe("FAIL");
  expect(doc.summary).toEqual({ total: 2, passed: 0, failed: 1, errored: 1, added: 0, removed: 0, unstable: 0, unloaded: 0 });
  const added: ComparisonRecord = { ...errored, path: "/new", status: "added", error: undefined };
  expect(buildResults(run({ allowAdded: true }), [added]).verdict).toBe("PASS");
  expect(buildResults(run(), [added]).verdict).toBe("FAIL");
});

test("an incomplete run is FAIL even with nothing failing", () => {
  const passing = { ...failing, diffScore: 0, passed: true };
  expect(buildResults(run(), [passing]).verdict).toBe("PASS");
  expect(buildResults(run({ status: "failed" }), [passing]).verdict).toBe("FAIL");
});

test("a comparison carries its outcome, gate, sizes and regions", () => {
  const [c] = buildResults(run(), [failing]).comparisons;
  expect(c).toMatchObject({
    targetId: "/about", source: "pages", label: "/about", path: "/about", viewport: 375,
    status: "ok", outcome: "fail", failsGate: true,
    diffScore: 0.0106, failScore: 0.01, diffPixels: 3700, width: 375, height: 940,
    dev: { url: "https://dev.example.com/about", width: 375, height: 940 },
    prod: { url: "https://www.example.com/about", width: 375, height: 900 },
    regions: [{ x: 8, y: 15, width: 230, height: 69 }], regionCount: 1, retries: 0, error: null,
  });
});

test("unknowns are null, never absent, so the shape is fixed", () => {
  const [c] = buildResults(run(), [errored]).comparisons;
  expect(c).toMatchObject({
    targetId: "/broken", source: "pages", label: "/broken", outcome: "error", failsGate: true,
    diffScore: null, failScore: null, width: null, regions: [], regionCount: null,
    unstableRegions: null, retries: null, error: "Timeout 15000ms exceeded",
    dev: { width: null, height: null, image: null }, prod: { image: null }, diff: { image: null },
  });
  const doc = buildResults(run({ ci: {}, baselineId: undefined, baselineJson: undefined, engineVersion: undefined }), []);
  expect(doc.run.ci).toEqual({ commit: null, branch: null, pr: null });
  expect(doc.run.engineVersion).toBeNull();
  expect(doc.baseline).toBeNull();
});

test("images are addressed by content hash, with a file only when one was written", () => {
  const c = buildResults(run(), [failing], (_r, side) => (side === "diff" ? undefined : `r-images/0001-${side}.png`)).comparisons[0]!;
  expect(c.dev.image).toEqual({ sha256: sha(png), bytes: png.length, file: "r-images/0001-dev.png" });
  expect(c.diff.image).toEqual({ sha256: sha(png), bytes: png.length, file: null });
});

test("run provenance and the baseline identity it diffed against", () => {
  const doc = buildResults(run(), []);
  expect(doc.run).toMatchObject({
    id: 7, status: "complete", devBaseUrl: "https://dev.example.com", momusVersion: "1.0.0",
    engine: "chromium", engineVersion: "131.0", configHash: "abc",
    ci: { commit: "deadbeef", branch: null, pr: "12" },
  });
  expect(doc.gate).toEqual({ allowAdded: false, allowRemoved: false });
  expect(doc.baseline).toMatchObject({ id: 3, rendering: "pinned", viewports: [375, 1280], engineVersion: "131.0" });
});

test("docs/results.schema.json is the published form of ResultsSchema", () => {
  const published = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/results.schema.json"), "utf8"));
  expect(published).toEqual(resultsJsonSchema());
});

test("each side lists the images it was captured without (ADR-0046)", () => {
  const holed: ComparisonRecord = {
    ...failing,
    prodUnloadedImages: [
      { url: "https://img.example.com/hero.jpg", state: "failed", detail: "HTTP 504" },
      { url: "https://img.example.com/late.jpg", state: "pending" },
    ],
  };
  const doc = buildResults(run(), [holed, errored]);
  expect(ResultsSchema.safeParse(doc).success).toBe(true);
  expect(doc.summary.unloaded).toBe(1);
  expect(doc.comparisons[0]!.dev.unloadedImages).toEqual([]);
  expect(doc.comparisons[0]!.prod.unloadedImages).toEqual([
    { url: "https://img.example.com/hero.jpg", state: "failed", detail: "HTTP 504" },
    { url: "https://img.example.com/late.jpg", state: "pending", detail: null },
  ]);
  // A warning: the outcome and the gate are what they were without it.
  expect(doc.comparisons[0]!.outcome).toBe("fail");
  expect(doc.comparisons[1]!.prod.unloadedImages).toEqual([]);
});
