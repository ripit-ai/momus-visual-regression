# ADR-0049: An upload never changes the run's exit code

**Date:** 2026-11-19 · **Status:** Accepted

## Context

`momus run --upload` adds a network step after the gate has decided. Exit codes
mean specific things ([AGENTS.md](../../AGENTS.md)): `0` all passed, `1` failed
or errored, `2` the run could not happen. If a down server could turn a green
run red, or a red run green, the server would become a second source of truth
for "did this pass", and a CI pipeline would break on infrastructure it does not
own.

## Decision

- **After the run, the upload is best effort.** A failure prints
  `Warning: upload failed; the run's result is unchanged: ...` on stderr and
  `run` exits with the code the gate produced. `uploadAfterRun` returns its
  `code` argument on every path.
- **Before the run, a missing server is a config error.** `run --upload` with no
  resolved `server` prints a config error and exits `2` before the browser
  check, so a mistake costs no capture. Nothing has been decided yet, so this
  hides no result.
- **`momus upload` is the opposite.** Uploading is its whole job, so any failure
  (no server, no such run, unreachable server, non-2xx after retries) exits `2`.
  Success exits `0`.

## Consequences

- A run whose upload failed can be re-sent with `momus upload`, since the run
  is still in `output.db`.
- A CI job that must have the upload should run `momus upload` as its own step.
