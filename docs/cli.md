# Command reference

Every command reads `./momus.config.ts` unless given `--config FILE` (see
[config.md](config.md)). In the Docker image, prefix each command with
`docker run --rm -v "$PWD:/work" bjhale/momus`.

**Flags beat config-file values, which beat defaults.** Each command accepts
only the flags listed for it: any other flag, or a stray argument, is an error
(exit 2) that names the commands taking that flag, for example
`unknown flag for snapshot: --dev (it is a flag of run)`.
`momus` with no command (or an unknown one) prints the usage.

## `momus init`

Writes a starter `momus.config.ts` in the current directory. Fails if one
already exists. Takes no flags.

## `momus install-browser`

Downloads the browser engines momus captures with (Chromium, Firefox, WebKit).
Not needed in the Docker image, which has them. `run` and `snapshot` never
download a browser themselves. Takes no flags.

## `momus snapshot`

Captures the **prod** baseline once into `output.db` (default `momus.sqlite`):
discovers pages from prod, screenshots each at every viewport, and stores the
prod images plus the capture context (viewports, stabilize settings, browser
engine and its version). Reuse it across many `momus run` invocations without
re-screenshotting prod.

Running `momus snapshot` again replaces the baseline: it is how you refresh the
frozen prod capture that `momus run` reuses. The replacement is all-or-nothing:
if **every** prod capture fails (prod unreachable), nothing is saved, the
previous baseline is kept, and the command exits 2. If only some pages fail, the
baseline is saved with those pages as error rows. Stored runs are kept; each
holds its own copy of the prod images it was diffed against.

| Flag | Description |
| --- | --- |
| `--config FILE` | Path to the config file (default `./momus.config.ts`). |
| `--prod URL` | Override the config's `prod` base URL. |
| `--concurrency N` | Override the number of concurrent screenshots (`concurrency.screenshots`). |
| `--max-pages N` | Override the max pages to compare (`discovery.maxPages`; `0` = unlimited). |
| `--crawl` | Force same-origin crawl discovery on. |
| `--insecure` | Ignore invalid/self-signed TLS certs for discovery fetches and page loads (`insecure`). |
| `--browser NAME` | Engine to capture with (`chromium`\|`firefox`\|`webkit`); overrides `browser`. |

The baseline lives in its own tables inside `output.db`; the single SQLite file
is the portable artifact. Commit it, or keep it between CI jobs
([ci.md](ci.md)).

## `momus run`

Runs the pipeline against the configured `dev` build, always diffing dev against
a stored **prod baseline**:

- **No baseline yet** (fresh `output.db`): `momus run` captures the prod
  baseline as its first step (discovering pages and screenshotting prod), then
  diffs dev against it and writes the report, all in one invocation.
- **Baseline present**: `momus run` reuses it and captures **dev only**. Prod is
  **not** re-screenshotted (it is frozen) and prod's `setup` login doesn't run.
