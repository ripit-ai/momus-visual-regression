# ADR-0044: `stabilize.blockHosts` aborts requests to listed hosts, and is gated

**Date:** 2026-11-20 · **Status:** Accepted

## Context

Third-party scripts make captures differ for reasons no one changed: an A/B
testing tool shows prod one variant and dev another, a chat widget or a
session recorder injects UI, and analytics beacons keep the network busy.
`stabilize.mask` and `stabilize.remove` can hide what such a script renders,
but only once it has rendered, and only where a selector is known ahead of
time. An A/B test can change anything on the page.

Hosted tools solve this with a host blocklist. A team moving from one (Percy's
`discovery.disallowed-hostnames` lists about 40 hosts for one site) had no
equivalent.

## Decision

`stabilize.blockHosts: string[]`, default `[]`.

- **Aborted, not stubbed.** A request to a listed host fails with
  `blockedbyclient`, as an ad blocker would. A page that breaks without a
  third party breaks the same way on both sides.
- **Two entry forms only:** an exact host, or `*.` and a domain, matching its
  subdomains at any depth and not the domain itself. Entries are validated and
  lower-cased by the schema. General globs were rejected: `ads*` or
  `*example.com` can match the site under test, and every capture would error.
- **Everywhere the page loads:** both sides, setup and every capture, so prod's
  setup session and dev's are formed under the same rules.
- **One route handler** (`src/capture/route.ts`) does blocking and same-origin
  header scoping. A blocked request is aborted before headers are considered.
  Two `page.route` handlers would each have to fall back to the other, with an
  order no one can see.
- **Service workers are blocked while any host is.** Playwright's
  interception doesn't see a worker's own fetches, so a worker could still
  reach a blocked host. With an empty list, workers stay allowed: changing that
  for everyone would change pixels for sites whose worker renders content.
- **Gated** ([ADR-0010](0010-baseline-compatibility-gate.md)): blocking changes
  pixels. Compared as a set, since order can't change a capture. A baseline
  stored before this field has none and is read as `[]`, which is what it was
  captured with, so it stays diffable while the config blocks nothing. No
  migration: stabilize settings are stored as JSON in `snapshot.stabilize_json`.
- **Discovery isn't affected.** It fetches prod's sitemap and pages over HTTP,
  without running scripts.

## Consequences

- Adding or removing a host forces a re-capture of the baseline, like any
  other stabilize change.
- Blocking is not a security boundary. A script served from an allowed host
  still runs, and so does anything it inlines.
- Listing the site's own host makes every capture an error row, which the
  report shows at once rather than hiding.
