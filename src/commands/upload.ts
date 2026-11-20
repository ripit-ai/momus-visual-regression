// src/commands/upload.ts
import { existsSync } from "node:fs";
import type { ParsedCli } from "../cli";
import { loadConfigFile, resolveConfig } from "../config/load";
import { openDb, latestRunId, listRunIds, readRun, readComparisons } from "../store/db";
import { pushRun } from "../upload/push";
import { UploadError, type UploadOptions } from "../upload/client";
import type { ResolvedConfig } from "../config/schema";

/** Send a stored run to the server. DB handling mirrors `report`: never
 * creates output.db, never touches a browser. Exit 0 on success, 2 otherwise. */
export async function uploadCommand(parsed: ParsedCli, opts?: UploadOptions): Promise<number> {
  const configPath = parsed.configPath ?? `${process.cwd()}/momus.config.ts`;
  let config: ResolvedConfig;
  try {
    config = resolveConfig(await loadConfigFile(configPath), parsed.overrides);
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (!config.server) {
    console.error("Config error: no server configured: set server.url and server.project, or pass --server and --project");
    return 2;
  }
  if (!existsSync(config.output.db)) {
    console.error(`No database at ${config.output.db}. Run \`momus run\` first.`);
    return 2;
  }
  let db;
  try {
    db = openDb(config.output.db);
  } catch (err) {
    console.error(`Database error: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  try {
    const runId = parsed.runId ?? latestRunId(db);
    if (runId === null) {
      console.error(`No runs in ${config.output.db}. Run \`momus run\` first.`);
      return 2;
    }
    const run = readRun(db, runId);
    if (!run) {
      console.error(`Run ${runId} not found in ${config.output.db}. Available: ${listRunIds(db).join(", ")}.`);
      return 2;
    }
    const rows = readComparisons(db, runId);
    try {
      const r = await pushRun(run, rows, config.server, opts);
      console.log(r.url);
      return 0;
    } catch (err) {
      if (err instanceof UploadError) {
        console.error(`Upload failed: ${err.message}`);
        return 2;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}
