/**
 * The Marketing & Media stream — the PW look, and the field-to-edit pipeline
 * that turns a shoot into a finished post. Also the Marketing & Media theme +
 * its two courses.
 *
 * Owned exclusively by this file for content authoring — do not add
 * Marketing & Media sections or courses anywhere else. See `../index` for how
 * this assembles into the full curriculum/catalog.
 *
 * Sourced from captured Notion docs (session working material, not committed
 * to this repo — see the "Further reading" link on each lesson for the
 * canonical internal notion.so URL): PW Designs, Flyers, Fonts, Colors;
 * Busking Setup Electronics; Editing Prep; DaVinci Project Access; Dropbox
 * Access. Facebook Pixel setup is deliberately left out of `media-pipeline` —
 * it's thin and situational; the course description notes ads/pixel work as
 * a coming-soon area instead.
 *
 * DESCOPED (owner decision, 2026-07-17): the caption-voice lesson
 * (`mktg-the-voice`) and the entire `short-form-editing` course were removed
 * before merge — their source docs (Caption Maker, PW Short Form Video
 * Editing Guidelines) are out of date, and the Marketing Director will author
 * current guidance later. Drafts for both live in this file's git history
 * (see the PR that introduced this stream) if ever wanted as a starting
 * point. `mktg-the-look` was kept — the owner didn't dispute the brand
 * kit content.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Marketing & Media-stream sections, in curriculum order. */
