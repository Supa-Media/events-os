# Public Worship Notion Archive — Index

Archived from `bedecked-mandrill-c8b.notion.site` on 2026-07-17. 26 of 31 requested
pages were successfully captured. 5 pages became inaccessible (publicAccessRole
flipped to "none" mid-archive — the site appears to be actively being
unpublished page-by-page, not a one-time flip). See "Failed / inaccessible"
below.

## Successfully archived (26 files)

| File | Description |
| --- | --- |
| `mission-and-vision-statements.md` | Public Worship's mission and vision statements. |
| `onboarding-all-public-worship.md` | Full new-team-member onboarding guide: team structure, active projects, email/Slack setup, PARA org system. |
| `public-worship-attendance-policy.md` | Meeting attendance rules for directors/team members, absence allowances, consequences. |
| `director-expectations-leadership-philosophy.md` | Leadership philosophy for Directors: ownership, delegation, building for scale. |
| `project-lead.md` | Role description for the Project Lead position (timeline, budget, cross-team coordination). |
| `recruitment-philosophy-mindset.md` | Philosophy behind hiring/recruiting: "empower first, appoint second." |
| `interview-guide.md` | Full interview structure and question bank for candidate interviews. |
| `empowerment-trial.md` | The 1–2 month trial process new candidates go through before official onboarding. |
| `pw-songwriting-song-selection-philosophy-draft.md` | The doxological-worship songwriting/song-selection framework (full ~15k char draft). |
| `song-catalog-doxological-analysis.md` | Large (~48k char) line-by-line doxological analysis of a worship song catalog. |
| `worship-leader-checklist.md` | Checklist a worship leader/singer fills out to submit a song cover. |
| `music-producers-understanding-the-role.md` | Essay on what a music producer does, with the "apple metaphor" and example workflows. |
| `artists-understanding-the-role.md` | Essay on the artist role at Public Worship. |
| `sop-partnership-evaluation-process.md` | SOP for evaluating inbound/outbound partnerships: the "4 Gates" and sign-off routing table. |
| `marketing-creative-director.md` | Role description for the Marketing & Creative Director position. |
| `financial-manager.md` | Role description for the Financial Manager position. |
| `development-partnerships-director.md` | Role description for the Development & Partnerships Director position. |
| `pw-short-form-video-editing-guidelines.md` | Editing standards for short-form video (pacing, subtitles, music, captions). |
| `pw-designs-flyers-fonts-colors.md` | Brand assets reference: logo location, brand color, fonts, flyer/banner examples. |
| `setting-up-facebook-pixel.md` | Steps for setting up a Facebook/Meta Pixel on ticketing platforms. |
| `busking-setup-electronics.md` | Wiring diagram/steps for the busking audio recording setup. |
| `davinci-project-access.md` | Steps to get Blackmagic Cloud + DaVinci Resolve project access. |
| `editing-prep.md` | Process for prepping raw footage/audio into a synced master timeline before editing. |
| `dropbox-access.md` | How to get Dropbox access (storage@supa.media group, install steps). |
| `need-a-company-card.md` | How to get a Relay virtual company card for purchases. |
| `seyis-ableton-course.md` | Intro Ableton course overview with links to video lessons. |

## Failed / inaccessible (5 pages — could not be captured)

These returned Notion's "This page couldn't be found" / login-wall, confirmed via
the page's own `getPublicPageData` API response (`publicAccessRole` was `"none"`,
vs. `"reader"` on every successfully-archived page). One of them (item 6) was
**successfully captured once**, then became inaccessible on every subsequent
retry within the same session — strong evidence the site owner is unpublishing
pages live, in real time, while this archive was in progress. All 5 were
retried at the end of the session and remained blocked.

| Page | URL | Status |
| --- | --- | --- |
| Director Operating Standard (Effective 2026) | `/Director-Operating-Standard-Effective-2026-2d87f1c177b680c98426fb999e68b915` | Never accessible — requires Notion login (confirmed via `www.notion.so`, shows "Sign in to see this page in Seyi Olujide's Notion"). |
| Director Operating Standards - Shortened | `/Director-Operating-Standards-Shortened-b898b6724eaf4787849bcffa7feb3200` | **Captured content once**, then went dark on all retries. Content was NOT saved before it flipped — recommend checking Notion directly / re-publishing to recapture. |
| Adding Someone to the Team | `/Adding-Someone-to-the-Team-af1344859be446d38b40c708834409f9` | Inaccessible on every attempt this session. |
| Outcome Messages | `/Outcome-Messages-926362a032d143d6b1a3a7847187acf8` | Accessible briefly (title resolved) then went dark before content extraction; no content saved. |
| Caption Maker | `/Caption-Maker-1d17f1c177b68089afddc246c60b0f5d` | Inaccessible on every attempt this session. |

**Recommendation:** Given the site is being unpublished live, these 5 pages
should be re-checked directly in the Notion workspace (not via the public
site) if their content is still needed — the internal page IDs are in the
table above (append to `https://www.notion.so/<32-char-id>`).

## Totals

- 26 files saved, 134,598 bytes (~131 KB) of markdown content.
- Largest file: `song-catalog-doxological-analysis.md` (48,329 bytes / ~47k chars of source text, matching the expected size).
- All saved files were verified non-truncated (checked head/tail of each extracted body against the live page, and cross-checked character counts against the page's rendered `innerText` length before saving).
