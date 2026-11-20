// tests/upload/push.test.ts
import { test, expect } from "bun:test";
import { collectImages, uploadAfterRun } from "../../src/upload/push";
import { UploadError } from "../../src/upload/client";
import { sha256Hex } from "../../src/report/results";
import type { ComparisonRecord } from "../../src/types";

const a = new Uint8Array([1, 2, 3]), b = new Uint8Array([4, 5]);
const row = (p: string, o: Partial<ComparisonRecord>): ComparisonRecord =>
  ({ path: p, viewport: 1, devUrl: "d", prodUrl: "p", status: "ok", ...o });

test("collectImages dedupes identical images across rows", () => {
  const m = collectImages([
    row("/1", { devImage: a, prodImage: b, diffImage: new Uint8Array([1, 2, 3]) }),
    row("/2", { prodImage: new Uint8Array([4, 5]) }),
  ]);
  expect([...m.keys()].sort()).toEqual([sha256Hex(a), sha256Hex(b)].sort());
});

for (const code of [0, 1]) {
  test(`uploadAfterRun returns ${code} when the push throws`, async () => {
    const err: string[] = [];
    const got = await uploadAfterRun(code, () => Promise.reject(new UploadError("down")), { out: () => {}, err: (s) => err.push(s) });
    expect(got).toBe(code);
    expect(err.join("")).toContain("upload failed");
    expect(err.join("")).toContain("down");
  });
}

test("uploadAfterRun prints the run URL on success", async () => {
  const out: string[] = [];
  const got = await uploadAfterRun(1, async () => ({ runId: 7, url: "http://s/runs/7", sent: 1, skipped: 0 }), { out: (s) => out.push(s), err: () => {} });
  expect(got).toBe(1);
  expect(out).toEqual(["Uploaded run #7 to http://s/runs/7"]);
});
