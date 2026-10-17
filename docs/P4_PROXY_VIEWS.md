# Timeline and boundary images

`buildProxyView` builds `TIMELINE_VIEW` and `BOUNDARY_STRIP` images from the shared proxy.
The caller supplies ordered source timestamps, columns, tile height, and resource limits.
The builder uses the existing exact-frame extractor and its decoded-pixel checks.
It rejects missing timestamps instead of selecting nearby frames.
It scales complete frames without cropping and places them in row order.
Unused cells remain black.
The output uses lossless WebP encoding.

The evidence records each cell's source time, position, dimensions, and original frame checksum.
It also records proxy identity, toolchain identity, image dimensions, and decoded output proof.
The source interval spans the first through last sampled instant.
The evidence explicitly states `sampled-instants-only` coverage.
These images do not prove that the intervals between samples contain no forbidden content.
The image contains no text labels; consumers use the accompanying cell map.

Preparation accepts an optional `views` array with at most eight requests.
Each request permits at most 64 cells and explicit image-size limits.
The shared batch publishes each image under its existing source lease.
Registry rows use `PREVIEW` retention and the configured preview expiration.
Each row references the published proxy and its cell map.
The batch marks visual review as `NOT_REVIEWED` and mapping as `DECLARED`.
Preparation records elapsed construction time through `proxy_view` measurements.

The caller can supply exact timestamps or a sampling interval.
Semantic boundary selection, operator display, and representative acceptance remain unfinished.
No production setting enables these views by default.

Generated-media tests verified cell order, colors, blank cells, checksums, and failure cleanup.
The focused database test verified both artifact kinds under one original acquisition.
It also verified publication evidence, expiration, stored checksums, and source-lease cleanup.
Lint, type checking, and the worker build passed.

## Observed-frame sampling — 2026-10-16

A view request can replace `sourceTimesMs` with `sampling`.
Sampling requires `sourceInterval`, `count`, and `maxDistanceMs`.
The batch requires local evidence for this mode.
It uses the observed proxy timestamps already collected for frame hashes.
It does not decode the original again to select timestamps.

Targets use even spacing across the requested half-open interval.
One target uses the interval midpoint.
Each target selects the nearest observed frame inside that interval.
Equal distances select the earlier frame.
The sampler rejects excessive distance, repeated selections, insufficient observations, and unordered evidence.
The batch also rejects sampling intervals outside the proxy's source interval.
These rules never invent frames or silently substitute an unbounded nearby frame.

Registered sampling evidence records every target, selected source time, and distance.
It references the local evidence artifact and checksum.
The image configuration identity includes this sampling evidence.
The caller still chooses the interval and distance limit.
This sampler does not decide where sermon speech starts or ends.

All seven sampling and generated-image tests passed.
The focused database test verified sampled image publication under one original acquisition.
Lint, type checking, and the worker build passed.

## Operator display — 2026-10-16

The operator project page now lists up to eight retained timeline and boundary images.
Each image opens only when the operator selects its button.
The page lists source timestamps in cell order beneath the image.
It states that the images show selected moments and asks the operator to review intervening video.
The display receives image geometry and times only.
Detector confidence and sampling configuration stay outside the display model.
The existing review check also rejects selector signals in this model.

Signed image references use the artifact route with `image/webp`.
The route restricts image requests to supported timeline and boundary artifact versions.
It checks workspace ownership, expiration, publication state, and storage identity before serving the image.
It never accepts arbitrary content types or arbitrary artifact kinds.

Browser inspection found transparent padding in the first image version.
Version `proxy-contact-sheet-v2` removes alpha before encoding, so empty cells remain opaque black.
The version change preserves earlier artifact identities instead of changing their bytes.
Generated-image tests now check opacity as well as color and cell order.

All 24 focused tests passed after the padding correction.
Chromium verified image loading and frame labels on the operator page.
The same browser test also verified church and operator proxy playback.
A screenshot confirmed readable labels and opaque black padding.
Lint, type checking, and the worker build passed.
