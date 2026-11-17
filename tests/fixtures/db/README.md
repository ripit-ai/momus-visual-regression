# Fixture databases

Each `vX.Y.Z.sqlite` was written by the real momus CLI of that release
(`snapshot`, then `run`) against two tiny local sites. They are the RFC-0002
compatibility fixtures: every schema migration must open them and keep their
baselines diffable. Never regenerate one with a newer momus; that would defeat
the point.

`make-v0.9.4.ts` reproduces `v0.9.4.sqlite`; `make-fixture.ts` writes the 1.x
ones (see its header).

## Adding a fixture

Every 1.x minor release adds one (CONTRIBUTING.md, "Releasing"):

1. With the **released** build, run `momus snapshot` and then `momus run`
   against two tiny sites: `make-fixture.ts` does it, given a checkout of the
   release tag.
2. Check in the DB as `vX.Y.Z.sqlite` and the config it was captured with as
   `vX.Y.Z.config.json` (JSON, no credentials).

`tests/store/fixtures.test.ts` picks up every `v*.sqlite` here: it migrates a
copy and diffs the baseline against itself, which must pass with exit code 0.
A fixture without its `.config.json` fails that test.
