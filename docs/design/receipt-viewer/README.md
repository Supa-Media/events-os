# Receipt viewer — verification

Evidence for "A receipt should open where you are, and be readable when it
does". Every image here was captured from the real `FileViewer` /
`FileThumbnail` components running in the Expo web bundle, against REAL files
(a 2400×3200 EXIF-rotated JPEG from an image encoder, one- and three-page PDFs
from a PDF writer, an HTML email body) served from **extension-less,
Convex-shaped storage URLs** — `/api/storage/<id>`, with the content type in
the response header and nothing in the path. That last detail is the point:
the old `url.includes(".pdf")` detector could never fire against a URL of that
shape, which is why receipt-exception evidence rendered blank 100% of the time.

| Shot | What it proves |
| --- | --- |
| `01-list-no-blank-tiles.png` | Every row draws something. PDFs show their first page; an emailed body and a missing file get LABELLED tiles. The receipts inbox used to draw emailed PDFs as empty boxes indistinguishable from a missing file. |
| `02-photo-fit-to-window.png` | A phone photo opens IN PLACE — no new tab. |
| `03-photo-zoomed-300pct.png` | Zoom works: at 300% the auth code and terminal id are legible. At fit they are not. This is the most-used case and it was previously unreadable. |
| `04-pdf-single-page.png` | A PDF renders in the same pane, with the same controls. A one-page document shows no page controls. |
| `05-…-page-1.png` / `06-…-page-3.png` | A three-page PDF pages through in place; page 3 is reachable. |
| `07-unlabelled-file-renders.png` | A JPEG served as `application/octet-stream` with no filename still renders — `"unknown"` is rendered optimistically as an image. |
| `08-emailed-html-body.png` | A `text/html` receipt renders inline on web. |
| `09-missing-file-fails-visibly.png` | A file that 404s gets an explicit state and an action — never a blank frame. |
| `10-historical-pdf-rescued-by-bytes.png` | A PDF with NO content type and NO filename — a historical row — is identified from its own bytes and rendered as a fully paged PDF. This is why there is no data backfill. |

`measurements.json` holds the timings printed below.

## Timings

Measured on localhost, so the network component is ~zero for both sides; the
numbers understate the real-world "before" (a Convex storage URL over the
internet, plus the tab switch and the trip back). Treat the *shape* as the
finding, not the absolute milliseconds.

| | Before (`Linking.openURL` → new tab) | After (in place) |
| --- | --- | --- |
| Phone photo, click → pixels | ~76 ms **in a new tab** | ~61 ms, in place |
| Single-page PDF | — | ~53 ms |
| Multi-page PDF, click → page 1 | — | ~50 ms |
| Multi-page PDF, RE-open | — | ~46 ms (cached document) |
| Unlabelled file | — | ~43 ms |

The headline finding is not the milliseconds. It is this:

**Before, a PDF in a new tab was DOWNLOADED, not displayed.** Chromium
declined to render `application/pdf` from that URL and started a file
download instead. That is the owner's report — "PDF views not reloading,
having to open up in another site" — reproduced exactly. No amount of waiting
was going to show that reviewer their receipt; the browser had already decided
to put it in ~/Downloads.

Every millisecond above also omits the part that actually cost the reviewer
their afternoon: leaving the app, finding the tab, closing the tab, and
finding their place in the grid again — twenty times over.