export const MARKETING_SECTIONS: Omit<AcademySection, "order">[] = [
  // ══ Marketing & Media ═══════════════════════════════════════════════════

  // ── 46 · Brand & Voice: the look ───────────────────────────────────────────
  {
    slug: "mktg-the-look",
    title: "The look",
    subtitle: "PW Red, three fonts, and a folder anyone can open",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every flyer, banner, overlay, and sign that says Public Worship should look like it came from the same place — whether it was made by the founding team or a brand-new chapter three time zones away. That's what a brand kit buys you: consistency without a bottleneck.",
      },
      {
        kind: "bullets",
        items: [
          "**Color:** PW Red — **#c93431**. It's the one color that has to show up somewhere on anything public-facing.",
          "**Fonts:** Times New Roman Condensed for headlines, **SF Pro Display** for captions specifically, and Barbra Condensed as the third supporting face.",
          "**Logos:** live in the shared Logos folder in Dropbox — pull from there, don't recreate one from a screenshot.",
          "**Templates:** Canva templates cover the recurring shapes — flyers for distribution, banners, social media overlays, and signage. Duplicate a template, don't build from a blank canvas.",
        ],
      },
      {
        kind: "heading",
        text: "Where the assets live",
      },
      {
        kind: "table",
        headers: ["Need", "Where it lives"],
        rows: [
          ["Logo (any format)", "Logos — shared Dropbox folder"],
          ["A flyer", "Canva — PW Flyer for Distribution template"],
          ["A banner", "Canva — PW Banners template"],
          ["A social media overlay", "Canva — Social Media Overlays template"],
          ["Signage", "Canva — Signage template"],
        ],
      },
      {
        kind: "rule",
        title: "Nobody should have to ask permission to look right",
        text: "A chapter in a new city should be able to make something that looks unmistakably PW without messaging anyone for help. The color, the fonts, and the templates exist precisely so the look scales without a single point of failure.",
      },
      {
        kind: "reveal",
        prompt:
          "A brand-new chapter needs a flyer for their first event and nobody from the founding team is reachable this week. What do they do?",
        answer:
          "They don't wait. Pull the logo from the shared Logos folder, duplicate the PW Flyer for Distribution template in Canva, and swap in their event details. The whole point of a shared, self-serve asset kit is that a chapter never has to stall on a design because HQ is asleep or busy.",
      },
      {
        kind: "link",
        label: "Further reading: PW Designs, Flyers, Fonts, Colors",
        url: "https://www.notion.so/29c7f1c177b680e49273d51138fc1677",
      },
    ],
    quiz: [
      {
        prompt: "What is the PW brand red's hex code?",
        options: ["#c93431", "#eaca6d", "#ff0000", "#3431c9"],
        answerIndex: 0,
        explanation:
          "#c93431 — PW Red — is the one color that should show up somewhere on anything public-facing, regardless of who made it.",
      },
      {
        prompt: "Which font is specifically used for captions?",
        options: [
          "Times New Roman Condensed",
          "Barbra Condensed",
          "SF Pro Display",
          "Helvetica",
        ],
        answerIndex: 2,
        explanation:
          "SF Pro Display is the caption font specifically; Times New Roman Condensed and Barbra Condensed round out the other two brand faces.",
      },
      {
        prompt: "Where do brand assets like the logo and design templates actually live?",
        options: [
          "Whoever made the last design keeps them on their own laptop",
          "A shared Dropbox logo folder and a set of Canva templates anyone can duplicate",
          "They get remade from scratch each time by whoever's asking",
          "Only the founding team has access",
        ],
        answerIndex: 1,
        explanation:
          "Logos and Canva templates are shared and self-serve on purpose — no chapter should need to ask permission to look on-brand.",
      },
      {
        prompt: "Why should a brand-new chapter be able to make an on-brand flyer without asking anyone?",
        options: [
          "Because design doesn't matter for a first event",
          "So the look stays consistent across every city without HQ becoming a bottleneck",
          "Because Canva requires no login",
          "It's not actually possible — every design needs sign-off",
        ],
        answerIndex: 1,
        explanation:
          "The whole reason the color, fonts, and templates are documented and shared is so consistency scales with the network instead of depending on one team's availability.",
      },
    ],
  },

  // ── 47 · Media Pipeline: HIT RECORD ────────────────────────────────────────
  {
    slug: "mktg-hit-record",
    title: "HIT RECORD",
    subtitle: "The one rule that has cost real footage before",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "A busking setup is simple: the keyboard, the mics, and the speaker all connect into the Zoom recorder. Turn the recorder on, confirm every channel you're using shows red, and hit record — before anyone plays a note.",
      },
      {
        kind: "bullets",
        items: [
          "**Connect in order:** keyboard into the recorder, mics into the recorder, speaker into the recorder.",
          "**Turn on the recorder** and check that every channel actually being used is lit **red** — that's the recorder confirming it's receiving signal on that channel.",
          "**Hit record**, and confirm it: the light next to the record button glows red the moment it's actually recording.",
        ],
      },
      {
        kind: "story",
        title: "Read the source, out loud",
        text: "The Busking Setup doc doesn't casually mention hitting record — it says \"HIT RECORD - PLS PLS PLS, you know it's recording when the light next to the button is red.\" That's not the tone of a routine checklist item. It reads like it was written by someone who has packed up gear after a session and realized, too late, that nothing was actually captured. The rule survives in that exact wording because skipping it has cost real recordings before.",
      },
      {
        kind: "rule",
        title: "Confirm red before a single note plays",
        text: "Channels lit red and the record light lit red are the only two signals that matter. If either one isn't red, nothing downstream — editing, timelines, posting — has anything to work with.",
      },
      {
        kind: "reveal",
        prompt:
          "You've been playing for ten minutes before you think to check whether the recorder is actually running. What now?",
        answer:
          "Check immediately — don't wait until the set is over. If the channels or the record light aren't red, nothing so far has been captured, and the sooner you catch it, the less you lose. Better to interrupt the session and fix it than to find out afterward that ten minutes are gone for good.",
      },
      {
        kind: "link",
        label: "Further reading: Busking Setup Electronics",
        url: "https://www.notion.so/23c7f1c177b680bfb2b6c4633951759f",
      },
    ],
    quiz: [
      {
        prompt: "What confirms a channel on the Zoom recorder is actually receiving signal?",
        options: [
          "A green light",
          "The channel indicator glowing red",
          "A beep from the recorder",
          "There's no way to tell until you review the file",
        ],
        answerIndex: 1,
        explanation:
          "Red is the signal, both for a live channel and for the record indicator itself — it's the one visual check the setup depends on.",
      },
      {
        prompt: "What connects into the Zoom recorder in a busking setup?",
        options: [
          "Only the mics",
          "The keyboard, the mics, and the speaker",
          "Just a single line-in cable",
          "Nothing — the recorder captures ambient room sound only",
        ],
        answerIndex: 1,
        explanation:
          "All three — keyboard, mics, and speaker — connect into the recorder so everything gets captured, not just one source.",
      },
      {
        prompt: "Why does the source document plead \"PLS PLS PLS\" about hitting record?",
        options: [
          "It's just a stylistic quirk with no real meaning",
          "Because forgetting to confirm recording has genuinely cost captured footage before",
          "Because the record button is hard to find",
          "It's a joke between the production team",
        ],
        answerIndex: 1,
        explanation:
          "The pleading tone reads as a lesson learned the hard way — the rule exists in that exact wording because skipping the check has lost recordings in the past.",
      },
      {
        prompt: "You realize partway through a set you never confirmed recording. What's the right move?",
        options: [
          "Finish the set, then check — it's probably fine",
          "Check immediately; if it isn't recording, catching it now loses less than catching it after",
          "Assume it's recording since the recorder is powered on",
          "Restart the whole session from the beginning regardless",
        ],
        answerIndex: 1,
        explanation:
          "The channel and record lights are the only real confirmation. Checking immediately, rather than waiting, is what limits how much footage is actually lost.",
      },
    ],
  },

  // ── 48 · Media Pipeline: from shoot to timeline ────────────────────────────
  {
    slug: "mktg-shoot-to-timeline",
    title: "From shoot to timeline",
    subtitle: "The Editing Prep SOP: files uploaded, clips synced, ready to cut",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Editing Prep exists so an editor opens a project and finds a synced master timeline waiting — not a folder of loose clips they have to sort through first. It's two jobs: get every file uploaded and arranged, then sync it all into one long master timeline.",
      },
      {
        kind: "table",
        headers: ["Step", "What you do"],
        rows: [
          [
            "1. Copy the template",
            "Duplicate the project template, rename it in the standard convention — \"Event - Lead Person\" — and make sure proxies and originals are synced.",
          ],
          [
            "2. Upload the files",
            "Video and audio both go to Dropbox under Areas > Media. Retrieve audio from the Zoom recorder's micro-SD card — unless audio was recorded directly on camera, in which case skip that step entirely.",
          ],
          [
            "3. Arrange the bins",
            "All audio clips can share one bin; video clips get separated by which camera shot them.",
          ],
          [
            "4. Build the master timeline",
            "Lay down the audio tracks first — audio usually runs the whole day across several mic channels. Then place the video clips, aligning each one by listening to its audio against the timeline.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Audio first, video aligned to it",
        text: "Audio is usually the one continuous throughline of the whole day, even when it's split across several mic channels. Lay it down first, then sync every video clip to it by ear — that's the reliable way to build one honest 1–3 hour master timeline instead of guessing at timestamps.",
      },
      {
        kind: "reveal",
        prompt:
          "Two SD cards come back from a shoot: one from the Zoom audio recorder, one from a camera that recorded its own audio too. Do you need to pull the recorder's audio for that camera's clips?",
        answer:
          "No — if a camera already recorded its own audio, there's no need to also pull from the separate Zoom recorder for that footage. The recorder's SD card matters specifically for cameras or setups that didn't capture their own sound.",
      },
      {
        kind: "link",
        label: "Further reading: Editing Prep",
        url: "https://www.notion.so/23f7f1c177b6806da147cf83f8998efa",
      },
    ],
    quiz: [
      {
        prompt: "What's the naming convention for a copied project?",
        options: [
          "\"Event - Lead Person\"",
          "The date only",
          "Whatever the editor prefers",
          "\"Lead Person - Event\"",
        ],
        answerIndex: 0,
        explanation:
          "\"Event - Lead Person\" is the standard convention — consistent naming is what lets anyone find the right project later.",
      },
      {
        prompt: "Where do video and audio files get uploaded during prep?",
        options: [
          "Dropbox, under Areas > Media",
          "Directly into the DaVinci timeline with no upload step",
          "A personal Google Drive",
          "Email to the lead editor",
        ],
        answerIndex: 0,
        explanation:
          "Areas > Media in Dropbox is the shared destination for both video and audio — the same place every prep pass uploads to.",
      },
      {
        prompt: "What goes down on the master timeline first, and why?",
        options: [
          "Video, because it's easier to align audio to visuals",
          "Audio, because it usually runs continuously across the whole day and video gets aligned to it",
          "Whichever file is largest",
          "It doesn't matter what order they're placed",
        ],
        answerIndex: 1,
        explanation:
          "Audio is the reliable throughline — even split across channels, it usually spans the full day, so video clips get synced against it by listening, not guessed at by timestamp.",
      },
      {
        prompt: "When do you skip pulling audio from the Zoom recorder's micro-SD card?",
        options: [
          "Never — audio always comes from the recorder",
          "When the camera already recorded its own audio directly",
          "When the shoot is under an hour",
          "When there's only one camera",
        ],
        answerIndex: 1,
        explanation:
          "If audio was captured directly on camera, there's nothing extra to retrieve from the separate recorder for that footage.",
      },
    ],
  },

  // ── 49 · Media Pipeline: getting access ────────────────────────────────────
  {
    slug: "mktg-getting-access",
    title: "Getting access",
    subtitle: "The edit environment: Blackmagic Cloud, Resolve, and Dropbox",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Before you can open a shared project, you need three things set up: a Blackmagic Cloud account, DaVinci Resolve installed, and a spot in the Public Worship org so the app can actually show you the projects. Every step routes through asking the right person or joining the right group — not through anyone handing you a shared login.",
      },
      {
        kind: "bullets",
        items: [
          "**Step 1 — Blackmagic Cloud account.** Free to create; this is the account your access gets tied to.",
          "**Step 2 — Install DaVinci Resolve.** The free version gets most editors 95% of the way there. Color graders need **Resolve Studio**, the paid tier — same app, more features.",
          "**Step 3 — Ask an admin for org access.** Request to be added to the Public Worship organization and the **Editors** group, using the same email as your Blackmagic Cloud account. You'll get an email invite — accept it, then let the admin know so they can finish adding you to Editors.",
          "**Step 4 — Open Resolve and log in.** Sign into your Blackmagic Cloud account from inside the app, choose the Public Worship profile, and every shared project becomes visible.",
        ],
      },
      {
        kind: "p",
        text: "Dropbox works the same way: request to join the storage Google Group to get access, then install Dropbox locally if you're actually editing or prepping footage — at that point it stops being optional, since Editing Prep depends on it.",
      },
      {
        kind: "rule",
        title: "Ask, don't guess",
        text: "Every piece of this environment is gated by a request — an admin invite to the org and Editors group, a request to join the storage group for Dropbox. Nobody self-serves their way in by finding a shared password; you ask the right person through the right channel and wait for the invite.",
      },
      {
        kind: "reveal",
        prompt:
          "You're joining as a color grader. Which Resolve version do you need, and what do you need to request first?",
        answer:
          "Resolve Studio — the paid tier is required for color grading work; the free version won't cut it. Before any of that matters, though, you still need an admin to add you to the Public Worship organization and the Editors group, using the same email as your Blackmagic Cloud account.",
      },
      {
        kind: "link",
        label: "Further reading: DaVinci Project Access",
        url: "https://www.notion.so/23e7f1c177b68005a68cee77178bde81",
      },
      {
        kind: "link",
        label: "Further reading: Dropbox Access",
        url: "https://www.notion.so/24c7f1c177b6808f9ad3d80f5e0b8e41",
      },
    ],
    quiz: [
      {
        prompt: "Which DaVinci Resolve version do color graders specifically need?",
        options: [
          "The free version — it's enough for everyone",
          "Resolve Studio, the paid tier",
          "A special \"Colorist Edition\" that doesn't exist",
          "Either version, it makes no difference",
        ],
        answerIndex: 1,
        explanation:
          "The free version gets most editors 95% of the way there, but color grading specifically needs the paid Resolve Studio tier.",
      },
      {
        prompt: "How do you get added to the Public Worship organization and Editors group?",
        options: [
          "It happens automatically after installing Resolve",
          "You ask an admin to add you, using the same email as your Blackmagic Cloud account",
          "You email support@blackmagicdesign.com",
          "There's no group — every account gets full access",
        ],
        answerIndex: 1,
        explanation:
          "Org and Editors-group access is admin-gated by request — you send the ask, using your Blackmagic Cloud email, and accept the resulting invite.",
      },
      {
        prompt: "What's the process to get Dropbox access?",
        options: [
          "Anyone can install Dropbox and see the files immediately",
          "Request to join the storage Google Group, then install locally if you're editing or prepping",
          "Buy a personal Dropbox subscription",
          "Ask any teammate to forward you a login",
        ],
        answerIndex: 1,
        explanation:
          "Access routes through requesting to join the storage group — the same \"ask, don't guess\" pattern as the DaVinci org access.",
      },
      {
        prompt: "Is installing Dropbox locally optional for someone doing editing prep?",
        options: [
          "Yes, always optional",
          "No — if you're editing or prepping footage, it stops being optional",
          "Only optional for color graders",
          "Dropbox isn't used for editing at all",
        ],
        answerIndex: 1,
        explanation:
          "Dropbox is casually optional for browsing, but Editing Prep's upload steps depend on it locally — at that point it's required, not optional.",
      },
    ],
  },
];

