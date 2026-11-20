# ADR-0048: Runs upload in stages, with images addressed by hash

**Date:** 2026-11-19 · **Status:** Accepted

## Context

The MVP server ([RFC-0010](../rfcs/0010-server.md)) ingests runs from the CLI.
A run is the results document ([ADR-0043](0043-json-results-document.md)) plus
its PNGs, which can total hundreds of MB. Three shapes were considered:

- **One multipart request** with the JSON and every PNG. The simplest to build,
  but a failure restarts the whole upload, and every run resends images the
  server already holds.
- **Batched JSON with base64 images inside.** Requests stay small without an
  image endpoint, but base64 adds about 33% to every image, nothing is
  deduplicated, and it needs a custom batch format next to the contract.
- **A staged upload, images addressed by sha256.** Chosen.

## Decision

1. `POST /api/projects/{slug}/runs` with the results document. The server
   creates a pending run and replies with the hashes it is missing.
2. `PUT /api/images/{sha256}` per missing image, raw PNG bytes, four at a time.
   The server hashes the body and rejects a mismatch, so the address can be
   trusted. A repeat PUT is a no-op.
3. `POST /api/runs/{runId}/complete`. The server checks every referenced image
   exists, then marks the run complete; otherwise it replies `409` with the
   still-missing hashes.

The client retries a request up to three times, on a network error or a 5xx
only. `momus upload` sends a stored run; `momus run --upload` sends the run it
just finished. Both build the document with `buildResults` and read image bytes
from the database, with no `file` paths.

## Consequences

- Each request stays small, a failure retries one image, and prod images, which
  repeat across runs, are sent once. Later uploads are mostly the JSON.
- A retried `POST /runs` can leave a duplicate pending run. That is accepted for
  the MVP: it shows as incomplete and nothing is lost.
- **The image store is shared across projects.** With no auth, the "missing"
  list tells one project whether another already holds an image. Revisit this
  when auth arrives, for example by keying images per project.
- The client and server share the protocol only by convention; the sha256 and
  slug formats are the points both must agree on.
