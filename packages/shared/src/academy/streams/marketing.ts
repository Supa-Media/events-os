/**
 * The Marketing & Media stream — the PW look and voice, the short-form video
 * standard every clip has to pass, and the field-to-edit pipeline that turns
 * a shoot into a finished post. Also the Marketing & Media theme + its three
 * courses.
 *
 * Owned exclusively by this file for content authoring — do not add
 * Marketing & Media sections or courses anywhere else. See `../index` for how
 * this assembles into the full curriculum/catalog.
 *
 * Sourced from captured Notion docs (`notion-sources/*.md` in this repo):
 * PW Designs, Flyers, Fonts, Colors; PW Short Form Video Editing Guidelines;
 * Busking Setup Electronics; Editing Prep; DaVinci Project Access; Dropbox
 * Access. The Caption Maker page went private mid-archive — its content here
 * is reconstructed from a verified crawl summary, not the live doc, and is
 * the FIRST time the house caption voice has been written down as rules
 * rather than left as "everyone just knows it from example." Flag that
 * lesson (`mktg-the-voice`) for an owner spot-check. Facebook Pixel setup is
 * deliberately left out of `media-pipeline` — it's thin and situational; the
 * course description notes ads/pixel work as a coming-soon area instead.
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
        kind: "tip",
        text: "**Further reading:** \"PW Designs, Flyers, Fonts, Colors\" — internal Notion doc (https://www.notion.so/29c7f1c177b680e49273d51138fc1677).",
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

  // ── 47 · Brand & Voice: the voice ──────────────────────────────────────────
  {
    slug: "mktg-the-voice",
    title: "The voice",
    subtitle: "The rules were always there — now they're written",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Look at enough PW captions in a row and a voice emerges: short poetic lines, a scripture reference woven in rather than bolted on, everyone involved in the video credited, a hashtag block that repeats post to post, and a quiet habit of censoring sensitive words. Nobody ever wrote that down as a rulebook — it existed only by example, in a working doc of past captions. This lesson writes it down for the first time.",
      },
      {
        kind: "bullets",
        items: [
          "**Short, poetic lines.** Not ad copy, not a call-to-action paragraph — a caption reads more like a line of liturgy than a marketing pitch.",
          "**Scripture anchors.** A reference is woven into the caption itself, not appended as an afterthought hashtag.",
          "**Credit everyone.** Every person who touched the video — on camera, behind it, producing it — gets tagged. Nobody's contribution goes uncredited.",
          "**One reused hashtag block.** The same core set of hashtags travels from post to post — consistency over reinventing tags every time.",
          "**Censor sensitive words, every time.** The same discipline the editing guidelines apply to audio and subtitles (next course) applies to captions: mute or soften anything sensitive rather than spelling it out.",
        ],
      },
      {
        kind: "story",
        title: "The doc nobody published as a style guide",
        text: "The house caption voice lived entirely in a working doc — entry after entry of past captions, never labeled \"here are the rules.\" Read enough of them back to back and the pattern is unmistakable: short poetic lines, a woven-in scripture reference, a full credit list, a repeating hashtag block, sensitive words consistently softened. The rules were always real. They just weren't written down until now.",
      },
      {
        kind: "rule",
        title: "Consistency over cleverness",
        text: "A caption that's clever but breaks the pattern — no scripture, no credits, a one-off hashtag set — is off-voice even if it's well-written. The voice is a set of habits repeated on purpose, not a bar for wit.",
      },
      {
        kind: "reveal",
        prompt:
          "You write a punchy, clever caption for a video — but it has no scripture reference and doesn't credit anyone in the clip. Is that on-voice?",
        answer:
          "No. Clever isn't the bar — consistency is. The house voice is short poetic lines WITH a woven-in scripture anchor AND full credit for everyone involved. Missing either one breaks the pattern, no matter how well the line reads on its own.",
      },
      {
        kind: "tip",
        text: "**Further reading:** \"Caption Maker\" — internal Notion doc (https://www.notion.so/1d17f1c177b68089afddc246c60b0f5d). Note: this page went private mid-archive; the voice described here is reconstructed from a verified crawl summary of its entries, not the live doc — worth an owner spot-check against the source.",
      },
    ],
    quiz: [
      {
        prompt: "What's the core caption style, per the house voice?",
        options: [
          "Long, persuasive marketing copy with a clear call to action",
          "Short, poetic lines with a scripture reference woven in",
          "Just the video title and a link",
          "A full transcript of the video",
        ],
        answerIndex: 1,
        explanation:
          "Short and poetic, with scripture anchored INSIDE the line rather than appended — that's the pattern that shows up entry after entry in the source captions.",
      },
      {
        prompt: "What does the house style always do for the people in a video?",
        options: [
          "Nothing — captions focus only on the message",
          "Credit everyone involved — on camera, behind it, and producing it",
          "Credit only the person on camera",
          "Credit only the editor",
        ],
        answerIndex: 1,
        explanation:
          "Crediting everyone who touched the video is a consistent practice across the caption examples — nobody's contribution goes unlisted.",
      },
      {
        prompt: "How does the house voice handle a sensitive word in a caption?",
        options: [
          "Spell it out plainly for honesty",
          "Censor or soften it, the same discipline applied to audio and subtitles",
          "Leave it to each writer's personal judgment with no pattern",
          "Replace the whole caption with a generic line",
        ],
        answerIndex: 1,
        explanation:
          "Censoring/muting sensitive words shows up consistently in the source captions — it's part of the pattern, not a one-off editorial call.",
      },
      {
        prompt: "Why write the caption voice down as rules now, instead of leaving it as \"everyone just knows it\"?",
        options: [
          "It was never actually consistent, so there's nothing to write down",
          "So a new writer or a new chapter can replicate it without needing to read dozens of past captions first",
          "Because the old working doc is still public and easy to reference",
          "It doesn't matter — captions aren't part of the brand",
        ],
        answerIndex: 1,
        explanation:
          "The pattern was real but tribal — living only in a working doc of examples. Writing it down is what lets it travel to people who never saw that doc.",
      },
    ],
  },

  // ── 48 · Short-Form Editing: the seven rules ───────────────────────────────
  {
    slug: "mktg-the-seven-rules",
    title: "The seven rules",
    subtitle: "Walk the checklist before you submit an edit",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Before a short-form edit goes in for review, it has to pass seven checks. They're not vibes — they're the specific things that make the difference between a clip that gets watched and one that gets scrolled past.",
      },
      {
        kind: "bullets",
        items: [
          "**1. Keep it short.** Aim under 60 seconds — shorter is better. Past 90 seconds, videos tend to underperform or even get demonetized on platforms like YouTube.",
          "**2. The first 3 seconds matter.** No fade-ins, no blur-ins, no slow intros. Start on the most compelling moment and hook the viewer immediately.",
          "**3. Snappy pacing.** Jump-cut out pauses, filler words, and dead space. The edit should feel tight and energetic start to finish.",
          "**4. Movement and visual energy.** A static tripod shot gets a dynamic zoom or slow pan added in post; shaky handheld footage gets stabilized. Stillness reads as lifeless — motion tells the story.",
          "**5. Subtitles, always.** Every video with dialogue or lyrics gets subtitles — no exceptions.",
          "**6. On-screen hook captions are not yours to add.** Those short headline-style captions over the first 5 seconds get added by the writing team, AFTER the first edit. Don't include them unless specifically asked.",
          "**7. Music has to fit the tone.** The soundtrack should enhance the emotional arc, not distract from it.",
        ],
      },
      {
        kind: "rule",
        title: "Seven checks, every time, before review",
        text: "This is a checklist, not a feeling. An edit that's snappy and well-shot but skips one of the seven — say, adding hook captions yourself, or leaving out subtitles — still isn't ready to submit.",
      },
      {
        kind: "reveal",
        prompt:
          "Your edit is tight, hooks in the first 3 seconds, and subtitled — and you added a bold on-screen headline caption yourself because you thought it looked great. Ready to submit?",
        answer:
          "Not quite. On-screen hook captions are the writing team's job, added AFTER the first edit — not something an editor adds unprompted. Submit without it, even if your version looks good; the writing team's pass happens next.",
      },
      {
        kind: "tip",
        text: "**Further reading:** \"PW Short Form Video Editing Guidelines\" — internal Notion doc (https://www.notion.so/20a7f1c177b6800fb79cdb3303d41225).",
      },
    ],
    quiz: [
      {
        prompt: "What's the target length for a short-form edit?",
        options: [
          "Under 60 seconds — shorter is better; past 90s tends to underperform",
          "Exactly 90 seconds",
          "As long as it takes to tell the story",
          "Under 5 minutes",
        ],
        answerIndex: 0,
        explanation:
          "Under 60 seconds is the aim, and the shorter the better — videos past 90 seconds tend to underperform or get demonetized on platforms like YouTube.",
      },
      {
        prompt: "What's the rule for the first 3 seconds of a clip?",
        options: [
          "Open with a slow fade-in to set the mood",
          "No fade-ins or blur-ins — start immediately on the most compelling moment",
          "Start with the video's title card",
          "Start with a caption explaining the context",
        ],
        answerIndex: 1,
        explanation:
          "Fade-ins and slow intros cost you the hook. The rule is to start right on the most compelling moment and grab attention within the first few seconds.",
      },
      {
        prompt: "Who adds the on-screen hook captions that appear in a video's first 5 seconds?",
        options: [
          "The editor, during the first pass",
          "The writing team, after the first edit — don't add them unless asked",
          "Whoever posts the video",
          "They're generated automatically",
        ],
        answerIndex: 1,
        explanation:
          "Hook captions are explicitly the writing team's addition, done AFTER the first edit — an editor including them unprompted is going outside their lane.",
      },
      {
        prompt: "How should a static tripod shot be handled in editing?",
        options: [
          "Leave it exactly as shot — stillness is fine",
          "Add movement in post, like a dynamic zoom in/out or a slow pan",
          "Cut it entirely from the edit",
          "Speed it up 2x",
        ],
        answerIndex: 1,
        explanation:
          "Static shots need visual energy added in post — a dynamic zoom or pan — so the video doesn't feel stagnant. Shaky handheld footage gets the opposite treatment: stabilization.",
      },
    ],
  },

  // ── 49 · Short-Form Editing: captions, music, and what we won't use ───────
  {
    slug: "mktg-captions-music-rights",
    title: "Captions, music, and what we won't use",
    subtitle: "The specs, the censoring rule, and the sounds we skip",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Two of the seven rules — subtitles and music — have real specs behind them, plus a hard line on what content the team will never put out, no matter how well it edits.",
      },
      {
        kind: "table",
        headers: ["Caption spec", "Value"],
        rows: [
          ["Font", "\"Reel\" (in the Captions app) or SF Pro Bold everywhere else"],
          ["Size", "Relatively small"],
          ["Color", "Yellow #eaca6d or white #ffffff"],
        ],
      },
      {
        kind: "bullets",
        items: [
          "**No profanity, ever.** Use your judgment; if you're unsure whether a word crosses the line, check with the team before you post.",
          "**Sensitive words get muted and censored.** Words like slurs or references to self-harm get muted in the audio, and censored in the subtitle if the word is essential to the message.",
          "**Trending sounds are allowed — with one hard line.** A trending Reels/TikTok sound is fair game to boost engagement, UNLESS the sound's original song or context is antithetical to Christian values (profanity, sexual content, occult references). When in doubt, don't use it — ask the team.",
          "**Pre-cleared music lives in the Audio Edits folder.** Editors are encouraged to pull from there first; the music team is available if nothing in the folder fits.",
        ],
      },
      {
        kind: "rule",
        title: "When in doubt, don't",
        text: "Every rule in this lesson resolves the same way when it's unclear: don't use it, and ask the team. That's true for a borderline word, a trending sound with a murky origin, or music that doesn't obviously fit the tone.",
      },
      {
        kind: "reveal",
        prompt:
          "A trending sound is everywhere on Instagram this week. The clip you'd use is just an instrumental beat — but the original song it's sampled from has sexual lyrics. Use it?",
        answer:
          "No. The rule is about the sound's ORIGIN, not just the seconds you're sampling — if the original song or context is antithetical to Christian values, it's off-limits even if the clip you'd actually use sounds clean. When in doubt, skip it and ask the team.",
      },
      {
        kind: "tip",
        text: "**Further reading:** \"PW Short Form Video Editing Guidelines\" — internal Notion doc (https://www.notion.so/20a7f1c177b6800fb79cdb3303d41225).",
      },
    ],
    quiz: [
      {
        prompt: "What are the two acceptable subtitle font options?",
        options: [
          "\"Reel\" in the Captions app, or SF Pro Bold everywhere else",
          "Any font as long as it's bold",
          "Times New Roman Condensed",
          "Comic Sans for a casual feel",
        ],
        answerIndex: 0,
        explanation:
          "\"Reel\" (the Captions app's built-in font) or SF Pro Bold elsewhere — those are the two specified caption fonts.",
      },
      {
        prompt: "What are the allowed subtitle colors?",
        options: [
          "PW Red only",
          "Yellow #eaca6d or white #ffffff",
          "Any color that stands out",
          "Black on a white background",
        ],
        answerIndex: 1,
        explanation:
          "The spec calls for yellow (#eaca6d) or white (#ffffff) — chosen for legibility, not the brand's red.",
      },
      {
        prompt: "How does the team handle a sensitive word (like a slur or a self-harm reference) in a subtitle?",
        options: [
          "Leave it exactly as spoken for authenticity",
          "Mute it in the audio, and censor it in the subtitle if it's essential to the message",
          "Cut the whole clip it appears in",
          "Replace it with a laugh track",
        ],
        answerIndex: 1,
        explanation:
          "Mute in audio, censor in text if the word matters to the message — that's the consistent handling for sensitive words across the guidelines.",
      },
      {
        prompt: "When is a trending sound off-limits, even if it would boost engagement?",
        options: [
          "Never — any trending sound is fair game",
          "When the sound's original song or context is antithetical to Christian values",
          "Only if it's longer than 15 seconds",
          "Only if a competitor chapter used it first",
        ],
        answerIndex: 1,
        explanation:
          "Trending sounds are actively encouraged for engagement — except where the original context (profanity, sexual content, occult references) conflicts with the mission. When in doubt, skip it and ask.",
      },
    ],
  },

  // ── 50 · Media Pipeline: HIT RECORD ────────────────────────────────────────
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
        kind: "tip",
        text: "**Further reading:** \"Busking Setup Electronics\" — internal Notion doc (https://www.notion.so/23c7f1c177b680bfb2b6c4633951759f).",
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

  // ── 51 · Media Pipeline: from shoot to timeline ────────────────────────────
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
        kind: "tip",
        text: "**Further reading:** \"Editing Prep\" — internal Notion doc (https://www.notion.so/23f7f1c177b6806da147cf83f8998efa).",
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

  // ── 52 · Media Pipeline: getting access ────────────────────────────────────
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
        kind: "tip",
        text: "**Further reading:** \"DaVinci Project Access\" — internal Notion doc (https://www.notion.so/23e7f1c177b68005a68cee77178bde81); \"Dropbox Access\" — internal Notion doc (https://www.notion.so/24c7f1c177b6808f9ad3d80f5e0b8e41).",
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
 * The Marketing & Media stream's courses, in catalog order. Three
 * intermediate, role-audience courses: the brand kit + caption voice, the
 * short-form video standard, and the field-to-edit media pipeline. Ads/pixel
 * setup (Facebook Pixel) is intentionally left out of `media-pipeline` as
 * too thin and situational for a full lesson — it's noted below as a
 * coming-soon area instead of a stub module.
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
      "anything on-brand — and the caption voice, codified for the first " +
      "time from years of practice.",
    icon: "pen-tool",
    moduleSlugs: ["mktg-the-look", "mktg-the-voice"],
  },
  {
    slug: "short-form-editing",
    themeKey: "marketing",
    title: "Short-Form Editing",
    level: "intermediate",
    audience: "role",
    description:
      "The seven checks every clip passes before it goes out for review, " +
      "plus the caption specs and the sound/rights lines editors don't get " +
      "to skip.",
    icon: "video",
    moduleSlugs: ["mktg-the-seven-rules", "mktg-captions-music-rights"],
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
      "the tools. (Ads/pixel setup is a coming-soon area of this course.)",
    icon: "hard-drive",
    moduleSlugs: ["mktg-hit-record", "mktg-shoot-to-timeline", "mktg-getting-access"],
  },
];