/** The Marketing & Media stream's theme entry. */
export const MARKETING_THEME: Theme = {
  key: "marketing",
  title: "Marketing & Media",
  subtitle: "How the world sees what God is doing.",
};

/**
 * The Marketing & Media stream's courses, in catalog order. Two
 * intermediate, role-audience courses: the brand kit, and the field-to-edit
 * media pipeline. A `short-form-editing` course (the video-editing standard
 * and the caption voice) is coming once the Marketing Director authors
 * current guidance — the prior source docs for it were out of date and the
 * lessons were pulled before merge (see the file header). Ads/pixel setup
 * (Facebook Pixel) is intentionally left out of `media-pipeline` as too thin
 * and situational for a full lesson — it's noted below as a coming-soon area
 * instead of a stub module.
 */
export const MARKETING_COURSES: Course[] = [
  {
    slug: "brand-and-voice",
    themeKey: "marketing",
    title: "Brand & Voice",
    level: "intermediate",
    audience: "role",
    description:
      "The PW look — the color, fonts, and self-serve templates that make " +
      "anything on-brand. (The house caption voice is coming soon, once the " +
      "Marketing Director authors current guidance.)",
    icon: "pen-tool",
    moduleSlugs: ["mktg-the-look"],
  },
  {
    slug: "media-pipeline",
    themeKey: "marketing",
    title: "Media Pipeline",
    level: "intermediate",
    audience: "role",
    description:
      "From a busking setup's Zoom recorder to a synced DaVinci timeline: " +
      "field-capture habits, the Editing Prep SOP, and how to get access to " +
      "the tools. (Ads/pixel setup is a coming-soon area of this course; a " +
      "short-form video-editing standard is coming too, once the Marketing " +
      "Director authors current guidance.)",
    icon: "hard-drive",
    moduleSlugs: ["mktg-hit-record", "mktg-shoot-to-timeline", "mktg-getting-access"],
  },
];
