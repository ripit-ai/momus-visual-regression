# ADR-0046: Images that didn't load are a warning on the capture; `retries` re-captures the baseline for them

**Date:** 2026-11-21 · **Status:** Accepted · **Extends:** [ADR-0034](0034-unstable-and-retries.md)

## Context

`stabilize.waitForImages` waits until every rendered `<img>` has loaded *or
failed*. That is right for the wait, which must end, and wrong for the result:
a failed image leaves nothing to say it failed. The browser draws no pixels for
it, the page often hides the alt text (`next/image` sets `color: transparent`),
and the capture returns `ok` with a hole where the image should be.

On the dev side this shows up as a failed comparison that `retries` may clear.
On the prod side it doesn't clear at all. A baseline was captured while an
image host answered some images with errors; both of `stabilize.verify`'s
captures lost the same images, so nothing was marked unstable, and every later
run reported the pages as changed. Ten of sixteen reported differences were
this, with nothing in the report, the exit code or the log to tell them from
real ones. The only way to find out was to open the screenshots.

The options were:

- **Fail the capture** when an image doesn't load. A page with one dead
  thumbnail on prod would then be an error row forever, on both sides, and
  nothing about the page could be compared.
- **A new status**, like `unstable`, that takes the comparison out of the gate.
  That would let a broken image hide a real regression elsewhere on the page,
  which is what ADR-0034 took care to avoid.
- **A warning** that rides on the capture and is shown wherever the comparison
  is, leaving the outcome alone.

## Decision

**A capture reports the rendered images that weren't there for it**, as
`unloadedImages` on its result: each with its URL, a state, and the network's
reason when there is one.

- `failed`: an `<img>` that is complete with no pixels and whose `decode()`
  rejects. `decode()` is what separates a broken image from an SVG with no
  intrinsic size, which also reports 0×0. CSS background images and `<video>`
  posters have no state to read, so for those the record of failed image
  requests (HTTP status 400 or more, or a failed request that wasn't aborted)
  is the witness; the DOM is walked for them only when that record isn't empty.
- `failed` also covers an `<img>` the page replaced after its load errored.
  A component that swaps a failed image for an inline placeholder leaves
  nothing broken in the DOM by screenshot time, and the picture is still
  missing; this was the case that hid missing hero images in practice. A
  script installed before navigation records each rendered `<img>` whose
  `error` event fires, with the URL that failed. If that element is still
  rendered and now shows a different URL, the failed URL is reported with
  what took its place ("replaced by the page with …"). Only the same URL
  loading afterwards clears it: a retry under another URL can't be told from
  a placeholder, so it is reported and named for the reviewer to judge. An
  image never attached to the document (a `new Image()` beacon) is not
  recorded.
- `pending`: an `<img>` that is not complete while its request is still in
  flight. Reported only when `stabilize.waitForImages` is on, since otherwise
  the capture never claimed to wait. Not complete is not enough on its own: a
  lazy image the browser never requested (a slide a carousel keeps clipped)
  is not complete either, and it is on neither side's screenshot.

The network record is kept under the URL the page asked for. After a redirect
that is the first hop's URL, which is what the `<img>`, the stylesheet or the
`poster` carries.

Left out, because they can't change the pixels or aren't content: images that
aren't rendered, images hidden by `stabilize.mask` or removed by
`stabilize.remove` (the check runs last, after both), and images declared 1×1
or smaller, which are tracking beacons. The declared size is read from the
attributes: WebKit lays a broken image out at 0×0 whatever they say. With
`capture.element`, only the element and the images inside it count. At most 20 are kept
per capture. The check never throws; if it fails, the capture reports nothing.

Not detected, and said so in the config docs rather than half-covered:

- an image the page removes or hides (`display: none`) when it fails. Once it
  is gone there is nothing to tell it from an element the page removed for
  any other reason, and reporting every such removal would warn about loaders,
  dismissed dialogs and carousels;
- images inside shadow roots and iframes;
- CSS images other than `background-image` on an element: pseudo-elements,
  `border-image`, `mask-image`, `content: url()`, and SVG `<image>`.

Reported although the pixels may be fine: an image that is rendered but
invisible for another reason (`opacity: 0`, clipped, off-canvas), and a
background whose server answered 4xx with an image body.

**It is a warning, never an outcome.** The list is stored on the baseline
image (`unloaded_images_json`) and on each comparison per side
(`dev_unloaded_images_json`, `prod_unloaded_images_json`, schema v8). Status,
score, `passed`, the gate and the exit code are exactly what they would be
without it. It is shown on the report row and in the header counts, on `run`'s
last stdout line, as a warning on stderr when a baseline is frozen with such
captures, and in `--json` as `dev.unloadedImages` / `prod.unloadedImages` and
`summary.unloaded` (additions only, so `schemaVersion` stays 1). It is recorded
on error, added and removed rows too: the side that rendered still says what
it lacked.

**`retries` also re-captures the baseline for it.** ADR-0034 kept `retries` on
the dev side because the baseline is frozen. While the baseline is being
captured it isn't frozen yet, and that is the only time prod is ever captured.
So during a snapshot, a capture with unloaded images is taken again, up to
`retries` times, stopping at the first one without any, and the capture with
the fewest is kept. A retry that fails outright is ignored: the capture in hand
is worth more than an error. `verify` then runs against the capture that was
kept. Nothing about the dev-side retry changes: a hole on dev that matters
fails the gate and is retried as before.

No new config field: the detection has no setting, and the re-capture uses
`retries`, which already means "captures can flake; try again" and is already
outside the baseline gate. The default stays 0, so by default nothing is
re-captured and the only change is the warning.

## Consequences

- A capture costs an init script, four request listeners and one more
  `evaluate`, plus a walk of the DOM when an image request failed.
- With `retries` above 0, a snapshot now takes extra prod captures: up to
  `retries` more for each baseline image that has unloaded images, on every
  snapshot, including for an image that will never load. A config that set
  `retries` for dev flake gets this without asking. The alternatives were a
  second setting, or leaving a known hole in a frozen baseline; the cost is
  bounded by `retries` and paid only where the warning would otherwise stand.
  A prod capture that errors outright is still not retried: that is an error
  row, visible in the gate, and ADR-0034's reasoning for it is unchanged.
- A site with a permanently broken image is warned about on every run. That
  is accurate, and the row still passes if both sides match; masking the
  element silences it.
- The warning says an image is missing, not that the diff is caused by it.
  The report words it that way.
- A hole that both sides share still passes: the pixels match. The warning is
  what tells the reviewer they were not shown the image.
- Detection relies on what each engine reports. Chromium gives a reason for a
  failed connection (`net::ERR_…`); Firefox and WebKit report the image as
  failed without one.
