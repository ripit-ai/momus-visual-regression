# ADR-0047: The release tag is the version; the workflow stamps it into package.json

**Date:** 2026-11-26 · **Status:** Accepted

## Context

Every run records momus's version, read from `package.json`
([ADR-0025](0025-run-history.md)). The release workflow used to refuse a tag
that didn't match that field, so each release took a hand-made bump commit
before tagging. It was easy to forget: `v1.2.0-RC.1` was pushed against a
`package.json` still at `1.1.0`, and the release failed at the gate.

## Decision

The tag is the only place the version is written by hand. The release workflow
checks that the tag is `vMAJOR.MINOR.PATCH[-PRERELEASE]`, then writes the
version into `package.json` in the `check` job and again in each `docker` build,
before anything reads it. Nothing is committed back.

## Consequences

- Releasing is: changelog, tag, push. No bump commit.
- `package.json` on `main` and in a tag's tree goes stale. It is the last
  hand-set value, and a run from source records it. That version only labels
  runs in history and in `--json` output; nothing gates on it.
- `tests/fixtures/db/make-fixture.ts` can no longer trust a tag checkout's
  `package.json`. It now checks that the checkout is at tag `v<version>` and
  stamps the version itself, the same way the workflow does.

## Alternatives rejected

- **Commit the bump back to `main` from the workflow.** The bump would land
  after the tag, so the tagged tree would still be stale. It would also need a
  token allowed to push past branch protection, and it adds a bot commit to
  every release.
- **Bump first, then tag, from a manually triggered workflow.** That fixes the
  tagged tree but moves releasing out of `git tag` into the Actions UI, and
  still needs that push permission.
