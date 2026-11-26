# ADR-0045: `requestHeaders` values are never stored, and v7 removes the ones that were

**Date:** 2026-11-21 · **Status:** Accepted · **Amends:** [ADR-0030](0030-setup-per-side.md)

## Context

Every run and every baseline stores the resolved config (`config_json`), and
runs store a hash of it. Setup secrets were already replaced before either
([ADR-0030](0030-setup-per-side.md)), on the stated ground that the `.sqlite`
is often committed and must never hold a credential or a hash of one.

`requestHeaders` was not covered. Its values were stored as written, and the
config docs said so. But `requestHeaders` is where the docs tell users to put
a Cloudflare Access service token, so the file a team commits, attaches to a
CI run or sends to a colleague carried the token in clear text, once per kept
run and once for the baseline.

Nothing reads the stored values back: captures use the live config, the
baseline gate doesn't compare headers, and the report doesn't show them.

## Decision

`redactConfig` replaces every `requestHeaders` value with `[redacted]` and
keeps the names, so a stored config still shows which headers a run sent.
This covers the stored config on runs and the snapshot, and the config hash,
which therefore no longer changes when a token is rotated.

Schema v7 does the same to files written before: each `config_json` on `runs`
and `snapshot` has its header values replaced. Two more things make that hold
for the file and not only for the rows:

- **The old `config_hash` is cleared** on every run whose config was scrubbed.
  It was taken over the values, and next to the scrubbed config it is a hash
  with a known preimage minus the token: a short one could be searched
  offline. The column is nullable and nothing gates on it.
- **The bytes are zeroed, not just unlinked.** An `UPDATE` leaves the old text
  in freed space. A migration step can now be marked `erases`: it runs with
  `PRAGMA secure_delete = ON`, so what it replaces is overwritten in the same
  transaction, and `migrate` then checkpoints the WAL so the main file holds
  the zeroed pages too. The pragma is put back afterwards. This was chosen
  over a `VACUUM`, which needs free disk for a second copy of the file, runs
  after the version bump (so a failed one is never retried), and still leaves
  the old pages in the main file until a checkpoint.

Rejected: storing a hash of each value, so a changed token would still show in
the config hash. A hash of a low-entropy credential can be searched, and
ADR-0030 already ruled hashes of secrets out of the file.

## Consequences

- Two runs that differ only in a header value have the same config hash.
- A stored config can no longer tell you what a header's value was.
- The migration can't reach copies: a `.sqlite` that was committed or shared
  before it ran still holds the values. The changelog says to rotate.
- A pre-v7 run that sent headers reads back with no config hash
  (`run.configHash: null` in `--json`).
- If another process holds the database open during the upgrade, the
  checkpoint waits for the next one; the rows are clean either way.
