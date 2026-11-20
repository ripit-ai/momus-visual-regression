# Changelog

All notable changes to momus. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and momus follows
[Semantic Versioning](https://semver.org/) from 1.0 on; until then, any release
may change anything ([docs/stability.md](docs/stability.md)). Every release
lists a `Deprecated` section, even when it is empty.

## [Unreleased]

### Added

- **`stabilize.blockHosts`** aborts requests to listed hosts (exact, or
  `*.example.com` for subdomains) during setup and capture, so trackers and
  A/B testing scripts can't change what's rendered. It joins the baseline
  compatibility gate; a baseline captured before it blocked nothing, so it
  stays diffable while the list is empty
  ([ADR-0044](docs/adr/0044-block-hosts.md)).
- **Images that didn't load are reported.** A capture now records the rendered
  images that failed or were still loading when it was taken (`<img>`, CSS
  backgrounds, video posters), including an image the page swapped for a
  placeholder after it failed. The report flags the row and names the images
  and the side, `run` and `snapshot` say how many captures are affected, and
  `--json` lists them per side as `unloadedImages`, with a count in
  `summary.unloaded`. It is a warning: statuses, scores and exit codes are
  unchanged ([ADR-0046](docs/adr/0046-unloaded-images-are-a-warning.md)).

### Changed

- **`retries` also applies to the baseline.** While a baseline image has images
  that didn't load, it is captured again, up to `retries` times, and the
  capture with the fewest is kept. A config that already sets `retries` will
  take those extra prod captures at its next snapshot; the default (`0`) is
  unchanged.
- **DB schema v8.** Opening an older `.sqlite` upgrades it in place; momus 1.1.0
  and earlier can't open it afterwards.

### Fixed

- `--json` comparisons are now worst first, as documented. v1.1.0 wrote them by
  diff score with error, added and removed rows last.

### Security

- **`requestHeaders` values are no longer written to the `.sqlite`.** They were
  stored as written in each run's and the baseline's config, which is where an
  access token goes. The stored config now keeps header names only and the
  config hash no longer covers the values. Opening an existing file removes
  the values it holds, zeroes the bytes they occupied, and clears the config
  hash of the runs that had them (`run.configHash` is then `null`). A copy of
  the file made earlier still has them: rotate any token that was in a file you
  shared or committed
  ([ADR-0045](docs/adr/0045-request-headers-are-redacted.md)).

### Deprecated

- Nothing.

## [v1.1.0] - 2026-11-16

### Added

- **`--json FILE`** on `run` and `report` writes a versioned, machine-readable
  results document (verdict, counts, provenance, and per comparison: outcome,
  score, gate, regions, image hashes and paths). Its JSON Schema is
  [docs/results.schema.json](docs/results.schema.json)
  ([ADR-0043](docs/adr/0043-json-results-document.md)).

### Changed

- Zod 4 validates the config. Messages for out-of-range or wrongly typed values
  read differently, e.g. `viewports.0: Too small: expected number to be >0`.
  A wrong value inside `discovery.crawl` is now reported at the field itself.

### Deprecated

- Nothing.

## [v1.0.0]

### Added

- **Targets** ([RFC-0001](docs/rfcs/0001-targets.md)): a page is one kind of
  target. Targets in `urlList` that the baseline lacks are reported **added**;
  baseline targets no longer listed are **removed**. Both fail the gate unless
  allowed with `diff.allowAdded` / `--allow-added` and `diff.allowRemoved` /
  `--allow-removed`.
- **Run history** ([RFC-0002](docs/rfcs/0002-storage-and-run-history.md)):
  every run is kept in `output.db` with its provenance (momus and engine
  versions, config hash, the baseline it used, and `--commit` / `--branch` /
  `--pr`), pruned to `output.keepRuns` (default 5).
- `momus report [--run ID]` re-renders a stored run with the gate it had.
- **Scenarios and setup** ([RFC-0004](docs/rfcs/0004-scripted-interactions.md)):
  `scenarios` capture a page in a state after declarative steps, optionally one
  element; `setup` logs in once per side with steps or a `storageState` file.
- **Capture determinism** ([RFC-0006](docs/rfcs/0006-capture-determinism-and-diff-quality.md)):
  `stabilize.waitForImages`, `clock`, `reducedMotion`, `colorScheme`, `verify`
  (an **unstable** status that doesn't fail the gate), `retries`, and
  `diff.includeAA`. The Docker image pins Chromium's rendering
  (`MOMUS_RENDERING=pinned`).
- The report names change regions, size differences (with a magenta band in the
  diff), retries, and the side that rendered when the other failed.
- **Review report** ([RFC-0007](docs/rfcs/0007-review-report.md)): slider, onion
  skin and highlight modes, 1:1 zoom with pan, keyboard triage, filters by
  status, source, viewport and name, and grouping by target.
- `output.reportImages` / `--report-images`: `embed` (default), `link`, or
  `thumbnails` (WebP previews inline, originals linked).
- Reference documentation in `docs/`: [commands](docs/cli.md),
  [configuration](docs/config.md), [CI recipes](docs/ci.md) and the
  [stability contract](docs/stability.md).
- A `test` workflow runs the suite and every database compatibility fixture on
  each push. Release images also get `:X.Y` and (from 1.0) `:X` tags.

### Changed

- **The database is versioned** and migrated in place (now schema v6). A DB
  written by a newer momus is refused (exit 2) and left untouched.
- **The baseline compatibility gate** also refuses a baseline from another prod
  origin (including via `--prod`), a different prod `setup`, different
  RFC-0006 capture settings, another rendering environment, and **another
  browser engine version**. After upgrading momus to a release with a new
  browser build, re-capture each baseline with `momus snapshot` (or
  `momus run --snapshot`). Baselines captured before this release record no
  engine version and aren't compared until their next capture
  ([ADR-0038](docs/adr/0038-engine-version-in-the-gate.md)).
- A baseline is replaced atomically, and a capture in which every prod page
  failed is not saved (exit 2).
- **Each command accepts only its own flags.** Any other flag, or a stray
  argument, is an error (exit 2) naming the commands that take it
  ([ADR-0039](docs/adr/0039-flags-per-command.md)).
- **Unknown config keys are an error** (exit 2), with a "did you mean" hint
  ([ADR-0040](docs/adr/0040-strict-config.md)).
- The report requires JavaScript, still all inline
  ([ADR-0037](docs/adr/0037-report-requires-javascript.md)).
- The README is a quick start; the reference moved to `docs/`.
- Bun 1.4.3 in the image and the release build
  ([ADR-0036](docs/adr/0036-bun-1-4-3-one-test-process.md)).

### Deprecated

- Nothing.

### Removed

- `discovery.crawl.maxPages`, ignored since it moved to `discovery.maxPages`, is
  now an unknown-key error that names the new location.
- The report's All / Passed / Failed filter, replaced by per-status toggles.

### Fixed

- Images hidden with `display: none` no longer block `waitForImages`.
- `verify` marks a target unstable only where prod itself moved.
- Setup logs in at the widest viewport, so a login form behind a mobile menu is
  reachable.
- A corrupt image in `thumbnails` mode no longer stops the report from being
  written.

## [0.9.4] and earlier

See the [GitHub releases](https://github.com/bjhale/momus/releases) for 0.1.0
through 0.9.4, whose notes were generated from commit messages.

[Unreleased]: https://github.com/bjhale/momus/compare/v1.1.0...HEAD
[v1.1.0]: https://github.com/bjhale/momus/releases/tag/v1.1.0
[v1.0.0]: https://github.com/bjhale/momus/releases/tag/v1.0.0
[0.9.4]: https://github.com/bjhale/momus/releases/tag/v0.9.4
