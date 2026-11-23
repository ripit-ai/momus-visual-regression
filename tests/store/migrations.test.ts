// tests/store/migrations.test.ts
import { test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb as openDbRaw } from "../../src/store/db";
import { MIGRATIONS, LATEST_VERSION, migrate, userVersion, scrubRequestHeaders, DbTooNewError, type Migration } from "../../src/store/migrations";

let dir = "";
const opened: Database[] = [];
const track = (d: Database): Database => { opened.push(d); return d; };
const openDb = (path: string): Database => track(openDbRaw(path));
afterEach(() => {
  for (const d of opened.splice(0)) { try { d.close(); } catch { /* already closed */ } }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});
function tmpFile(name = "t.sqlite"): string {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-migrations-"));
  return join(dir, name);
}
const tables = (db: Database): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

test("migration versions are 1..N with no gaps", () => {
  expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  expect(LATEST_VERSION).toBe(MIGRATIONS.length);
});

test("a fresh DB is created through the same chain and lands on the latest version", () => {
  const db = openDb(":memory:");
  expect(userVersion(db)).toBe(LATEST_VERSION);
  expect(tables(db)).toEqual(["baseline_images", "comparisons", "runs", "snapshot"]);
});

test("a pre-versioning DB (user_version 0, tables present) is migrated forward", () => {
  const file = tmpFile();
  const raw = new Database(file, { create: true });
  raw.exec(`CREATE TABLE snapshot (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, prod_base_url TEXT NOT NULL,
    viewports_json TEXT NOT NULL, stabilize_json TEXT NOT NULL, config_json TEXT NOT NULL);`);
  raw.close();
  const db = openDb(file);
  expect(userVersion(db)).toBe(LATEST_VERSION);
  expect(tables(db)).toEqual(["baseline_images", "comparisons", "runs", "snapshot"]);
});

test("opening twice is a no-op the second time", () => {
  const file = tmpFile();
  openDb(file).close();
  const db = openDb(file);
  expect(userVersion(db)).toBe(LATEST_VERSION);
});

test("a DB from a newer momus is refused and its bytes are untouched", () => {
  const file = tmpFile();
  const raw = new Database(file, { create: true });
  raw.exec("CREATE TABLE future (x);");
  raw.exec(`PRAGMA user_version = ${LATEST_VERSION + 1};`);
  raw.close();
  const before = readFileSync(file);
  expect(() => openDb(file)).toThrow(DbTooNewError);
  expect(() => openDb(file)).toThrow(/newer momus/);
  expect(readFileSync(file).equals(before)).toBe(true);
  expect(() => readFileSync(`${file}-wal`)).toThrow(); // never switched to WAL
});

test("a failing migration rolls back its own step and keeps earlier ones", () => {
  const db = track(new Database(":memory:"));
  const steps: Migration[] = [
    { version: 1, up: (d) => d.exec("CREATE TABLE a (x);") },
    { version: 2, up: (d) => { d.exec("CREATE TABLE b (x);"); throw new Error("boom"); } },
  ];
  expect(() => migrate(db, steps)).toThrow("boom");
  expect(userVersion(db)).toBe(1);
  expect(tables(db)).toEqual(["a"]);
});

test("migrate refuses a version newer than the list it was given", () => {
  const db = track(new Database(":memory:"));
  db.exec("PRAGMA user_version = 9;");
  expect(() => migrate(db, MIGRATIONS)).toThrow(DbTooNewError);
});

