// src/report/report.ts
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { readComparisons, readRun, type ComparisonRow, type RunRow } from "../store/db";
import { renderReport } from "./template";
import { prepareImages, type ImageSource, type ReportImages } from "./images";
import { buildResults, type ImageFile } from "./results";

/** Render one stored run. The gate comes from the run row, so an old run
 * re-renders with the verdict it had, whatever today's config says. Returns
 * where the images went, so `--json` can point at the same files. */
export async function writeReport(db: Database, runId: number, outPath: string, rows?: ComparisonRow[],
  images: ReportImages = "embed"): Promise<ImageSource> {
  const run = readRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  // Accept pre-read rows so callers who already have them (e.g. for the exit
  // code) don't re-read every BLOB.
  rows ??= readComparisons(db, runId);
  const source = await prepareImages(rows, images, outPath);
  const html = renderReport(
    rows,
    { dev: run.devBaseUrl, prod: run.prodBaseUrl, runId: run.id, startedAt: run.startedAt, status: run.status },
    { allowAdded: run.allowAdded, allowRemoved: run.allowRemoved },
    { images: source },
  );
  await Bun.write(outPath, html); // overwrites (spec §6)
  return source;
}

/** Write the `--json` results document for a run. `images` is what
 * writeReport returned: a linked PNG is named by its path from the working
 * directory; an embedded one has no file and is named by its hash alone. */
export async function writeResults(run: RunRow, rows: ComparisonRow[], jsonPath: string,
  reportPath: string, images: ImageSource): Promise<void> {
  const file: ImageFile = (r, side) => {
    const ref = images(r, side);
    const src = ref?.full ?? ref?.src;
    if (!src || src.startsWith("data:")) return undefined;
    return join(dirname(reportPath), decodeURIComponent(src));
  };
  await Bun.write(jsonPath, JSON.stringify(buildResults(run, rows, file), null, 2) + "\n");
}