- **Baseline conflict**: the run **fails fast (exit 2)** if the baseline isn't
  comparable with this run: a different prod origin (scheme, host, port), a
  different `browser`, a different **browser engine version** (after a browser
  upgrade), different `viewports`, `stabilize` settings or prod `setup`, or a
  different rendering environment (the Docker image vs. anywhere else; see
  [config.md](config.md#pinned-rendering)). The message names both values and
  how to fix it. Re-capture with `momus run --snapshot` (or `momus snapshot`),
  or point `output.db` at a separate file for another site.

Because prod is frozen after the first run, repeated `momus run` invocations diff
against the same prod baseline. Each run is stored as a new run in `output.db`;
the newest `output.keepRuns` (default 5) are kept and older ones pruned. To
re-capture prod, run `momus snapshot` (which replaces the baseline), or pass
`momus run --snapshot` to do that re-capture and the diff in a single
invocation. A first run (or `--snapshot`) that can't capture a single prod page
exits 2 without saving a baseline.

| Flag | Description |
| --- | --- |
| `--config FILE` | Path to the config file (default `./momus.config.ts`). |
| `--dev URL` | Override the config's `dev` base URL. |
| `--prod URL` | Override the config's `prod` base URL. |
| `--out FILE` | Override the report output path (`output.report`, default `momus-report.html`). |
| `--concurrency N` | Override the number of concurrent screenshots (`concurrency.screenshots`). |
| `--max-pages N` | Override the max pages to compare (`discovery.maxPages`; `0` = unlimited). |
| `--crawl` | Force same-origin crawl discovery on. |
| `--insecure` | Ignore invalid/self-signed TLS certs for discovery fetches and page loads (`insecure`). |
| `--browser NAME` | Engine to capture with (`chromium`\|`firefox`\|`webkit`); overrides `browser`. |
| `--snapshot` | Re-capture the prod baseline before diffing, even when `output.db` already holds one (ignores the freeze). Equivalent to running `momus snapshot` first, in a single invocation. |
| `--allow-added` | Don't fail the run for targets that are new since the baseline (`diff.allowAdded`). They are still reported. |
| `--allow-removed` | Don't fail the run for baseline targets that are no longer listed (`diff.allowRemoved`). They are still reported. |
| `--report-images MODE` | `embed`, `link` or `thumbnails`; overrides `output.reportImages`. |
| `--commit SHA` | Record the commit this run tested. Stored on the run; no effect on the result. |
| `--branch NAME` | Record the branch this run tested. |
| `--pr N` | Record the pull request this run tested. |
| `--json FILE` | Also write the results document to `FILE` ([JSON results](#json-results)). |

On completion `momus run` prints, for example:

```text
Wrote momus-report.html for run #7 (12 comparisons). Exit 0.
```

## `momus report`

Re-renders the HTML report for a run stored in `output.db`: the latest by
default. It needs no browser and no network, and never creates a DB file. The
pass/fail gate is the one recorded on that run, so an old run renders with the
verdict it had, whatever today's config says. A run that did not complete
(failed or interrupted) renders as FAIL with its status in the header, and the
command prints a warning. `report` loads the same config file (for `output.db`,
`output.report` and `output.reportImages`), so the config must validate, dev and
prod URLs included.

| Flag | Description |
| --- | --- |
| `--run ID` | Render this run instead of the latest. Run ids are never reused. |
| `--out FILE` | Override the report output path (default `momus-report.html`). |
| `--report-images MODE` | `embed`, `link` or `thumbnails`; overrides `output.reportImages`. |
| `--config FILE` | Path to the config file (default `./momus.config.ts`); used for `output.db` and `output.report`. |
| `--json FILE` | Also write the run's results document to `FILE` ([JSON results](#json-results)). |

Exits `0` on success and `2` if there is no DB file, no runs, or no run with that
id (the message lists the ids available).

## JSON results

`--json FILE` on `run` or `report` writes the run's results as JSON, next to
the HTML report, for CI scripts and other tools to read. `report --run ID
--json FILE` exports any stored run, with no browser and no network. The
format is part of the 1.x contract ([stability.md](stability.md)), and its JSON
Schema is [results.schema.json](results.schema.json).

```json
{
  "schemaVersion": 1,
  "momusVersion": "1.1.0",
  "verdict": "FAIL",
  "summary": { "total": 4, "passed": 3, "failed": 1, "errored": 0, "added": 0, "removed": 0, "unstable": 0, "unloaded": 1 },
  "gate": { "allowAdded": false, "allowRemoved": false },
  "run": { "id": 7, "status": "complete", "devBaseUrl": "https://dev.example.com", "ci": { "commit": "a1b2c3", "branch": null, "pr": "42" }, "…": "…" },
  "baseline": { "id": 3, "createdAt": "2026-11-15T03:00:00.000Z", "viewports": [375, 1280], "…": "…" },
  "comparisons": [
    {
      "targetId": "/about", "label": "/about", "viewport": 375,
      "status": "ok", "outcome": "fail", "failsGate": true,
      "diffScore": 0.0106, "failScore": 0.01,
      "dev": { "url": "https://dev.example.com/about", "width": 375, "height": 900,
               "image": { "sha256": "9f2c…", "bytes": 48213, "file": "momus-report-images/0001-dev.png" },
               "unloadedImages": [] },
      "prod": { "url": "https://www.example.com/about", "width": 375, "height": 900,
                "image": { "sha256": "41d0…", "bytes": 47902, "file": "momus-report-images/0001-prod.png" },
                "unloadedImages": [{ "url": "https://img.example.com/hero.jpg", "state": "failed", "detail": "HTTP 504" }] },
      "regions": [{ "x": 8, "y": 15, "width": 230, "height": 69 }], "regionCount": 2,
      "error": null,
      "…": "…"
    }
  ]
}
```

- **`verdict`** uses the gate recorded on the run, as the report does. A run
  that didn't complete is `FAIL`. `PASS` corresponds to exit `0` from `run`.
- **`comparisons`** are worst first. `outcome` is `pass`, `fail`, `error`,
  `added`, `removed` or `unstable`. `failsGate` says whether that row fails the
  run.
- Scores are fractions (`0.0106` is 1.06%), as in the config.
- **An unknown value is `null`**, never a missing key: for example `diffScore`
  on an error row, or a field that older runs didn't record.
- **Images** carry a `sha256` and a size. `file` is the PNG's path when the
  report wrote it to disk (`--report-images link` or `thumbnails`), relative to
  the working directory unless `output.report` is absolute. With `embed` it is
  `null`.
- **`unloadedImages`** on a side lists the images it was captured without:
  `failed`, or `pending` (still loading at `stabilize.timeoutMs`), with the
  network's reason in `detail` when there was one. It is a warning: `outcome`
  and `failsGate` don't depend on it. `summary.unloaded` counts the comparisons
  that have any ([config.md](config.md#images-that-didnt-load)).
- New fields may appear in any 1.x release. Ignore keys you don't know.

## Exit codes

`momus run` returns a process exit code so it can gate CI. `snapshot` and
`report` use `0` and `2` the same way. These meanings are part of the 1.x
contract ([stability.md](stability.md)).

| Code | Meaning |
| --- | --- |
| `0` | All pages captured and passed the diff gate. **Unstable** targets (`stabilize.verify`) don't count against it. |
| `1` | At least one page failed the gate, errored, or is **added**/**removed** (unless allowed). A report is still written. An error is never a silent pass. |
| `2` | Operational error that prevented the run: an unknown flag or argument, a bad config (including an unknown key or an unknown `MOMUS_RENDERING`), a missing browser, a baseline conflict (see `momus run` above), a DB written by a newer momus, every prod capture failing, a failed `setup` login, or another unrecoverable failure. |

## Output

While capturing and diffing, momus renders a progress bar to **stderr**: one
phase for prod capture (on a fresh baseline) and one for dev capture and diff.
In a non-TTY environment (CI, piped output) it prints a plain progress line
periodically instead of redrawing. A baseline frozen with images that didn't
load is warned about on stderr too. stdout carries only the final summary, so
piping stdout to a file stays clean. Neither the progress output nor the log
text is part of the stability contract.