test("v3: run and baseline ids are never reused, even after deleting the newest", () => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO runs (started_at, dev_base_url, prod_base_url, config_json, status) VALUES ('s','d','p','{}','complete')`);
  db.exec("DELETE FROM runs");
  db.exec(`INSERT INTO runs (started_at, dev_base_url, prod_base_url, config_json, status) VALUES ('s','d','p','{}','complete')`);
  expect((db.query("SELECT id FROM runs").get() as { id: number }).id).toBe(2);
});

test("v3: the file uses incremental auto-vacuum, fresh or migrated", () => {
  const fresh = openDb(tmpFile("fresh.sqlite"));
  expect((fresh.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
});

test("v3: a pre-v3 run keeps its id and reads with empty provenance", () => {
  const file = tmpFile();
  const raw = track(new Database(file, { create: true }));
  migrate(raw, MIGRATIONS.slice(0, 2));
  raw.exec(`INSERT INTO runs (id, started_at, dev_base_url, prod_base_url, config_json, status) VALUES (7,'s','d','p','{}','complete')`);
  raw.close();
  const db = openDb(file);
  expect((db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(2);
  const row = db.query("SELECT id, momus_version, allow_added FROM runs").get() as Record<string, unknown>;
  expect(row).toEqual({ id: 7, momus_version: null, allow_added: null });
  db.exec(`INSERT INTO runs (started_at, dev_base_url, prod_base_url, config_json, status) VALUES ('s','d','p','{}','complete')`);
  expect((db.query("SELECT max(id) AS id FROM runs").get() as { id: number }).id).toBe(8);
});

test("v3: allow_added/allow_removed are backfilled from config_json; absent or invalid stays NULL", () => {
  const file = tmpFile();
  const raw = track(new Database(file, { create: true }));
  migrate(raw, MIGRATIONS.slice(0, 2));
  const ins = raw.query(`INSERT INTO runs (id, started_at, dev_base_url, prod_base_url, config_json, status) VALUES (?, 's','d','p',?,'complete')`);
  ins.run(1, JSON.stringify({ diff: { allowAdded: true, allowRemoved: false } }));
  ins.run(2, "{}");
  ins.run(3, "not json");
  raw.close();
  const db = openDb(file);
  const get = (id: number) => db.query("SELECT allow_added, allow_removed FROM runs WHERE id = ?").get(id);
  expect(get(1)).toEqual({ allow_added: 1, allow_removed: 0 });
  expect(get(2)).toEqual({ allow_added: null, allow_removed: null });
  expect(get(3)).toEqual({ allow_added: null, allow_removed: null });
});

test("v4: snapshot gains setup_json; a v3 snapshot row migrates with NULL", () => {
  const fresh = openDb(":memory:");
  const cols = (fresh.query("PRAGMA table_info(snapshot)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols).toContain("setup_json");

  const file = tmpFile();
  const raw = track(new Database(file, { create: true }));
  migrate(raw, MIGRATIONS.slice(0, 3));
  raw.exec(`INSERT INTO snapshot (created_at, prod_base_url, viewports_json, stabilize_json, config_json) VALUES ('t','p','[]','{}','{}')`);
  raw.close();
  const db = openDb(file);
  expect(userVersion(db)).toBe(LATEST_VERSION);
  expect(db.query("SELECT created_at, setup_json FROM snapshot").get()).toEqual({ created_at: "t", setup_json: null });
});

test("v5 adds RFC-0006's columns", () => {
  const db = openDb(":memory:");
  const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols("snapshot")).toContain("rendering");
  expect(cols("baseline_images")).toContain("unstable_regions_json");
  for (const c of ["dev_width", "dev_height", "prod_width", "prod_height", "region_count", "regions_json", "unstable_regions_json", "retries"]) {
    expect(cols("comparisons")).toContain(c);
  }
});

test("v6 records the baseline's engine version", () => {
  const db = openDb(":memory:");
  const cols = (db.query("PRAGMA table_info(snapshot)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("engine_version");
});

test("v7 adds the unloaded-image columns", () => {
  const db = openDb(":memory:");
  expect(LATEST_VERSION).toBe(7);
  const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols("baseline_images")).toContain("unloaded_images_json");
  expect(cols("comparisons")).toContain("dev_unloaded_images_json");
  expect(cols("comparisons")).toContain("prod_unloaded_images_json");
});

test("scrubRequestHeaders replaces values, keeps names, and leaves everything else alone", () => {
  const before = { dev: "https://d", requestHeaders: { "CF-Access-Client-Secret": "s3cret", "X-Env": "qa" }, viewports: [375] };
  const after = JSON.parse(scrubRequestHeaders(JSON.stringify(before))!);
  expect(after).toEqual({ ...before, requestHeaders: { "CF-Access-Client-Secret": "[redacted]", "X-Env": "[redacted]" } });
  // Nothing to do: no headers, none set, already redacted, or not a config at all.
  expect(scrubRequestHeaders("{}")).toBeNull();
  expect(scrubRequestHeaders(JSON.stringify({ requestHeaders: {} }))).toBeNull();
  expect(scrubRequestHeaders(JSON.stringify(after))).toBeNull();
  expect(scrubRequestHeaders("not json")).toBeNull();
  expect(scrubRequestHeaders("null")).toBeNull();
});

test("v7 removes request header values an older momus stored, from the rows and from the file", () => {
  const file = tmpFile();
  const raw = track(new Database(file, { create: true }));
  raw.exec("PRAGMA journal_mode = WAL;");
  migrate(raw, MIGRATIONS.slice(0, 6));
  // One short value, and one long enough to spill onto overflow pages.
  const long = `long-${"k9".repeat(6000)}-end`;
  const config = JSON.stringify({ dev: "https://d", requestHeaders: { "CF-Access-Client-Secret": "s3cret-token-value", Cookie: long } });
  const insertRun = `INSERT INTO runs (started_at, dev_base_url, prod_base_url, config_json, status, config_hash) VALUES ('s','d','p',?,'complete',?)`;
  raw.query(insertRun).run(config, "hash-over-the-values");
  raw.query(insertRun).run("{}", "hash-of-nothing-secret");
  raw.query(`INSERT INTO snapshot (created_at, prod_base_url, viewports_json, stabilize_json, config_json) VALUES ('t','p','[]','{}',?)`).run(config);
  raw.close();
  const inFiles = (needle: string) => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(needle));
  expect(inFiles("s3cret-token-value")).toBe(true);
  expect(inFiles(long.slice(0, 200))).toBe(true);

  const db = openDb(file);
  expect(userVersion(db)).toBe(LATEST_VERSION);
  const runs = db.query("SELECT config_json, config_hash FROM runs ORDER BY id").all() as Array<{ config_json: string; config_hash: string | null }>;
  const snap = db.query("SELECT config_json FROM snapshot").get() as { config_json: string };
  const redacted = { "CF-Access-Client-Secret": "[redacted]", Cookie: "[redacted]" };
  expect(JSON.parse(runs[0]!.config_json).requestHeaders).toEqual(redacted);
  expect(JSON.parse(snap.config_json).requestHeaders).toEqual(redacted);
  // The old hash covered the values; next to the scrubbed config it would
  // let a short token be guessed offline. A run that had none keeps its hash.
  expect(runs[0]!.config_hash).toBeNull();
  expect(runs[1]).toEqual({ config_json: "{}", config_hash: "hash-of-nothing-secret" });
  // An UPDATE alone leaves the old bytes in freed space and the WAL. The
  // step zeroes what it replaces and the migration checkpoints, so no copy
  // survives in any file: already while the database is open, and after.
  expect(inFiles("s3cret-token-value")).toBe(false);
  expect(inFiles(long.slice(0, 200))).toBe(false);
  expect(inFiles("k9k9k9k9k9k9k9k9")).toBe(false);
  expect((db.query("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete).toBe(
    (new Database(":memory:").query("PRAGMA secure_delete").get() as { secure_delete: number }).secure_delete); // put back as it was
  db.close();
  expect(inFiles("s3cret-token-value")).toBe(false);
  expect(inFiles("k9k9k9k9k9k9k9k9")).toBe(false);
});
