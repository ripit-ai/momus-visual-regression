# ADR-0043: `--json FILE` writes a versioned results document

**Date:** 2026-11-16 · **Status:** Accepted

## Context

[RFC-0008](../rfcs/0008-cli-ci-integration.md) proposed machine-readable
results. Its status had been set to Withdrawn without a recorded reason, while
the roadmap and [RFC-0009](../rfcs/0009-stability-contract.md) still counted on
its JSON format as part of the 1.x contract and as the 2.0 server's input. 1.0
shipped without it, so CI scripts and coding agents had only the exit code, one
stdout line, and an HTML report written for people.

Two flag shapes were considered:

- **`--format json`**: print the document on stdout in place of the summary
  line.
- **`--json FILE`**, as the RFC proposed: write the document to a file and
  leave stdout alone.

## Decision

RFC-0008 is reinstated for its JSON results only. `momus run` and
`momus report` take `--json FILE`, which writes the results document beside
the HTML report. The report is always written as well.

- **A file, not stdout.** CI uploads the document as an artifact next to the
  report, and stdout keeps its one summary line
  ([ADR-0018](0018-progress-behind-a-seam.md)). An agent reads the file.
- **On `report` too.** `report --run ID --json FILE` produces the document for
  any stored run with no browser and no network, using the gate recorded on
  that run, as the HTML does.
- **A flag, not a config field.** Like `--commit`, where the file goes is the
  CI job's business, not the site's.
- **The Zod schema in `src/report/results.ts` is the contract.**
  `docs/results.schema.json` is generated from it (input mode, so objects stay
  open), and a test fails when the two drift. `schemaVersion` is `1`; 1.x
  releases only add fields.
- **Fixed shape.** An unknown value is `null`, never an absent key, so
  consumers don't need to special-case missing keys on old rows.
- **Images: content hash, plus a file when there is one.** This answers the
  RFC's open question. Each image carries `sha256` and `bytes`, which is what
  the server needs to upload images separately and dedupe them. `file` is the
  PNG's path when the report wrote it to disk (`reportImages: link` or
  `thumbnails`), and `null` when it was embedded.
- **`outcome` and `failsGate` per comparison.** These are the report's
  pass/fail split and the gate decision, so consumers don't reimplement
  `failsGate`.

## Consequences

- The document is a 1.x stability surface ([docs/stability.md](../stability.md)).
  Renaming or removing a field, or changing what one means, needs
  `schemaVersion: 2` and a major release.
- Hashing every image adds a little time to runs that pass `--json`. Runs
  without it are unchanged.
- JUnit, the Markdown summary, CI-variable detection, the GitHub Action and
  sharding remain proposals in RFC-0008. None of them is built yet.
