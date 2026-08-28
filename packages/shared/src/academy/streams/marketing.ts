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
 *
 * ADDED 2026-08-28: `mktg-the-desk`, for the Marketing desk that shipped with
 * it (Chapter OS → Marketing). It sits in `brand-and-voice` rather than
 * `media-pipeline` because it is about the org's public VOICE — the homepage's
 * words, the link cards, and the promise the mailing list represents — not
 * about capture and edit. The half of that lesson that will age worst is the
 * consent half, and it is the half that matters: the difference between an
 * opt-out we set and an unsubscribe the person set is the one thing a
 * marketing seat can get wrong in a way that costs the whole org its
 * deliverability.
 *
 * ADDED 2026-08-28 (same day, second wave): `mktg-the-library-and-the-blog`,
 * for the Designs and Blog tabs. It is a SEPARATE lesson rather than more of
 * `mktg-the-desk` because its two rules are governance rather than product —
 * that reading the brand kit is ungated on purpose, and that writing a post
 * and publishing one are deliberately different permissions. The quiz cap is
 * five questions, and folding these in would have meant dropping the mailing
 * list's consent questions, which are the ones that protect the org from a
 * self-inflicted wound.
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
          "**Color:** PW Red — **#891d1a**. It's the one color that has to show up somewhere on anything public-facing. It's also the default accent color in the org's saved email templates (Emails → Templates), so an email and a flyer carry the same red.",
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
        options: ["#891d1a", "#eaca6d", "#ff0000", "#1a1d89"],
        answerIndex: 0,
        explanation:
          "#891d1a — PW Red — is the one color that should show up somewhere on anything public-facing, regardless of who made it. It's the same red the org's saved email templates use by default, so print and email don't drift apart.",
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

  // ── 49 · Brand & Voice: the marketing desk ────────────────────────────────
  {
    slug: "mktg-the-desk",
    title: "The marketing desk",
    subtitle: "Changing the site yourself, and keeping the list honest",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Marketing is the one function whose work is entirely public, and for a long time it was the function with the least control over anything public. Changing a headline on publicworship.life, reordering the link cards, or adding somebody to the newsletter all meant asking a developer. The **Marketing** tab in Chapter OS is where those things live now.",
      },
      {
        kind: "table",
        headers: ["Tab", "What it's for"],
        rows: [
          ["Site", "The homepage's hero copy and the three impact numbers"],
          ["Links", "The Important Links cards, their order, and which events show"],
          ["Mailing list", "Who we can reach by email and text, and who asked us not to"],
          ["Emails", "A pointer to Mailchimp, where the newsletter actually goes out"],
        ],
      },
      {
        kind: "heading",
        text: "The site changes as soon as you save it",
      },
      {
        kind: "p",
        text: "There is no publish step on copy, no review queue, and no deploy. Edit a field, leave it, and the live page carries the new words within about a minute. That's deliberate — a headline is a sentence, and a sentence somebody spots as wrong should be fixable by the person who spotted it. It also means there is nobody downstream to catch a typo for you.",
      },
      {
        kind: "tip",
        text: "In the app · Marketing → Site. Each field saves on its own when you tap away from it. The counter under a field turns red before you hit the limit — those limits are where the design actually breaks, not arbitrary.",
      },
      {
        kind: "p",
        text: "The Links tab works the same way, with one difference: a **card** has a show/hide switch, so you can build one before its announcement goes out. The row called **Live event cards** isn't a card at all — it's the rule for the event pages the homepage pulls in automatically. Set how many show, lead with a specific event, or keep one off the front page entirely. The preview under it is the real thing: what it lists is what the site will show.",
      },
      {
        kind: "rule",
        title: "Only what's already published can be pinned",
        text: "Leading with an event doesn't publish it. If an event's RSVP page isn't live, pinning it does nothing — because the alternative would be putting a link to a 404 on the front page. Publish the page from the event first, then choose where it sits.",
      },
      {
        kind: "heading",
        text: "The mailing list is a promise, not a spreadsheet",
      },
      {
        kind: "p",
        text: "The list is not its own table of names — it's every person the OS already knows, with the added question of whether we can actually reach them. That's why adding someone who's already a donor updates that person instead of creating a second one, and why a name added here shows up on the People tab too.",
      },
      {
        kind: "bullets",
        items: [
          "**Opted out** — someone at the org marked this person as not-to-be-marketed. You can put them back.",
          "**Unsubscribed or bounced** — the person clicked unsubscribe, texted STOP, or the address hard-bounced. **Nothing you do in the app undoes this**, adding them again included. Only the person can, and only by filling in the sign-up link themselves.",
          "**No address on file** — nothing to send to.",
          "**Inactive** — off the roster entirely.",
        ],
      },
      {
        kind: "rule",
        title: "Their \"no\" outranks our \"but\"",
        text: "The two greyed-out reasons look identical to a sender and are completely different to us. One is our decision and ours to reverse. The other is theirs, and no conversation at an event changes it — if someone who unsubscribed wants back on, they re-subscribe themselves through the sign-up link. Re-adding them in the app will look like it worked and won't be.",
      },
      {
        kind: "p",
        text: "Taking someone off stops **both** email and texts in one action. That's on purpose: nobody who says \"stop emailing me\" means \"but keep texting me.\" It asks you to confirm first — a removal is a promise to a real person, and several at once is several promises.",
      },
      {
        kind: "heading",
        text: "Stop sending people Google Forms",
      },
      {
        kind: "p",
        text: "There's a sign-up link at the top of the Mailing list tab — copy it and share it. It goes to a page that writes straight into this list, with the person's name, what they agreed to, and the date. A Google Form put those names in a spreadsheet nothing else could see, so every signup was a manual re-entry away from being reachable, and nobody could answer \"did this person ever actually say yes?\"",
      },
      {
        kind: "tip",
        text: "In the app · Marketing → Mailing list. It's a grid, like People — tick rows to remove, put back, or export a batch at once, and tap a name to open that person's record. Export gives you the reachable people only: opted-out and unsubscribed addresses are never in the file, so you can paste it into Mailchimp without carrying a mistake across.",
      },
      {
        kind: "scenario",
        prompt:
          "Someone comes up to you after a gathering: \"I unsubscribed a while back but I do want the newsletter again.\" What do you do?",
        options: [
          {
            text: "Add them on the Mailing list tab — they asked, so it's handled.",
            feedback:
              "It'll look like it worked. It won't: an unsubscribe is address-level and adding someone again doesn't clear it, so they still get nothing and you won't find out for weeks.",
          },
          {
            text: "Hand them the sign-up link and let them re-subscribe themselves.",
            correct: true,
            feedback:
              "Right. Their own \"yes\" is the only thing that can undo their own \"no\" — and it lands with a fresh consent record and date.",
          },
          {
            text: "Ask a developer to delete the unsubscribe row.",
            feedback:
              "Nobody should be reaching into that ledger by hand, and it isn't necessary — the sign-up link is the supported path and it takes them thirty seconds.",
          },
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You've got a big event in six weeks and a small one this Saturday. The homepage is showing the small one. What do you change?",
        answer:
          "On Marketing → Links, open the Live event cards row and \"Lead with\" the six-week event — pins go first, in the order you set them, then everything else by date. Bump the count to 2 and both show. Check the preview underneath before you leave: it runs the same selection the site does.",
      },
    ],
    quiz: [
      {
        prompt: "You fix a typo in the homepage headline. What has to happen before it's live?",
        options: [
          "Someone has to approve it",
          "Nothing — it's live within about a minute",
          "A developer has to deploy the site",
          "It goes out with the next newsletter",
        ],
        answerIndex: 1,
        explanation:
          "Copy has no publish step and no deploy. That's the point of the desk — and it means nobody downstream catches your typo either.",
      },
      {
        prompt:
          "Someone's row says \"Unsubscribed or bounced\" and they've told you in person they want back on. What actually works?",
        options: [
          "Adding them again on the Mailing list tab",
          "Tapping \"Put back\"",
          "They re-subscribe themselves through the sign-up link",
          "Nothing — they can never receive our email again",
        ],
        answerIndex: 2,
        explanation:
          "That state came from the person or from a bounce, and nothing you do in the app clears it. Their own sign-up can — for an unsubscribe. A bounce or a spam complaint survives even that.",
      },
      {
        prompt: "You take someone off the mailing list. What stops?",
        options: [
          "Only the newsletter",
          "Only our text messages",
          "Both email and texts",
          "Everything, including their donation receipts",
        ],
        answerIndex: 2,
        explanation:
          "One action covers both channels — nobody who asks us to stop emailing means \"keep texting.\" Receipts and RSVP confirmations aren't marketing and keep arriving.",
      },
      {
        prompt: "You \"lead with\" an event whose RSVP page isn't published yet. What shows on the homepage?",
        options: [
          "The event, which publishes it automatically",
          "The event, linking to a page that 404s",
          "Nothing for that event — the pin is skipped",
          "An error on the links section",
        ],
        answerIndex: 2,
        explanation:
          "A pin can only reorder pages that are already publishable. Publish the RSVP page from its event first, then choose where it sits.",
      },
      {
        prompt: "What's in the mailing-list CSV export?",
        options: [
          "Everyone in the database",
          "Only people we can actually reach right now",
          "Everyone, with an \"opted out\" column",
          "Only people who signed up through the public form",
        ],
        answerIndex: 1,
        explanation:
          "Exports carry reachable people only, so an opt-out or a spam complaint can't be carried across into a sending tool by accident.",
      },
    ],
  },

  // ── 50 · Brand & Voice: the library and the blog ──────────────────────────
  {
    slug: "mktg-the-library-and-the-blog",
    title: "The library and the blog",
    subtitle: "Where the brand kit lives now, and who decides a post goes live",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Two of the marketing desk's tabs are the answer to questions this Academy has been answering in prose: **Designs** is the brand kit as a real thing you can open, and **Blog** is where the org's public writing is written.",
      },
      {
        kind: "heading",
        text: "Designs: anyone can look, marketing can change",
      },
      {
        kind: "p",
        text: "The colors, the typefaces, and the Canva and Figma files are all in **Marketing → Designs**, and you do not need a marketing seat to open it. That is deliberate, and it is the brand lesson's rule made real: if you are making a flyer at 11pm and you need the red, you should be able to get the red.",
      },
      {
        kind: "bullets",
        items: [
          "**Colors** — tap one to copy the hex. **PW Red is #891d1a** and it hasn't moved.",
          "**Fonts** — grouped by what each is for, so \"what do I set a headline in?\" has one answer.",
          "**Designs** — Canva and Figma files render right there; click through to open the real thing in the real tool. Anything else (a Dropbox folder, a Drive file) is a labelled link.",
          "**Folders** — marketing names them. \"Instagram posts\", \"Event flyers\", whatever matches how they actually work.",
        ],
      },
      {
        kind: "rule",
        title: "Link to the tool, not to the picture",
        text: "A design row points at the Canva or Figma file — the place you can actually edit it — not at an exported image. We learned this the expensive way with pasted newsletters: design tools' own image links expire, and a library full of dead thumbnails is worse than an empty one. The little preview image is one we host ourselves.",
      },
      {
        kind: "heading",
        text: "Blog: writing it and publishing it are two different jobs",
      },
      {
        kind: "p",
        text: "Posts live in **Marketing → Blog** now, not as files in the website's code, so writing one no longer needs a developer. But unlike everything else on this desk, putting one live is a separate permission.",
      },
      {
        kind: "table",
        headers: ["You can", "If you hold"],
        rows: [
          ["Write, edit, and revise a post", "Write blog posts"],
          ["Share a draft for review", "Write blog posts"],
          ["Put it on the internet, or take it down", "Publish blog posts"],
        ],
      },
      {
        kind: "rule",
        title: "A headline is a sentence. A post is an argument.",
        text: "You can fix the homepage's headline yourself, the moment you notice it — nobody approves that. A blog post is different in kind: it says what Public Worship believes, under Public Worship's name, and people quote it back years later. An edit can't un-say it. So the person who writes it and the person who decides it goes live are allowed to be two people, and on our chart usually are.",
      },
      {
        kind: "p",
        text: "**Sharing a draft doesn't mean publishing it briefly.** Every draft has its own private link you can send to whoever is reviewing — it stays out of search, and it can be revoked for that post alone.",
      },
      {
        kind: "scenario",
        prompt:
          "A post from last year says something the team no longer wants to stand behind. What do you do?",
        options: [
          {
            text: "Delete it, so it's gone.",
            feedback:
              "The app won't let you, and that's on purpose: people have that link in emails, in messages, in their notes. A 404 tells a reader we lost something rather than that we withdrew it.",
          },
          {
            text: "Take it down — the URL still works and says the post was taken down.",
            correct: true,
            feedback:
              "Right. Anyone who follows an old link gets an honest answer instead of a dead end, and the post stops being in the index, the feed, and search.",
          },
          {
            text: "Quietly rewrite it so it says something else.",
            feedback:
              "Tempting and wrong. If a post has changed materially it should say it was updated — the same rule the published finances follow when a figure is corrected.",
          },
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You're a Marketing Associate. You've finished a post and the Publish button won't do anything for you. What's actually happening, and what do you do?",
        answer:
          "Publishing is a separate permission and you don't hold it — that isn't a bug, it's the rule that a post goes out under the org's name with somebody accountable for it. Save it, copy the draft's preview link, and send it to the Marketing Director or the ED. Your draft is safe and nothing you wrote is lost.",
      },
    ],
    quiz: [
      {
        prompt: "Who can open Marketing → Designs and read the brand kit?",
        options: [
          "Only the Marketing Director",
          "Only people with a marketing seat",
          "Anyone signed in",
          "Nobody — it's a Dropbox folder",
        ],
        answerIndex: 2,
        explanation:
          "Reading is deliberately open to everyone; changing it is the part that's gated. Nobody should have to ask permission to look right.",
      },
      {
        prompt: "Why does a design row link to the Canva file rather than to an exported image?",
        options: [
          "Images are too large to store",
          "Design tools' own image links expire, and the library fills with dead thumbnails",
          "Canva doesn't allow image export",
          "It's an arbitrary preference",
        ],
        answerIndex: 1,
        explanation:
          "This already happened once with pasted newsletter designs. The link goes to the editable file; the small preview is one we host ourselves.",
      },
      {
        prompt:
          "You can edit the homepage's headline yourself with no approval. Why is a blog post different?",
        options: [
          "Blog posts are longer",
          "The blog is on a different server",
          "A post is an argument published under the org's name that gets quoted back later — an edit can't un-say it",
          "It isn't different; the rule is inconsistent",
        ],
        answerIndex: 2,
        explanation:
          "A headline is a sentence, fixable the moment it's noticed. A post is a position, and publishing one is closer to publishing the finances than to fixing a headline.",
      },
      {
        prompt: "How do you get a draft in front of a reviewer?",
        options: [
          "Publish it, then unpublish it after they've read it",
          "Copy the draft's own private preview link and send it",
          "Email them a screenshot",
          "Add them as an author",
        ],
        answerIndex: 1,
        explanation:
          "Every draft has its own link that stays out of search and can be revoked on its own. Publishing something \"briefly\" puts it in feeds and caches you don't control.",
      },
      {
        prompt: "What happens to the URL of a post that gets taken down?",
        options: [
          "It 404s",
          "It redirects to the blog index",
          "It keeps working and says the post was taken down",
          "It stays live but hidden from the index",
        ],
        answerIndex: 2,
        explanation:
          "A link that was shared once is shared forever. An honest \"this was taken down\" beats a dead end, and the post leaves the index, the feed, and search either way.",
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
      "anything on-brand — plus the Marketing desk: editing the homepage, the " +
      "link cards, and the mailing list. (The house caption voice is coming " +
      "soon, once the Marketing Director authors current guidance.)",
    icon: "pen-tool",
    moduleSlugs: ["mktg-the-look", "mktg-the-desk", "mktg-the-library-and-the-blog"],
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
