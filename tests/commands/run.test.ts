// tests/commands/run.test.ts
import { test, expect } from "bun:test";
import { resultLine } from "../../src/commands/run";
import type { ComparisonRecord } from "../../src/types";

const row = (status: ComparisonRecord["status"]): ComparisonRecord =>
  ({ path: "/", viewport: 1, devUrl: "d", prodUrl: "p", status });

test("the result line is unchanged when nothing is unstable", () => {
  expect(resultLine("r.html", 3, [row("ok")], 0)).toBe("Wrote r.html for run #3 (1 comparisons). Exit 0.");
});

test("the result line names unstable targets, so CI logs show them", () => {
  expect(resultLine("r.html", 3, [row("ok"), row("unstable"), row("unstable")], 0))
    .toBe("Wrote r.html for run #3 (3 comparisons; 2 unstable, not gated). Exit 0.");
});

test("the result line names comparisons captured without their images", () => {
  const holed: ComparisonRecord = { ...row("ok"), prodUnloadedImages: [{ url: "https://x/a.jpg", state: "failed" }] };
  expect(resultLine("r.html", 3, [row("ok"), holed], 1))
    .toBe("Wrote r.html for run #3 (2 comparisons; 1 with images that did not load). Exit 1.");
});

test("run --upload without a server is a config error before any browser check", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { parseCliArgs } = await import("../../src/cli");
  const { runCommand } = await import("../../src/commands/run");
  const { spyOn } = await import("bun:test");
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-run-upload-"));
  const cfg = join(dir, "momus.config.json");
  writeFileSync(cfg, JSON.stringify({ dev: "https://d.example.com", prod: "https://p.example.com" }));
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCommand(parseCliArgs(["run", "--config", cfg, "--upload"]))).toBe(2);
    expect(err.mock.calls.flat().join("\n")).toContain("--upload needs a server");
  } finally { err.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
