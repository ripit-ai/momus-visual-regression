// tests/fixtures/db/make-fixture.ts
// Writes v<version>.sqlite with the real CLI of a released checkout. Not part
// of the suite.
//   git worktree add /tmp/momus-v1.1.0 v1.1.0
//   ln -s "$PWD/node_modules" /tmp/momus-v1.1.0/node_modules
//   bun tests/fixtures/db/make-fixture.ts /tmp/momus-v1.1.0 1.1.0
//   git worktree remove --force /tmp/momus-v1.1.0   # package.json was stamped
// Needs Chromium installed (`bun run src/cli.ts install-browser`). The
// checkout must be at tag v<version>. Runs record package.json's version, which
// the release workflow stamps from the tag rather than the repo carrying it
// (ADR-0047), so this stamps the throwaway checkout the same way.
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [root, version] = process.argv.slice(2);
if (!root || !version) throw new Error("usage: bun make-fixture.ts <path to a release checkout> <version>");
const tags = (await Bun.$`git -C ${root} tag --points-at HEAD`.text()).split("\n");
if (!tags.includes(`v${version}`)) throw new Error(`${root} is not checked out at tag v${version}`);
const pkgFile = Bun.file(join(root, "package.json"));
await Bun.write(pkgFile, JSON.stringify({ ...(await pkgFile.json()), version }, null, 2) + "\n");

const page = (title: string, bg = "#fff") => `<html><body style="margin:0;background:${bg}"><h1 style="font:20px sans-serif">${title}</h1></body></html>`;
const site = (port: number, pages: Record<string, string>) => Bun.serve({
  port,
  fetch: (req) => {
    const body = pages[new URL(req.url).pathname];
    return body === undefined ? new Response("not found", { status: 404 })
      : new Response(body, { headers: { "content-type": "text/html" } });
  },
});
// Dev differs from prod on /about (a whole-page background change, since a text
// tweak scores under failScore), so the stored run has one pass and one fail.
const prod = site(47801, { "/": page("Home"), "/about": page("About") });
const dev = site(47802, { "/": page("Home"), "/about": page("About us", "#c00") });

const work = mkdtempSync(join(tmpdir(), "momus-fixture-"));
try {
  writeFileSync(join(work, "urls.txt"), "/\n/about\n");
  const config = {
    dev: "http://localhost:47802", prod: "http://localhost:47801", viewports: [375],
    discovery: { urlList: "urls.txt", sitemap: false },
    stabilize: { waitUntil: "load", settleMs: 0 },
  };
  writeFileSync(join(work, "momus.config.json"), JSON.stringify({
    ...config, output: { db: "momus.sqlite", report: "report.html" },
  }));
  // The fixture test diffs the baseline with the config it was captured with.
  writeFileSync(join(import.meta.dir, `v${version}.config.json`), JSON.stringify(config, null, 2) + "\n");
  // Async spawn: spawnSync would block this process's event loop, and with it
  // the two Bun.serve sites the CLI is trying to load.
  const cli = async (...args: string[]) => {
    const p = Bun.spawn(["bun", "run", join(root, "src/cli.ts"), ...args, "--config", "momus.config.json"],
      { cwd: work, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    console.log(out, err);
    return code;
  };
  if (await cli("snapshot") !== 0) throw new Error("snapshot failed");
  if (await cli("run") !== 1) throw new Error("run should exit 1 (one failing page)");
  // Fold the WAL into the main file so one file is the whole fixture.
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(work, "momus.sqlite"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  db.close();
  copyFileSync(join(work, "momus.sqlite"), join(import.meta.dir, `v${version}.sqlite`));
} finally {
  prod.stop(); dev.stop();
  rmSync(work, { recursive: true, force: true });
}
