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
 *
 * CORRECTED 2026-08-28 (same day, third wave): both brand-kit lessons said
 * changing the kit "belongs to marketing" / "needs a marketing seat". That was
 * never quite the rule — the gate is a POWER, not a desk — and it became flatly
 * wrong when the founder had `marketing.designs.edit` granted to the ED and
 * every Chapter Director. Copy only: no section was added, moved, or resized,
 * so `academy.snapshot.test.ts`'s pinned minutes and quiz lengths are unchanged
 * (one paragraph is not a minute). Note both lessons still refuse to name a hex
 * or a face — `brandSingleSource.test.ts` enforces that, and the correction had
 * no reason to touch it.
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
    subtitle: "One red, a set of faces, and a kit anyone can open",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Every flyer, banner, overlay, and sign that says Public Worship should look like it came from the same place, even when a new chapter three time zones away made it. A brand kit gives you that without a bottleneck.",
      },
      {
        kind: "p",
        text: "**The kit lives in Marketing → Designs.** It answers every \"what red is it?\" question. This lesson does not print the hex codes or list the typefaces, on purpose. The designer changes those in the kit without filing a ticket, and a lesson that copied today's values would go wrong the day they change.",
      },
      {
        kind: "bullets",
        items: [
          "**Colors:** open Designs and tap one to copy its hex. The brand red has to appear somewhere on anything public-facing. It is also the default accent in the org's saved email templates, so an email and a flyer carry the same red.",
          "**Fonts:** grouped in Designs by role, so \"what do I set a headline in?\" has one answer. More than one face can share a job; the kit shows which.",
          "**Logos:** in Designs and the shared Logos folder they point at. Never recreate one from a screenshot.",
          "**Templates:** Canva files for the recurring shapes: flyers for distribution, banners, social media overlays, and signage. Duplicate a template instead of starting from a blank canvas.",
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
          ["The brand red, or any brand color", "Marketing → Designs, Colors (tap to copy)"],
          ["What to set a headline or caption in", "Marketing → Designs, Fonts (grouped by role)"],
          ["Logo (any format)", "Marketing → Designs, Logos folder"],
          ["A flyer, banner, overlay, or signage", "Marketing → Designs: open the Canva template and duplicate it"],
        ],
      },
      {
        kind: "rule",
        title: "Nobody should have to ask permission to look right",
        text: "A chapter in a new city should be able to make something unmistakably PW without messaging anyone. So reading the kit needs no seat: if you are making a flyer at 11pm, you can get the red. Changing the kit takes the \"Manage the brand kit\" power. The marketing chain holds it, and so do the Executive Director and every Chapter Director.",
      },
      {
        kind: "reveal",
        prompt:
          "A brand-new chapter needs a flyer for their first event and nobody from the founding team is reachable this week. What do they do?",
        answer:
          "They don't wait and they don't guess. Open Marketing → Designs, copy the brand color, take the logo from the Logos folder, duplicate the flyer template, and swap in the event details. Nobody eyeballs a red off an old JPEG.",
      },
      {
        kind: "link",
        label: "Further reading: PW Designs, Flyers, Fonts, Colors",
        url: "https://www.notion.so/29c7f1c177b680e49273d51138fc1677",
        note: "Background and history. Where the two disagree, the kit in Marketing → Designs is right, because the designer maintains it.",
      },
    ],
    quiz: [
      {
        prompt: "You need the exact brand red for a flyer. Where do you get it?",
        options: [
          "From this lesson, which writes the hex code down",
          "Marketing → Designs: open Colors and tap it to copy the hex",
          "Eyedropper it off the most recent flyer you can find",
          "Message the Marketing Director and wait",
        ],
        answerIndex: 1,
        explanation:
          "The kit is the only current copy. Training, old flyers, and memory are snapshots of the brand on the day they were made, and the designer can change it. Check the kit even when you think you know the answer.",
      },
      {
        prompt: "Who can open the brand kit, and who can change it?",
        options: [
          "Only the Marketing Director can do either",
          "Anyone can open it, and anyone can change it",
          "Anyone on the team can open it; changing it takes the brand-kit power",
          "You need a design seat even to look",
        ],
        answerIndex: 2,
        explanation:
          "Reading the kit is ungated on purpose: people work around a brand kit behind a permission, and the person making something at 11pm needs it. Changing it takes a named power, held by the marketing chain plus the ED and Chapter Directors, so the org keeps one look.",
      },
      {
        prompt: "The designer decides the org should use a different face for captions. What has to happen?",
        options: [
          "They edit the fonts in Marketing → Designs, and everyone reading the kit sees the new one",
          "A developer changes it in the code and ships a release",
          "Nothing can change; the brand faces are fixed",
          "Every chapter picks its own face from then on",
        ],
        answerIndex: 0,
        explanation:
          "The kit is the designer's to curate: add a face, change its role, reorder, or remove one. That is why it is a live tool and not documentation, and why this lesson points at the kit instead of listing faces.",
      },
      {
        prompt: "Why should a brand-new chapter be able to make an on-brand flyer without asking anyone?",
        options: [
          "Because design doesn't matter for a first event",
          "So the look stays consistent across every city without HQ becoming a bottleneck",
          "Because Canva requires no login",
          "It isn't possible; every design needs sign-off",
        ],
        answerIndex: 1,
        explanation:
          "The color, fonts, and templates are shared so consistency grows with the network instead of depending on one team's availability.",
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
        text: "In a busking setup, the keyboard, the mics, and the speaker all connect into the Zoom recorder. Do these three things before anyone plays a note.",
      },
      {
        kind: "bullets",
        items: [
          "**Connect in order:** keyboard, then mics, then speaker, each into the recorder.",
          "**Turn on the recorder** and check that every channel in use is lit **red**. Red means the recorder is receiving signal on that channel.",
          "**Hit record** and confirm it: the light next to the record button glows red once it is recording.",
        ],
      },
      {
        kind: "story",
        title: "Read the source",
        text: "\"HIT RECORD - PLS PLS PLS, you know it's recording when the light next to the button is red,\" says the Busking Setup doc. That is not the tone of a routine checklist. It reads like someone wrote it after packing up gear and finding nothing was captured. The wording survives because skipping this step has cost real recordings before.",
      },
      {
        kind: "rule",
        title: "Confirm red before a single note plays",
        text: "Channels lit red and the record light lit red are the only two signals that matter. If either isn't red, there is nothing to edit, sync, or post.",
      },
      {
        kind: "reveal",
        prompt:
          "You've been playing for ten minutes before you think to check whether the recorder is running. What now?",
        answer:
          "Check now, not after the set. If the channels or the record light aren't red, nothing has been captured, and the sooner you catch it the less you lose. Stopping to fix it beats finding out afterward that ten minutes are gone.",
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
          "Red is the signal for a live channel and for the record indicator. It is the one visual check the setup depends on.",
      },
      {
        prompt: "What connects into the Zoom recorder in a busking setup?",
        options: [
          "Only the mics",
          "The keyboard, the mics, and the speaker",
          "Just a single line-in cable",
          "Nothing; the recorder captures ambient room sound only",
        ],
        answerIndex: 1,
        explanation:
          "All three connect into the recorder so every source is captured.",
      },
      {
        prompt: "Why does the source document plead \"PLS PLS PLS\" about hitting record?",
        options: [
          "It's a stylistic quirk with no meaning",
          "Because forgetting to confirm recording has cost captured footage before",
          "Because the record button is hard to find",
          "It's a joke between the production team",
        ],
        answerIndex: 1,
        explanation:
          "The pleading reads as a lesson learned the hard way. The wording exists because skipping the check has lost recordings before.",
      },
      {
        prompt: "You realize partway through a set you never confirmed recording. What's the right move?",
        options: [
          "Finish the set, then check; it's probably fine",
          "Check immediately; if it isn't recording, catching it now loses less than catching it after",
          "Assume it's recording since the recorder is powered on",
          "Restart the whole session from the beginning regardless",
        ],
        answerIndex: 1,
        explanation:
          "The channel and record lights are the only real confirmation. Checking right away limits how much footage is lost.",
      },
    ],
  },

  // ── 48 · Media Pipeline: from shoot to timeline ────────────────────────────
  {
    slug: "mktg-shoot-to-timeline",
    title: "From shoot to timeline",
    subtitle: "The Editing Prep SOP: files uploaded, clips synced, ready to cut",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "With Editing Prep done, an editor opens a project and finds a synced master timeline, not a folder of loose clips. It's two jobs: upload and arrange every file, then sync it all into one long master timeline.",
      },
      {
        kind: "table",
        headers: ["Step", "What you do"],
        rows: [
          [
            "1. Copy the template",
            "Duplicate the project template, name it in the standard convention, \"Event - Lead Person\", and make sure proxies and originals are synced.",
          ],
          [
            "2. Upload the files",
            "Video and audio both go to Dropbox under Areas > Media. Pull audio from the Zoom recorder's micro-SD card, unless audio was recorded directly on camera. Then skip that step.",
          ],
          [
            "3. Arrange the bins",
            "All audio clips can share one bin. Separate video clips by the camera that shot them.",
          ],
          [
            "4. Build the master timeline",
            "Lay down the audio tracks first; audio usually runs the whole day across several mic channels. Then place each video clip, aligning it by listening to its audio against the timeline.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Audio first, video aligned to it",
        text: "Audio is usually the one continuous track of the whole day, even split across several mic channels. Lay it down first, then sync each video clip to it by ear. That builds one 1–3 hour master timeline without guessing at timestamps.",
      },
      {
        kind: "reveal",
        prompt:
          "Two SD cards come back from a shoot: one from the Zoom audio recorder, one from a camera that recorded its own audio too. Do you need the recorder's audio for that camera's clips?",
        answer:
          "No. If a camera recorded its own audio, you don't need the Zoom recorder's audio for that footage. The recorder's SD card matters for cameras or setups that didn't capture their own sound.",
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
          "\"Event - Lead Person\" is the standard, so anyone can find the right project later.",
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
          "Areas > Media in Dropbox is the shared destination for both video and audio on every prep pass.",
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
          "Even split across channels, audio usually spans the whole day. Video clips sync to it by ear instead of by guessed timestamps.",
      },
      {
        prompt: "When do you skip pulling audio from the Zoom recorder's micro-SD card?",
        options: [
          "Never; audio always comes from the recorder",
          "When the camera already recorded its own audio directly",
          "When the shoot is under an hour",
          "When there's only one camera",
        ],
        answerIndex: 1,
        explanation:
          "If audio was captured on camera, there's nothing to pull from the recorder for that footage.",
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
        text: "To open a shared project you need a Blackmagic Cloud account, DaVinci Resolve installed, and a place in the Public Worship org so the app can show you the projects. Each step goes through asking the right person or joining the right group, never a shared login.",
      },
      {
        kind: "bullets",
        items: [
          "**1. Create a Blackmagic Cloud account.** It's free, and your access is tied to it.",
          "**2. Install DaVinci Resolve.** The free version gets most editors 95% of the way. Color graders need **Resolve Studio**, the paid tier: same app, more features.",
          "**3. Ask an admin for org access.** Ask to be added to the Public Worship organization and the **Editors** group, using your Blackmagic Cloud email. Accept the email invite, then tell the admin so they can finish adding you to Editors.",
          "**4. Open Resolve and log in.** Sign into Blackmagic Cloud inside the app and choose the Public Worship profile. Every shared project appears.",
        ],
      },
      {
        kind: "p",
        text: "Dropbox works the same way: request to join the storage Google Group. If you edit or prep footage, also install Dropbox locally. Editing Prep depends on it, so for you it is required.",
      },
      {
        kind: "rule",
        title: "Ask, don't guess",
        text: "Every part of this setup starts with a request: an admin invite to the org and Editors group, or a request to join the storage group for Dropbox. Nobody gets in with a shared password. Ask the right person and wait for the invite.",
      },
      {
        kind: "reveal",
        prompt:
          "You're joining as a color grader. Which Resolve version do you need, and what do you need to request first?",
        answer:
          "Resolve Studio, because color grading needs the paid tier. First, though, an admin still has to add you to the Public Worship organization and the Editors group, using your Blackmagic Cloud email.",
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
          "The free version; it's enough for everyone",
          "Resolve Studio, the paid tier",
          "A special \"Colorist Edition\" that doesn't exist",
          "Either version, it makes no difference",
        ],
        answerIndex: 1,
        explanation:
          "The free version gets most editors 95% of the way, but color grading needs the paid Resolve Studio tier.",
      },
      {
        prompt: "How do you get added to the Public Worship organization and Editors group?",
        options: [
          "It happens automatically after installing Resolve",
          "You ask an admin to add you, using the same email as your Blackmagic Cloud account",
          "You email support@blackmagicdesign.com",
          "There's no group; every account gets full access",
        ],
        answerIndex: 1,
        explanation:
          "An admin grants org and Editors access on request. Ask using your Blackmagic Cloud email, then accept the invite.",
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
          "Access starts with a request to join the storage group, the same \"ask, don't guess\" pattern as DaVinci org access.",
      },
      {
        prompt: "Is installing Dropbox locally optional for someone doing editing prep?",
        options: [
          "Yes, always optional",
          "No. If you're editing or prepping footage, it's required",
          "Only optional for color graders",
          "Dropbox isn't used for editing at all",
        ],
        answerIndex: 1,
        explanation:
          "Dropbox is optional for browsing, but Editing Prep's upload steps need it installed locally.",
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
        text: "Marketing's work is entirely public. Changing a headline on publicworship.life, reordering the link cards, or adding someone to the newsletter used to mean asking a developer. Now it all lives in the **Marketing** tab in Chapter OS.",
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
        kind: "p",
        text: "**Site** copy has no publish step, review queue, or deploy. Each field saves when you tap away, and the live page shows the new words within about a minute. Nobody downstream catches a typo for you. A field's counter turns red before its limit, which is where the design breaks.",
      },
      {
        kind: "p",
        text: "On **Links**, each card has a show/hide switch, so you can build one before its announcement goes out. The **Live event cards** row is the rule for the event pages the homepage pulls in automatically. Set how many show, \"Lead with\" a specific event, or keep one off the front page. Pins go first in the order you set, then the rest by date. The preview underneath runs the same selection the site does.",
      },
      {
        kind: "rule",
        title: "Only what's already published can be pinned",
        text: "Leading with an event doesn't publish it. If its RSVP page isn't live, the pin is skipped, so the front page never links to a 404. Publish the page from the event first, then choose where it sits.",
      },
      {
        kind: "table",
        headers: ["Greyed out as", "What it means"],
        rows: [
          ["Opted out", "Someone at the org marked this person not to be marketed to. You can put them back."],
          [
            "Unsubscribed or bounced",
            "The person clicked unsubscribe, texted STOP, or the address hard-bounced. Nothing you do in the app undoes this, adding them again included.",
          ],
          ["No address on file", "Nothing to send to."],
          ["Inactive", "Off the roster entirely."],
        ],
      },
      {
        kind: "rule",
        title: "Their \"no\" outranks our \"but\"",
        text: "Opted out is our decision and ours to reverse. Unsubscribed is theirs, and no conversation at an event changes it. Re-adding them in the app looks like it worked and doesn't. Only the person can undo it, by re-subscribing through the sign-up link.",
      },
      {
        kind: "tip",
        text: "In the app · Marketing → Mailing list. It holds every person the OS already knows, so adding a donor updates their record and a new name also appears on People. Share the sign-up link at the top instead of a Google Form: it records the name, what they agreed to, and the date. Removing someone stops **both** email and texts, after you confirm. Export holds reachable people only, so opted-out and unsubscribed addresses never reach Mailchimp.",
      },
      {
        kind: "scenario",
        prompt:
          "Someone comes up to you after a gathering: \"I unsubscribed a while back but I do want the newsletter again.\" What do you do?",
        options: [
          {
            text: "Add them on the Mailing list tab. They asked, so it's handled.",
            feedback:
              "It will look like it worked. It won't: an unsubscribe is address-level and adding someone again doesn't clear it, so they still get nothing and you won't find out for weeks.",
          },
          {
            text: "Hand them the sign-up link and let them re-subscribe themselves.",
            correct: true,
            feedback:
              "Right. Only their own \"yes\" can undo their own \"no\", and it lands with a fresh consent record and date.",
          },
          {
            text: "Ask a developer to delete the unsubscribe row.",
            feedback:
              "Nobody should edit that ledger by hand, and there's no need. The sign-up link is the supported path and takes them thirty seconds.",
          },
        ],
      },
    ],
    quiz: [
      {
        prompt: "You fix a typo in the homepage headline. What has to happen before it's live?",
        options: [
          "Someone has to approve it",
          "Nothing; it's live within about a minute",
          "A developer has to deploy the site",
          "It goes out with the next newsletter",
        ],
        answerIndex: 1,
        explanation:
          "Copy has no publish step and no deploy. That's the point of the desk, and it means nobody downstream catches your typo.",
      },
      {
        prompt:
          "Someone's row says \"Unsubscribed or bounced\" and they've told you in person they want back on. What actually works?",
        options: [
          "Adding them again on the Mailing list tab",
          "Tapping \"Put back\"",
          "They re-subscribe themselves through the sign-up link",
          "Nothing; they can never receive our email again",
        ],
        answerIndex: 2,
        explanation:
          "That state came from the person or a bounce, and nothing you do in the app clears it. Their own sign-up clears an unsubscribe. A bounce or a spam complaint survives even that.",
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
          "One action covers both channels: nobody who asks us to stop emailing means \"keep texting.\" Receipts and RSVP confirmations aren't marketing and keep arriving.",
      },
      {
        prompt: "You \"lead with\" an event whose RSVP page isn't published yet. What shows on the homepage?",
        options: [
          "The event, which publishes it automatically",
          "The event, linking to a page that 404s",
          "Nothing for that event; the pin is skipped",
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
          "Exports carry reachable people only, so an opt-out or a spam complaint can't slip into a sending tool by accident.",
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
        text: "**Marketing → Designs** holds the brand kit: the colors, the typefaces, and the Canva and Figma files. You need no seat to open it, so a flyer made at 11pm can still get the brand red. Changing the kit takes the \"Manage the brand kit\" power, not a desk. The marketing chain holds it, and so do the Executive Director and every **Chapter Director**. A Chapter Director editing the kit edits the org's one brand, not a chapter copy.",
      },
      {
        kind: "table",
        headers: ["In Designs", "How it works"],
        rows: [
          [
            "Folders",
            "The shelves down the side; everything lives on one. A folder can mix colors, typefaces, and the posters made from them, so \"Easter 2026\" holds an event's whole look. Marketing names them.",
          ],
          [
            "Design files",
            "Link to the editable Canva or Figma file, not an exported image: design tools' image links expire, as pasted newsletters taught us. We host the small preview. Anything else (a Dropbox folder, a Drive file) is a labelled link.",
          ],
          [
            "Photos and clips",
            "Press Upload on any folder and pick many files at once. Each becomes its own row, named after its file. Video plays in the web app and opens in your phone's player on mobile.",
          ],
          [
            "Colors",
            "Tap one to copy the hex. Nothing else in the Academy prints the brand red, so there is one answer to check.",
          ],
          [
            "Faces",
            "Each shows as a specimen set in that face. If your device can't show one, the card says so and offers the download instead of a lookalike. The designer curates the list, including more than one face per job.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "\"Colors\" is a folder, not a fixed part of the screen",
        text: "The palette and the typefaces sit in two pinned folders; pinning gives a folder its own section on the page. Any folder can be pinned, such as a season's look. One thing can be in several folders: the brand red is in Colors and in the event folder that uses it. Removing it from the event leaves the palette alone. Nothing is copied.",
      },
      {
        kind: "p",
        text: "Posts live in **Marketing → Blog**, not in the website's code, so writing one needs no developer. Unlike the rest of the desk, putting a post live is a separate permission. Every draft has its own private preview link for reviewers. It stays out of search and can be revoked for that post alone, so never publish a draft briefly.",
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
        text: "You fix the homepage headline yourself, with no approval. A post says what Public Worship believes, under its name, and people quote it back years later. An edit can't un-say it. So the writer and the person who publishes can be two people, and on our chart usually are.",
      },
      {
        kind: "scenario",
        prompt:
          "A post from last year says something the team no longer wants to stand behind. What do you do?",
        options: [
          {
            text: "Delete it, so it's gone.",
            feedback:
              "The app won't let you, on purpose: people have that link in emails, messages, and notes. A 404 tells a reader we lost something, not that we withdrew it.",
          },
          {
            text: "Take it down. The URL still works and says the post was taken down.",
            correct: true,
            feedback:
              "Right. An old link gets an honest answer instead of a dead end, and the post leaves the index, the feed, and search.",
          },
          {
            text: "Quietly rewrite it so it says something else.",
            feedback:
              "Wrong. A post that changed materially should say it was updated, the same rule the published finances follow when a figure is corrected.",
          },
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You're a Marketing Associate. You've finished a post and the Publish button won't do anything for you. What's happening, and what do you do?",
        answer:
          "Publishing is a separate permission you don't hold. That's the rule, not a bug: a post goes out under the org's name with somebody accountable for it. Save it, copy the draft's preview link, and send it to the Marketing Director or the ED. Your draft is safe.",
      },
    ],
    quiz: [
      {
        prompt: "Who can open Marketing → Designs and read the brand kit?",
        options: [
          "Only the Marketing Director",
          "Only people with a marketing seat",
          "Anyone signed in",
          "Nobody; it's a Dropbox folder",
        ],
        answerIndex: 2,
        explanation:
          "Reading is open to everyone on purpose. Changing it takes the \"Manage the brand kit\" power, held by the marketing chain, the ED, and Chapter Directors. Nobody should have to ask permission to look right.",
      },
      {
        prompt:
          "You add the brand red to an \"Easter 2026\" folder. What happens to the Colors folder it was already in?",
        options: [
          "It leaves Colors; a thing can only be in one folder",
          "Nothing. It is in both, and it is still one color",
          "The red is copied, so there are now two of them",
          "Colors is locked and cannot be changed",
        ],
        answerIndex: 1,
        explanation:
          "Folders hold things by reference, the way a playlist holds a song. Being in the event folder costs the palette nothing, and because nothing was copied there is still exactly one red to correct if it ever changes.",
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
          "A post is an argument published under the org's name that gets quoted back later; an edit can't un-say it",
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
      "The PW look: the color, fonts, and self-serve templates that keep " +
      "anything on-brand. Plus the Marketing desk: the homepage, the link " +
      "cards, the mailing list, the design library, and the blog. The house " +
      "caption voice comes once the Marketing Director writes current guidance.",
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
      "field-capture habits, the Editing Prep SOP, and access to the tools. " +
      "Ads/pixel setup is coming, and so is a short-form video-editing " +
      "standard once the Marketing Director writes current guidance.",
    icon: "hard-drive",
    moduleSlugs: ["mktg-hit-record", "mktg-shoot-to-timeline", "mktg-getting-access"],
  },
];
