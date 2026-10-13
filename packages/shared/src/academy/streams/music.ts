/**
 * The Music stream — the doxological-worship songwriting/song-selection
 * framework, the worship-leader submission checklist, the producer/artist
 * roles, and how a collaborator is compensated on a release. Also the Music
 * theme + its four courses.
 *
 * Content is authored, with strict fidelity, FROM three archived Notion
 * sources (verbatim archives of `bedecked-mandrill-c8b.notion.site`, captured
 * 2026-07-17 — see each `link` block's "Further reading" for the internal
 * notion.so URL):
 *  - "PW Songwriting & Song Selection Philosophy (Draft)" — the doxological
 *    framework itself (Course 1, lessons 1–2 and 5).
 *  - "Song Catalog: Doxological Analysis" — the line-by-line case-study
 *    catalog the `reveal` blocks in lessons 3–4 quote from.
 *  - "Worship Leader Checklist" (Course 2), "Music Producers: Understanding
 *    the Role" and "Artists: Understanding the Role" (Course 3).
 *
 * This content compresses; it does not extrapolate. Definitions, scripture
 * anchors, and category names (ascription / offering / diminishment /
 * surrender; discoverer / recipient / testifier / resolved / petitioner) are
 * the source's own, unchanged. Personal names in the source docs ("let me or
 * Ella know") are depersonalized to role references ("your Music Lead") —
 * the doctrine and checklists are unchanged, only the process anchor.
 *
 * Course 4 (Collaborating on a Release) and the `music-inviting-a-collaborator`
 * lesson are authored FROM the two PUBLISHED pages the org already points
 * collaborators at — `publicworship.life/collaborate` (the by-role/by-situation
 * walkthrough, `apps/landing/src/pages/collaborate.astro`) and
 * `publicworship.life/music-policy` (the canonical policy,
 * `apps/landing/src/pages/music-policy.astro`). Those pages are CANONICAL: the
 * rate-sheet numbers, the 15-point Primary Artist baseline, and the 50-point
 * cap are mirrored here for teaching, never restated differently. When a rate
 * or a rule changes on the landing pages, these lessons change in the same PR.
 *
 * Owned exclusively by this file for content authoring — do not add Music
 * sections or courses anywhere else. See `../index` for how this assembles
 * into the full curriculum/catalog.
 */

import type {
  AcademySection,
  Course,
  Theme,
} from "../types";

/** The Music-stream sections, in curriculum order. */
export const MUSIC_SECTIONS: Omit<AcademySection, "order">[] = [
  // ══ Music ═══════════════════════════════════════════════════════════════
  // Course 1 (Doxology: What We Sing) condenses "PW Songwriting & Song
  // Selection Philosophy (Draft)" and quotes case studies from "Song Catalog:
  // Doxological Analysis". Course 2 (Leading Worship) is the worship-leader
  // submission checklist. Course 3 (Producing & Artistry) covers the
  // producer and artist role essays.

  // ── 1 · Doxology: worship is a sacrifice ───────────────────────────────────
  {
    slug: "music-worship-is-a-sacrifice",
    title: "Worship is a sacrifice",
    subtitle: "Doxa and logos: the content is God, not us",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: 'Doxology joins two Greek words: **doxa** (δόξα: glory, the weight and visible splendor of who God is) and **logos** (λόγος: word or declaration). A doxology declares God\'s glory. Examples include the Gloria Patri, "Praise God from whom all blessings flow," Romans 11:36 ("To him be the glory forever") and the angels\' "Holy, holy, holy" (Isa 6:3; Rev 4:8).',
      },
      {
        kind: "rule",
        title: "The content is God, not us",
        text: "A doxology does not report what God did for me or how I feel about Him. It declares who God is (His character, His acts, His worth) and stops there. The worshiper may be present, but only as the voice carrying the declaration, never as its subject.",
      },
      {
        kind: "p",
        text: "The Old Testament Hebrew for worship, **shâchâh**, means to bow down. In John 4, Jesus says the Father seeks worshipers who worship in spirit and in truth. Hebrews 13:15 calls it a **sacrifice of praise**, the fruit of lips that openly profess his name. Three anchors: worship is a bow, offered in truth, and a sacrifice laid at God's feet.",
      },
      {
        kind: "rule",
        title: "A song whose lyrics never leave the worshiper has not yet brought a sacrifice",
        text: "Romans 12:1 calls worship a sacrifice: something carried out of the worshiper's possession and laid before God. A song that never gets past the worshiper's own story brings feeling, sometimes deep feeling, but gives nothing.",
      },
      {
        kind: "p",
        text: "Not every worship song must be doxological. Lament, testimony, confession and petition are faithful in their proper moment. As a steady diet, they train a congregation to think only about itself: its situation, journey, longings and sins. Doxology leaves the least room for unintentional self-idolatry, because when a song's entire content is who God is, the singer cannot take the center. Other forms need more vigilance: the self is one careless line away.",
      },
      {
        kind: "reveal",
        prompt:
          "A congregation sings a beautiful song about how safe and loved they feel this morning. Has a sacrifice been brought?",
        answer:
          "Not by this song alone. The feeling is real, but lyrics that never leave the worshiper's own feelings lay nothing at God's feet. Another song in the set can still bring the sacrifice of praise.",
      },
      {
        kind: "link",
        label: "Further reading: PW Songwriting & Song Selection Philosophy (Draft)",
        url: "https://www.notion.so/1792e8b016ec4b00b589344e95b55538",
      },
    ],
    quiz: [
      {
        prompt: "What do the two Greek words behind \"doxology\" mean?",
        options: [
          "Doxa = song, logos = melody",
          "Doxa = glory, logos = word or declaration",
          "Doxa = praise team, logos = lyrics",
          "Doxa = worship, logos = leader",
        ],
        answerIndex: 1,
        explanation:
          "Doxa is glory, the weight and visible splendor of who God is. Logos is word or declaration. A doxology is a declaration of God's glory.",
      },
      {
        prompt: "What is the common thread across every doxology, from the Gloria Patri to Romans 11:36?",
        options: [
          "They all use the word \"holy\"",
          "The content is God, not us: they declare who He is and stop there",
          "They're all sung, never spoken",
          "They all come from the book of Psalms",
        ],
        answerIndex: 1,
        explanation:
          "A doxology doesn't report what God did for me or how I feel about Him. It declares who He is and stops. The worshiper may carry the declaration but is never its subject.",
      },
      {
        prompt: "What does Hebrews 13:15 call worship?",
        options: [
          "A feeling of gratitude",
          "A sacrifice of praise, the fruit of lips that openly profess His name",
          "A weekly obligation",
          "A performance for the congregation",
        ],
        answerIndex: 1,
        explanation:
          "Hebrews 13:15's \"sacrifice of praise\" is one of three anchors, with shâchâh (to bow) and worship \"in spirit and in truth\". Together they say worship is something given, not only felt.",
      },
      {
        prompt: "What does it mean for a song's lyrics to \"never leave the worshiper\"?",
        options: [
          "The song is too long",
          "The lyrics stay inside the worshiper's own story or feelings and never declare anything about God",
          "The worshiper forgets the words",
          "The song isn't in the church's usual key",
        ],
        answerIndex: 1,
        explanation:
          "A sacrifice is carried out of the worshiper's possession and laid down before God. A song that never gets past the worshiper's own experience, however moving, hasn't made that trip. Feeling happened; nothing was given.",
      },
    ],
  },

  // ── 2 · Doxology: the test ──────────────────────────────────────────────
  {
    slug: "music-the-test",
    title: "The test",
    subtitle: "Judge the function, never the pronoun",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "For any lyric we've written or might lead, we ask **what the function of the worshiper's presence is**. Is she giving something to God, or reporting something about herself? The function decides it, not the pronoun.",
      },
      {
        kind: "rule",
        title: "The test is grammatical-person-blind",
        text: 'Swapping "I" for "we" does not move a song from one zone to the other. "We\'ll never be more loved than we are right now" is still self as recipient of affection, only collective. Read for function, not for pronoun.',
      },
      { kind: "heading", text: "Why pronoun-counting fails" },
      {
        kind: "p",
        text: 'Possessives work the same way. "My King, my Rock, my Savior" is relational ascription: it names God by what He is, and "my" means covenant, not experience. "My story, my journey, my experience" is testimony, with the worshiper\'s biography as content. Same pronoun, opposite function.',
      },
      {
        kind: "p",
        text: '"When I in awesome wonder consider all the worlds Thy hands have made" uses "I" to give consideration outward, toward God\'s works. That is offering, and welcome. "Who thought I\'d find You at the lowest place?" uses "I" to report personal surprise. That is testimony, and not the diet. Both have "I" as subject; the function is opposite.',
      },
      {
        kind: "reveal",
        prompt:
          "\"Take my life and let it be consecrated, Lord, to Thee.\" Self surrenders using \"my life.\" Does the possessive make this about the worshiper?",
        answer:
          "No. Direction matters, not the possessive. \"My life\" is being GIVEN to God, yielded to His authority, so the line runs outward. \"My story, my journey\" uses the same word but makes the worshiper's own biography the content.",
      },
      {
        kind: "link",
        label: "Further reading: PW Songwriting & Song Selection Philosophy (Draft)",
        url: "https://www.notion.so/1792e8b016ec4b00b589344e95b55538",
      },
    ],
    quiz: [
      {
        prompt: "What does the test actually ask about a lyric?",
        options: [
          "Whether it uses \"I\" or \"we\"",
          "What the function of the worshiper's presence is: giving to God, or reporting about herself",
          "Whether it rhymes",
          "How many times God is mentioned by name",
        ],
        answerIndex: 1,
        explanation:
          "The test asks whether the worshiper's presence is there to give something to God or to report something about herself. The pronoun never settles it.",
      },
      {
        prompt: "Why does counting \"I\" vs. \"we\" fail as a test?",
        options: [
          "Because \"we\" always drifts to testimony",
          "Because the test is grammatical-person-blind: \"We'll never be more loved than we are right now\" is still self as recipient, only collective",
          "Because congregations only sing \"we\"",
          "Because \"I\" is always doxological",
        ],
        answerIndex: 1,
        explanation:
          "Swapping the pronoun doesn't change the function. A song about receiving love is about receiving love whether it says \"I\" or \"we\".",
      },
      {
        prompt: "\"My King, my Rock, my Savior\" and \"My story, my journey, my experience\" share the same possessive. What's true?",
        options: [
          "They're both testimony because they both use \"my\"",
          "They're opposite functions: the first names God by covenant relationship (ascription), the second makes the worshiper's biography the content (testimony)",
          "Neither passes the test",
          "Possessives always fail the test",
        ],
        answerIndex: 1,
        explanation:
          "Same pronoun, opposite function. \"My\" can mean covenant (naming who God is to me) or it can make the worshiper's own story the subject.",
      },
      {
        prompt: "\"When I in awesome wonder consider all the worlds Thy hands have made\": what makes this offering, not testimony, despite the \"I\"?",
        options: [
          "It's an old hymn, so it's automatically doxological",
          "\"I\" gives consideration outward, toward God's works; the direction is Godward, not inward",
          "It doesn't mention God directly",
          "It has more words than a typical testimony line",
        ],
        answerIndex: 1,
        explanation:
          "\"Consider\" points outward at God's works. The worshiper's faculties are the instrument; God's works are the content. A line where \"I\" reports personal surprise has the same subject and the opposite function.",
      },
    ],
  },

  // ── 3 · Doxology: four shapes of praise ────────────────────────────────
  {
    slug: "music-four-shapes-of-praise",
    title: "Four shapes of praise",
    subtitle: "Ascription, offering, diminishment, surrender",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Ascription is the core of doxological worship, the purest form. The other three shapes are ways the worshiper's presence serves the declaration of God's glory instead of competing with it.",
      },
      {
        kind: "table",
        headers: ["Shape", "What it is", "Scripture anchor"],
        rows: [
          [
            "**Ascription** (pure doxology)",
            "Direct declaration of who God is and what He has done. The worshiper may be entirely absent, or present only as \"we who declare.\"",
            "Isa 6:3; Rev 4:8; Rev 5:12; Ps 99; Phil 2:6–11; Col 1:15–20",
          ],
          [
            "**Offering** (instrumental doxology)",
            "Self as the giver of attention, wonder, voice, awe: faculties turned Godward as instruments of the declaration. \"Bless the Lord, O my soul\" is the classic example. The soul is the addressee; God is the destination.",
            "Ps 34:3; Ps 103:1; Ps 121:1; Ps 145:1–2; Lk 1:46",
          ],
          [
            "**Diminishment** (inverse doxology)",
            "Self appears only to be made small so that God's glory appears larger. \"He must increase, I must decrease.\"",
            "Job 40:4; Isa 6:5; Lk 5:8; Gen 18:27; Jn 3:30",
          ],
          [
            "**Surrender** (embodied doxology)",
            "Self appears only to be yielded to God's authority. The worshiper's life becomes a declaration of His lordship.",
            "Rom 12:1; Lk 22:42; Lk 1:38; Isa 6:8",
          ],
        ],
      },
      {
        kind: "rule",
        title: "The welcome zone has four shapes",
        text: "Self appears only to make God greater, or not at all. Each shape points the same declaration back at Him: ascribing His worth, offering your faculties to it, shrinking beneath it, or yielding your life to it.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study: \"A thousand generations falling down in worship, to sing the song of ages to the Lamb\" (Holy Forever). Which shape, and why?",
        answer:
          "Ascription. The worshiper disappears into \"a thousand generations\". The content is the Lamb receiving worship across all time, not the worshiper's experience. The catalog rates the whole song doxological throughout on this pattern.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study: \"O Lord my God, when I in awesome wonder, consider all the worlds Thy hands have made\" (How Great Thou Art, v.1). Which shape?",
        answer:
          "Offering, the philosophy's own canonical example. \"I\" gives wonder, sight and hearing, turned outward to God's works. The worshiper's faculties are the instrument of the declaration, not its content.",
      },
      {
        kind: "link",
        label: "Further reading: PW Songwriting & Song Selection Philosophy (Draft)",
        url: "https://www.notion.so/1792e8b016ec4b00b589344e95b55538",
      },
      {
        kind: "link",
        label: "Further reading: Song Catalog: Doxological Analysis",
        url: "https://www.notion.so/e4d4cb6526964258a320a06f800c1f38",
      },
    ],
    quiz: [
      {
        prompt: "Which shape is described as \"the core of doxological worship, the purest form\"?",
        options: ["Offering", "Ascription", "Diminishment", "Surrender"],
        answerIndex: 1,
        explanation:
          "Ascription, the direct declaration of who God is, is the center. Offering, diminishment and surrender are ways the worshiper's presence serves that declaration instead of competing with it.",
      },
      {
        prompt: "\"Bless the Lord, O my soul\" is the classic example of which shape?",
        options: ["Ascription", "Offering", "Diminishment", "Surrender"],
        answerIndex: 1,
        explanation:
          "Offering. The soul is addressed as the instrument and God is the destination. The worshiper's voice, attention and wonder are turned Godward as instruments of the declaration.",
      },
      {
        prompt: "\"He must increase, I must decrease\" is the shape of...",
        options: ["Offering", "Surrender", "Diminishment", "Ascription"],
        answerIndex: 2,
        explanation:
          "Diminishment, or inverse doxology. Self appears only to be made small so God's glory appears larger by contrast.",
      },
      {
        prompt: "What do all four welcome shapes have in common?",
        options: [
          "They all use the pronoun \"we\"",
          "Self appears only to make God greater, or not at all",
          "They're all from the book of Psalms",
          "They all avoid mentioning the worshiper's feelings",
        ],
        answerIndex: 1,
        explanation:
          "Ascription, offering, diminishment and surrender all aim at making God greater. When self shows up in one of these shapes, it serves the declaration instead of competing with it.",
      },
    ],
  },

  // ── 4 · Doxology: the five drifts ──────────────────────────────────────
  {
    slug: "music-the-five-drifts",
    title: "The five drifts",
    subtitle: "Discoverer, recipient, testifier, resolved, petitioner: not the diet",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Songs outside the welcome zone are not bad. They are anthropological, not doxological: their content is the human experience of God, not God Himself. Lament, testimony, confession and petition are faithful forms of worship in their proper place. We sing these. We do not build our identity around them, because the church already has them in abundance.",
      },
      {
        kind: "table",
        headers: ["Anthropological shape", "What it is", "Example"],
        rows: [
          [
            "**Discoverer**",
            "Self as the one whose surprise or realization is the song's content",
            "\"Who thought I'd find You at the lowest place?\"",
          ],
          [
            "**Recipient**",
            "Self as the recipient of affection, identity, or security",
            "\"I'll never be more loved than I am right now\"",
          ],
          [
            "**Testifier**",
            "Self recounting what God did for me",
            "\"He makes me lie down in green pastures\"",
          ],
          [
            "**Resolved**",
            "Self as the strategist, committer, or one who promises",
            "\"I'll never let go of Your hand\"",
          ],
          [
            "**Petitioner**",
            "Self as supplicant: asking, requesting, naming need",
            "\"Open the eyes of my heart, Lord\"",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Not forbidden, not the diet",
        text: "The welcome zone has four shapes; the not-the-diet zone has five. None of the five is wrong to sing. But a catalog built mainly from them trains a congregation to spend the whole set thinking about itself, moved but never past its own perimeter.",
      },
      { kind: "heading", text: "How the drift happens" },
      {
        kind: "bullets",
        items: [
          "Each doxological shape can slide into its anthropological cousin, usually mid-line and rarely on purpose. The gravity of the worshiper's own story pulls the line back to herself.",
          "**Ascription drifts to testimony:** \"You are Faithful Father, never failing\" becomes \"You've never failed me yet.\"",
          "**Offering drifts to recipient:** \"I lift my hands to bless the Lord\" becomes \"I lift my hands to receive all You have for me.\"",
          "**Diminishment drifts to discoverer:** \"I am nothing without You\" becomes \"how did I get this lucky?\"",
          "**Surrender drifts to resolved:** \"Have Your way in me\" becomes \"I'll never let go of Your hand.\"",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "Case study: \"All my life You have been faithful, all my life You have been so, so good\" (Goodness of God). Ascription, or a drift into testimony?",
        answer:
          "Testimony. The catalog rates the whole song anthropological. Plain ascription says \"You are faithful\"; the \"all my life\" prefix turns that declaration about God into biography about the worshiper. It is the classic drift from ascription to testimony.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study: \"Open up my eyes in wonder, and show me who You are and fill me with Your heart\" (Build My Life, chorus). Which anthropological shape?",
        answer:
          "Self as petitioner, the fifth anthropological shape. \"Open, show, fill, lead\" all ask God to act on the worshiper, so the direction reverses from giving to receiving. It is the same shape as \"Open the eyes of my heart, Lord\" in the table.",
      },
      {
        kind: "link",
        label: "Further reading: PW Songwriting & Song Selection Philosophy (Draft)",
        url: "https://www.notion.so/1792e8b016ec4b00b589344e95b55538",
      },
      {
        kind: "link",
        label: "Further reading: Song Catalog: Doxological Analysis",
        url: "https://www.notion.so/e4d4cb6526964258a320a06f800c1f38",
      },
    ],
    quiz: [
      {
        prompt: "How many anthropological shapes are there, versus doxological shapes?",
        options: [
          "Four anthropological, five doxological",
          "Five anthropological, four doxological",
          "Three and three",
          "They're the same five shapes, viewed differently",
        ],
        answerIndex: 1,
        explanation:
          "The welcome zone has four shapes (ascription, offering, diminishment, surrender). The not-the-diet zone has five (discoverer, recipient, testifier, resolved, petitioner), and self carries the song in every one of them.",
      },
      {
        prompt: "Are the five anthropological shapes forbidden?",
        options: [
          "Yes, they should never be sung",
          "No. They're faithful forms of worship in their proper place; the concern is making them the steady diet",
          "Only \"petitioner\" is forbidden",
          "Only in congregational settings",
        ],
        answerIndex: 1,
        explanation:
          "Not the diet, not forbidden. Lament, testimony, confession and petition are faithful in their place. The conviction is against building a catalog's identity around them, not against singing them.",
      },
      {
        prompt: "\"Have Your way in me\" drifting to \"I'll never let go of Your hand\" is an example of which drift pair?",
        options: [
          "Ascription to testimony",
          "Offering to recipient",
          "Surrender to resolved",
          "Diminishment to discoverer",
        ],
        answerIndex: 2,
        explanation:
          "Surrender (yielding to God's authority) drifts to resolved (the worshiper's own promise or commitment). The energy moves from God acting on the worshiper to the worshiper's resolve about herself.",
      },
      {
        prompt: "What causes the drift from a doxological shape to its anthropological cousin, according to the philosophy?",
        options: [
          "Bad theology on the songwriter's part, always deliberate",
          "The gravity of the worshiper's own story pulling the line back to herself, rarely deliberate",
          "Using contemporary instrumentation",
          "Singing in the first person",
        ],
        answerIndex: 1,
        explanation:
          "The drift is rarely a deliberate choice. The worshiper's own story pulls the line back mid-line, which is why the test is applied line by line, not only to a song's overall theme.",
      },
    ],
  },

  // ── 5 · Doxology: running the room ─────────────────────────────────────
  {
    slug: "music-running-the-room",
    title: "Running the room",
    subtitle: "A steward for the test, the same standard for every song",
    minutes: 3,
    blocks: [
      {
        kind: "bullets",
        items: [
          "**Theological soundness, non-negotiable.** Every release is checked against Scripture and our Statement of Beliefs.",
          "**Writers as stewards of the test.** Every writing room has someone whose job is to apply the test to the lyric before the song leaves the room.",
          "**The same standard for songs we did not write.** When we lead a cover, a hymn, or a worship song already in circulation, it goes through the same test. Popularity does not exempt it.",
          "**Singability.** Songs are ideally written so a congregation can sing them in the rooms where we lead worship.",
        ],
      },
      {
        kind: "rule",
        title: "Fear of God in the room",
        text: "We approach songwriting that calls itself worship as people who will give an account. \"The fear of the LORD is the beginning of wisdom\" (Proverbs 9:10).",
      },
      {
        kind: "p",
        text: "We begin with bowing, not method. We will fail, and when we do, we want to be told, with Scripture in hand. Every song is submitted to God and to His people, whether we wrote it or are leading it this Sunday.",
      },
      {
        kind: "reveal",
        prompt:
          "Your team wants to cover a wildly popular new worship song everyone already knows. Does its popularity mean it skips the test?",
        answer:
          "No. A cover, a hymn or a radio hit goes through the same line-by-line test as an original.",
      },
      {
        kind: "link",
        label: "Further reading: PW Songwriting & Song Selection Philosophy (Draft)",
        url: "https://www.notion.so/1792e8b016ec4b00b589344e95b55538",
      },
    ],
    quiz: [
      {
        prompt: "What is the test-steward's job in a writing room?",
        options: [
          "To write every lyric alone",
          "To apply the test to the lyric before the song leaves the room",
          "To approve the budget for recording",
          "To choose the key the song is played in",
        ],
        answerIndex: 1,
        explanation:
          "Every writing room has someone whose job is applying the doxological test to the lyric before the song leaves the room. The standard is a role, not an afterthought.",
      },
      {
        prompt: "Does a song's popularity exempt it from the test when leading a cover?",
        options: [
          "Yes, popular songs are already vetted by their success",
          "No. A cover, hymn or already-circulating worship song goes through the same test as an original",
          "Only hymns are exempt",
          "Only if the artist is well-known",
        ],
        answerIndex: 1,
        explanation:
          "The same standard applies whether the song is new or already in wide circulation. Popularity is not a substitute for the test.",
      },
      {
        prompt: "What does \"fear of God in the room\" mean in practice?",
        options: [
          "Being anxious while writing",
          "Approaching songwriting that calls itself worship as people who will give an account for it",
          "Avoiding certain musical keys",
          "Writing only from a place of fear rather than joy",
        ],
        answerIndex: 1,
        explanation:
          "It's a posture, not an emotion: writing worship songs as people who will answer for what they put in a congregation's mouth.",
      },
    ],
  },

  // ── 6 · Leading Worship: submitting a song ─────────────────────────────
  {
    slug: "music-submitting-a-song",
    title: "Submitting a song",
    subtitle: "What to bring before you lead it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Before you lead a song (a cover, a hymn or something new), work through this checklist with your Music Lead. It tells the whole team (accompanists, harmony singers, sound) what you're bringing well before the day you sing it.",
      },
      {
        kind: "rule",
        title: "The philosophy comes first",
        text: "Check the song against the Selection Philosophy before anything else on the list. It is the same doxology test every song goes through, whether a hymn, a cover or your own.",
      },
      {
        kind: "bullets",
        items: [
          "**Name of song and artist.**",
          "**A short reference recording** (30 seconds to a minute) of the version you want to cover.",
          "**Your own version, with your own flavor:** a recording of you singing the cover with your modifications.",
          "**Accompaniment plans:** what you want backing the song (keyboard, guitar, drums, etc.).",
          "**Harmony coordination:** coordinate harmonies yourself, or tell your Music Lead in advance that you'll need help pulling other singers in.",
          "**Pre-recorded, or performed live the day of:** decide which, and say so.",
          "**A written arrangement** of the song (e.g. v1, chorus ×2, bridge). Chord progression is optional but welcome.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You've picked a cover and know exactly how you want to sing it, but you've only filled out the checklist form, with no recording of your own version. Ready to submit?",
        answer:
          "Not yet. The checklist wants a recording of you singing the cover with your modifications, not a plan. The reference recording shows what you're covering; your own take shows how.",
      },
      {
        kind: "tip",
        text: "Set-building and rehearsal craft are coming to this course. For now, it covers the per-song submission checklist.",
      },
      {
        kind: "link",
        label: "Further reading: Worship Leader Checklist",
        url: "https://www.notion.so/1b67f1c177b68066b2b7fc5142e031b4",
      },
    ],
    quiz: [
      {
        prompt: "What's the first item on the worship-leader submission checklist?",
        options: [
          "A written arrangement",
          "The song's name and artist, checked against the Selection Philosophy",
          "Accompaniment plans",
          "A live performance date",
        ],
        answerIndex: 1,
        explanation:
          "Checking against the Selection Philosophy comes first. Every song, cover or original, goes through the same doxological test before anything else is planned.",
      },
      {
        prompt: "You want harmony singers on your cover. What does the checklist ask you to do?",
        options: [
          "Nothing, harmonies are always arranged automatically",
          "Coordinate them yourself, or tell your Music Lead in advance that you'll need help pulling other singers in",
          "Sing without harmonies",
          "Only the Music Lead can request harmonies",
        ],
        answerIndex: 1,
        explanation:
          "Harmony coordination is on you or your Music Lead, and it happens in advance, not day-of, so the other singers have time to learn their parts.",
      },
      {
        prompt: "Why does the checklist ask for a recording of your OWN version, not only a reference recording of the original?",
        options: [
          "It doesn't, only the original matters",
          "Because you're expected to bring your own flavor to the cover, and the team needs to hear what that sounds like",
          "To prove you can sing",
          "For copyright purposes only",
        ],
        answerIndex: 1,
        explanation:
          "The reference recording shows what you're covering. Your own version shows how: the modifications and flavor you're bringing.",
      },
      {
        prompt: "What does this course's description say is coming next?",
        options: [
          "Nothing, this is the complete course",
          "Set-building and rehearsal craft",
          "A producing certification",
          "A songwriting bootcamp",
        ],
        answerIndex: 1,
        explanation:
          "This course is one lesson for now: the per-song submission checklist. Set-building and rehearsal craft are marked coming soon.",
      },
    ],
  },

  // ── 7 · Producing & Artistry: what a producer does ──────────────────────
  {
    slug: "music-what-a-producer-does",
    title: "What a producer does",
    subtitle: "Bringing order to chaos to deliver finished music",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "You don't need to play an instrument, sing or make beats to be a producer. Producing means bringing order to chaos to reach a result. A producer takes the moving parts of making music (opinions, egos, people, ideas) and turns them into a finished song, ready for release.",
      },
      { kind: "heading", text: "The apple metaphor" },
      {
        kind: "table",
        headers: ["Producer", "What they do"],
        rows: [
          [
            "**The Gardener**",
            "Nurtures apple trees directly: studies the plants, masters the climate, spends years cultivating, harvests their own apples.",
          ],
          [
            "**The Farm Owner**",
            "Doesn't grow apples. Hires the Gardener, recruits workers to wash, package and brand, and arranges transport. Produces apples by coordinating resources.",
          ],
          [
            "**The Shopper**",
            "Doesn't plant or farm at all. Drives to the store, picks a bag of apples, delivers them. Different method, same result: apples delivered.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "All three are \"producing\"",
        text: "Producing means knowing every step to a result, then doing the steps yourself, coordinating others to do them, or using existing solutions to get there faster. It takes vision and leadership more than any one skill.",
      },
      {
        kind: "bullets",
        items: [
          "**Traditional hip-hop producing:** choose a sample, build an instrumental around the loop, write lyrics, adjust the instrumental to fit, book studio time and an engineer, record.",
          "**Inspiration hit:** hum ideas into a voice memo, turn it into an instrumental, write lyrics, record.",
          "**\"$$$\":** find a songwriter, buy a song from them, re-record it with your artist.",
          "**The messy-first method:** buy an instrumental, loop it and record a freestyle, refine the best parts into lyrics. Then **hate it** (this step is important). Wake up the next day and love it, get feedback from trusted friends or the artist, and finish the song. Disliking a draft, then hearing it with fresh ears, is a real, repeatable part of finishing.",
          "**\"DJ Khaled\":** know a lot of artists, gather them in one room, play instrumentals, record the best ideas, add your signature tagline.",
        ],
      },
      {
        kind: "p",
        text: "There's no universal formula. Your steps depend on **time** (deadline), **budget**, **talent** (your skills), **collaborators** (who you can work with and their strengths) and **vision** (who will be the face of the project).",
      },
      {
        kind: "reveal",
        prompt:
          "You don't play an instrument, sing or make beats. You buy a finished instrumental and hand it to a songwriter and an engineer. Are you producing?",
        answer:
          "Yes. Like the Shopper, you grow nothing but still deliver the result. Producing is knowing the steps to a result and doing them, coordinating them or using existing solutions.",
      },
      {
        kind: "link",
        label: "Further reading: Music Producers: Understanding the Role",
        url: "https://www.notion.so/1427f1c177b680b88b43dc0e75dbe6c5",
      },
    ],
    quiz: [
      {
        prompt: "Do you need to play an instrument or make beats to be a music producer?",
        options: [
          "Yes, always",
          "No. Producing means bringing order to chaos to deliver finished music, which you can do by coordinating others or using existing solutions",
          "Only if you're the artist too",
          "Only for hip-hop production",
        ],
        answerIndex: 1,
        explanation:
          "The Farm Owner and the Shopper never touch an instrument; they coordinate or acquire. All three still count as \"producing\" because the result (apples, or a finished song) gets delivered.",
      },
      {
        prompt: "In the apple metaphor, what do the Gardener, the Farm Owner, and the Shopper have in common?",
        options: [
          "They all personally grow the apples",
          "They all deliver apples to someone, by different methods, so all three count as \"producing\" them",
          "Only the Gardener actually produces anything",
          "Nothing, they're unrelated roles",
        ],
        answerIndex: 1,
        explanation:
          "Different methods, same result: apples delivered. In music, hands-on creation, coordination and acquisition are all legitimate production.",
      },
      {
        prompt: "What's the point of the messy-first method's \"hate it\" step?",
        options: [
          "To discourage you from finishing the song",
          "Writing something you initially dislike, then returning to it later with fresh ears, is a real and repeatable part of finishing a song",
          "It means the song should be scrapped",
          "It's a joke, not an actual step",
        ],
        answerIndex: 1,
        explanation:
          "Disliking a rough draft is normal, not a signal to abandon it. Coming back the next day with fresh ears is part of the process.",
      },
      {
        prompt: "What five factors decide which production steps you should actually take?",
        options: [
          "Genre, tempo, key, length, and mood",
          "Time, budget, talent, collaborators, and vision",
          "Studio, label, manager, engineer, and mixer",
          "Popularity, streams, playlists, and algorithm fit",
        ],
        answerIndex: 1,
        explanation:
          "There's no universal formula. The right steps depend on your deadline (time), what you can spend (budget), your skills (talent), who you can work with (collaborators) and who will be the face of the project (vision).",
      },
    ],
  },

  // ── 8 · Producing & Artistry: artist = brand ───────────────────────────
  {
    slug: "music-artist-is-a-brand",
    title: "Artist = brand",
    subtitle: "Your music is the product; your brand is what sells it",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "An artist is a brand as well as a musician. Your music is the product; your brand (image, values, presence) is what sells it. Two artists can sing the same song and, because of their branding, the performances feel entirely different. Your brand should reflect who you authentically are, build trust and loyalty with your audience, and send a clear, consistent message through your music, pictures and videos.",
      },
      {
        kind: "bullets",
        items: [
          "**Be intentional with visuals.** Every photo or video you post adds to your public image, so make sure it fits your brand values.",
          "**Stay consistent.** Keep one aesthetic and tone, from your logo to your social presence.",
          "**Engage your audience.** Respond to comments, show gratitude, share moments of vulnerability or joy.",
        ],
      },
      {
        kind: "rule",
        title: "Public Worship standards",
        text: "Artists associated with Public Worship are held to a higher standard. Your music doesn't need to be worship-focused, but it must align with Christian values. See yourself as a role model, like a teacher or leader in the church.",
      },
      {
        kind: "bullets",
        items: [
          "**Content integrity:** your lyrics, themes and visuals stay consistent with a Christian lifestyle.",
          "**Public behavior:** online and offline, you represent the broader faith community as well as yourself.",
          "**Spiritual accountability:** surround yourself with mentors and peers who hold you to your commitments.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You post a personal, unfiltered photo that doesn't match anything else on your page. Does that count as branding?",
        answer:
          "Yes, just not on purpose. Every photo or video adds to your public image, so be deliberate about visuals. Consistency builds trust.",
      },
      {
        kind: "link",
        label: "Further reading: Artists: Understanding the Role",
        url: "https://www.notion.so/1497f1c177b680119082fa480a7707b8",
      },
    ],
    quiz: [
      {
        prompt: "What sells an artist's music, according to this lesson?",
        options: [
          "The production quality alone",
          "The brand (image, values, presence), not only the song itself",
          "The record label",
          "Streaming algorithm placement",
        ],
        answerIndex: 1,
        explanation:
          "Two artists can sing the same song and it feels entirely different. The brand around the music sells it, not the song in isolation.",
      },
      {
        prompt: "Does a Public Worship-affiliated artist's non-worship music need to be explicitly Christian in content?",
        options: [
          "Yes, every release must be a worship song",
          "No, but it must still align with Christian values, since the artist is held to a higher standard as a representative of the faith community",
          "No standards apply outside worship music",
          "Only if the artist is a paid staff member",
        ],
        answerIndex: 1,
        explanation:
          "The music doesn't have to be worship-focused, but content integrity and public behavior standards still apply. The artist is a role model as well as a musician.",
      },
      {
        prompt: "What is \"spiritual accountability\" in this context?",
        options: [
          "A quarterly review by the label",
          "Surrounding yourself with mentors and peers who provide guidance and hold you to your commitments",
          "Attending church weekly",
          "A financial audit of your music budget",
        ],
        answerIndex: 1,
        explanation:
          "It's relational, not procedural: people in your life who can speak into your choices and hold you to the standard you've claimed.",
      },
      {
        prompt: "Why can two artists singing the same song feel completely different to an audience?",
        options: [
          "Different microphones",
          "Their branding (image, values, consistent presence) shapes how the performance is received",
          "One of them must be more talented",
          "It's impossible; identical songs always feel the same",
        ],
        answerIndex: 1,
        explanation:
          "The song is the product, but the brand is the lens the audience hears it through. Same notes, different meaning, because the artist behind them is a different brand.",
      },
    ],
  },

  // ── 9 · Producing & Artistry: the economics of a song ──────────────────
  {
    slug: "music-the-economics-of-a-song",
    title: "The economics of a song",
    subtitle: "The honest budget behind a release, and why we're selective",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "Producing and releasing a track costs real money, and the artist usually carries that financial responsibility. That is part of why an artist can also act as a producer, a vocalist or even a company.",
      },
      {
        kind: "table",
        headers: ["Line item", "Typical range"],
        rows: [
          ["Production (buying beats or hiring a producer)", "$50–150"],
          ["Recording (studio time or at-home setup costs)", "$50–100"],
          ["Mixing / mastering", "$100–200"],
          ["Distribution (e.g. DistroKid, TuneCore)", "$20–50"],
          ["Marketing (social ads, promotional content)", "$50–150"],
          ["**Total estimate**", "**$300–650+**"],
        ],
      },
      {
        kind: "rule",
        title: "Asking us to release your idea is asking us to bet $500+ on your song",
        text: "When Public Worship is the artist, it typically carries most of the fiscal responsibility for the release. That is why we're selective about which songs we release. It is stewardship, not gatekeeping, and we may not always agree on which songs get that privilege.",
      },
      {
        kind: "p",
        text: "You can always take on that financial responsibility yourself and release the song as your own artist. An artist is a business owner, and a business owner calculates return on investment. At this fork in the road, remember that not everyone who loves music should be the artist fronting a release budget. Other ways to contribute:",
      },
      {
        kind: "bullets",
        items: [
          "**Producing:** shaping the sound and vision of songs.",
          "**Writing:** crafting lyrics and melodies for other artists.",
          "**Vocal performance:** recording backing or lead vocals for others.",
          "**Playing instruments:** contributing your skills to live or recorded projects.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A songwriter asks Public Worship to release their song idea as an official release. The team says no. Is that a verdict on their talent?",
        answer:
          "No. Asking Public Worship to release an idea asks it to bet $500 or more, because it typically carries most of the fiscal responsibility for its own releases. Selectivity is stewardship of that bet, not a verdict on the songwriter.",
      },
      {
        kind: "link",
        label: "Further reading: Artists: Understanding the Role",
        url: "https://www.notion.so/1497f1c177b680119082fa480a7707b8",
      },
    ],
    quiz: [
      {
        prompt: "What's the typical total budget range for producing and releasing one song, per the honest breakdown?",
        options: ["$50–100", "$300–650+", "$1,000–2,000", "There's no meaningful cost"],
        answerIndex: 1,
        explanation:
          "Production, recording, mixing/mastering, distribution and marketing add up to roughly $300–650+. That is real money, so releases aren't approved casually.",
      },
      {
        prompt: "Why is Public Worship selective about which songs it releases as an organization?",
        options: [
          "Personal taste of whoever is in charge that week",
          "Releasing a song means betting real money ($500+) on it; selectivity is stewardship of that money, not gatekeeping someone's talent",
          "There's a strict quota of releases per year",
          "Only staff-written songs are eligible",
        ],
        answerIndex: 1,
        explanation:
          "Public Worship typically carries the fiscal responsibility for its own releases, so asking it to release an idea asks it to bet real money. Selectivity stewards that bet; it doesn't judge the person.",
      },
      {
        prompt: "If you're not ready to front the budget for your own release, what's an alternative path into music, per this lesson?",
        options: [
          "There is none, you must be the artist or nothing",
          "Producing, writing, vocal performance, or playing instruments for other artists",
          "Only working for a label",
          "Waiting until you can self-fund a full album",
        ],
        answerIndex: 1,
        explanation:
          "The \"fork in the road\" names four other ways to contribute (producing, writing, vocal performance, playing instruments) without being the artist who fronts the release budget.",
      },
      {
        prompt: "As an artist financially responsible for your own release, what does the lesson say you should calculate?",
        options: [
          "Nothing, art shouldn't be measured financially",
          "Return on investment, the same way any business owner would",
          "Only your streaming numbers",
          "Your total studio hours",
        ],
        answerIndex: 1,
        explanation:
          "An artist who funds their own release is a business owner, and a business owner calculates return on investment.",
      },
    ],
  },

  // ── 10 · Producing & Artistry: inviting a collaborator ─────────────────
  {
    slug: "music-inviting-a-collaborator",
    title: "Inviting a collaborator",
    subtitle: "Publish the terms, then ask",
    minutes: 3,
    blocks: [
      {
        kind: "p",
        text: "When we reach out to a vocalist, producer, engineer or player, the terms are already published. **publicworship.life/collaborate** walks anyone through their situation and role; **/music-policy** is the canonical document behind it. Point at what's published; don't negotiate a private version.",
      },
      {
        kind: "bullets",
        items: [
          "**Send the link first,** so they (and their manager or lawyer) read the whole picture before answering.",
          "**Name the ask precisely:** one song, which part (a lead, a verse, a bridge, a vocal moment), and the exact credit on the release.",
          "**Say what cash is funded before they choose a path:** the release's cash budget for their role, and whether the rate sheet is fully, partly or not funded. Never after.",
          "**Say the master out loud, early.** Public Worship owns the official master; if that's a dealbreaker, talk before anything is recorded.",
          "**Approval rights are real.** They sign off on their performance, credit, and use of their name and likeness.",
          "**Non-exclusive, always.** This song leaves their catalog, label, deals and career untouched.",
          "**No path is holier.** Never hint, in words or tone, that taking donation or equity earns the next invitation.",
          "**Paper before recording.** The split sheet and release agreement are signed before the song goes out. No release ships with unresolved splits.",
        ],
      },
      {
        kind: "rule",
        title: "\"No\" has to cost nothing",
        text: "Declining is one of the four honored paths, not a failed negotiation. Say so when you invite: hearing the song and saying it isn't for them costs nothing, and the door stays open.",
      },
      {
        kind: "rule",
        title: "Sponsors fund a release; they don't own a piece of it",
        text: "A supporter or church can fund a release's production or promotion budget as a tax-deductible release-budget sponsorship. They get recognition (credits, mentions, \"made possible by\"), never master points, master ownership or any equity-like interest. Public Worship does not sell master participation for cash.",
      },
      {
        kind: "reveal",
        prompt:
          "An artist's manager replies to your DM with \"what's your standard deal?\" What do you send?",
        answer:
          "The /collaborate walkthrough and its rate sheet. That IS the standard deal, published so nobody gets a different one. Add what only you know: the part you're asking for and the cash funded for that role.",
      },
      {
        kind: "link",
        label: "The walkthrough you send: publicworship.life/collaborate",
        url: "https://publicworship.life/collaborate",
      },
      {
        kind: "link",
        label: "Further reading: Music Release & Royalty Policy",
        url: "https://publicworship.life/music-policy",
      },
    ],
    quiz: [
      {
        prompt: "Where do the terms of a collaboration come from?",
        options: [
          "Whatever you and the collaborator agree to in the DM",
          "The published pages (/collaborate and /music-policy), which you point at instead of negotiating around",
          "The Music Director decides per person",
          "Each artist's manager sets them",
        ],
        answerIndex: 1,
        explanation:
          "Rates, paths and ownership are published so nobody gets a private version of the deal. The invite adds only what's specific to this song: the ask, and what cash is funded for that role.",
      },
      {
        prompt: "When does a contributor learn what cash is actually funded for their role?",
        options: [
          "After the session, once the budget is final",
          "Before they choose a path, in writing, never after",
          "Only if they ask",
          "At the release date",
        ],
        answerIndex: 1,
        explanation:
          "The four paths exist for an informed choice. This rule prevents someone choosing equity because nobody told them cash was available, or expecting cash that was never funded.",
      },
      {
        prompt: "A church wants to fund a release's production budget. What do they receive?",
        options: [
          "Master points proportional to their gift",
          "Recognition (credits, mentions, \"made possible by\"), never master points or ownership",
          "A share of the writer split",
          "Approval rights over the final mix",
        ],
        answerIndex: 1,
        explanation:
          "Release-budget sponsorship is a tax-deductible gift to Global Echo Charitable Co., not an investment. Public Worship does not sell master participation for cash; the financial relationship ends at the gift.",
      },
      {
        prompt: "Why say \"Public Worship owns the official master\" early in an invite?",
        options: [
          "To pressure the artist into deciding quickly",
          "Because if it's a dealbreaker for them, that conversation belongs before anything is recorded",
          "It isn't said; it's in the paperwork",
          "Because artists rarely care about masters",
        ],
        answerIndex: 1,
        explanation:
          "Master ownership is the part of the policy most like a label deal, so say it early and honestly. Finding out after a session sours a good relationship.",
      },
    ],
  },

  // ── 11 · Collaborating: greenlight, demos, reversion ───────────────────
  {
    slug: "music-greenlight-and-the-demo",
    title: "Greenlight, demos, and getting a song back",
    subtitle: "Nothing attaches until a song is greenlit, in writing",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Sessions, retreats and writing camps produce far more songs than we will ever release, and that's normal. A song becomes an **Official Public Worship Release** only when Public Worship explicitly *greenlights* it for a specific project, cycle or release plan.",
      },
      {
        kind: "rule",
        title: "Greenlight is a written designation",
        text: "Enthusiasm in the room, a song landing well in a session, or someone senior saying they love it never implies greenlight. Until it's written down for a specific project, the song is still in development.",
      },
      {
        kind: "p",
        text: "**The compensation framework starts at greenlight.** The rate sheet's cash fees, master income participation and donation paths apply to greenlit songs. Before greenlight, writers keep their writer share, Public Worship has no publishing claim, and none of the four paths are live.",
      },
      {
        kind: "table",
        headers: ["Status", "Demo recording", "Composition", "Compensation"],
        rows: [
          [
            "Greenlit as Official Release",
            "Owned by PW",
            "PW Publishing structure applies",
            "Yes",
          ],
          [
            "Held for future consideration",
            "Owned by PW",
            "Writers retain writer share; no PW publishing claim until greenlit",
            "No",
          ],
          [
            "Released back to writers on request",
            "Owned by PW; not commercially released without writer consent",
            "100% to writers, free of PW involvement",
            "No",
          ],
        ],
      },
      {
        kind: "p",
        text: "Any recording made with Public Worship resources (studio time, equipment, engineering, session leadership) is owned by Public Worship, greenlit or not. The *composition* is separate. Any writer on an ungreenlit song may request its formal release back to them, free of any Public Worship publishing or administrative claim. Most requests are granted. Public Worship may decline if the song is actively being considered for a future project or cycle, and then says what for and when it will revisit. Once released, the writer may re-record and release the song as their own: no publishing share, no master claim, no encumbrance. Public Worship keeps the demo and won't commercially release it without the writers' written agreement.",
      },
      {
        kind: "rule",
        title: "Selection is stewardship, not judgment",
        text: "Each release spends nonprofit money on one song: studio, mixing, mastering, distribution, marketing, time. Not choosing a song is a stewardship call about the project, the cycle and the catalog, not a verdict on the people who made it.",
      },
      {
        kind: "reveal",
        prompt:
          "A song from your session got a standing ovation in the room and a director said \"we have to release this.\" Is it greenlit?",
        answer:
          "No. Greenlight is a written designation for a specific project, cycle or release plan. Until it's written, none of the four paths or rate-sheet numbers apply. Ask for the written designation before you plan around it.",
      },
      {
        kind: "link",
        label: "The walkthrough: publicworship.life/collaborate",
        url: "https://publicworship.life/collaborate",
      },
      {
        kind: "link",
        label: "Further reading: policy §4, demos, greenlit releases and unreleased songs",
        url: "https://publicworship.life/music-policy#demos",
      },
    ],
    quiz: [
      {
        prompt: "What makes a song an Official Public Worship Release?",
        options: [
          "Being written in a Public Worship session",
          "An explicit, written greenlight for a specific project, cycle, or release plan",
          "The room loving it",
          "Public Worship paying for the studio time",
        ],
        answerIndex: 1,
        explanation:
          "Greenlight is a written designation. A song written in our space, recorded on our gear, and loved by everyone present is still not an official release until it's greenlit in writing.",
      },
      {
        prompt: "When does the compensation framework (cash, participation, donation) attach to a song?",
        options: [
          "The moment it's written in a Public Worship session",
          "At greenlight, and not before",
          "When it's first performed live",
          "When it hits a streaming threshold",
        ],
        answerIndex: 1,
        explanation:
          "The four paths and the rate sheet apply to greenlit songs. Before greenlight, writers keep their writer share and Public Worship has no publishing claim, but no compensation framework is attached either.",
      },
      {
        prompt: "You wrote a song in a PW session that hasn't been greenlit, and you want to release it yourself. What can you ask for?",
        options: [
          "Nothing, songs written in session belong to PW permanently",
          "A formal release of the composition back to you. It's usually granted; PW may decline only if it's actively being considered, and will say what for and when it'll revisit",
          "The demo recording, which becomes yours automatically",
          "A refund of the studio costs",
        ],
        answerIndex: 1,
        explanation:
          "The composition can come back to the writers on request, free of any PW publishing or admin claim. The demo recording, made with PW's studio, gear and engineering, stays owned by PW, and PW won't release it commercially without the writers' written agreement.",
      },
      {
        prompt: "A song of yours isn't greenlit this cycle. What does that mean?",
        options: [
          "The team judged your songwriting and found it lacking",
          "It's a stewardship call about the project, the cycle and the catalog; releasing costs real money, and not every song fits",
          "The song can never be considered again",
          "You should stop writing for Public Worship",
        ],
        answerIndex: 1,
        explanation:
          "Selection is stewardship, not judgment. Each release spends real nonprofit money on one song, so not everything gets chosen, and that choice isn't a comment on the people involved.",
      },
    ],
  },

  // ── 12 · Collaborating: the three lanes ────────────────────────────────
  {
    slug: "music-three-lanes",
    title: "Three lanes: song, publishing, master",
    subtitle: "Writer share, publisher share, and who owns the recording",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "We keep music rights in three separate lanes. Most \"what do I get?\" confusion is about which lane a contribution lands in.",
      },
      {
        kind: "table",
        headers: ["Lane", "What it covers", "Who holds it"],
        rows: [
          [
            "**Composition** (writer share)",
            "The song itself: lyrics, melody, chord structure, core composition",
            "100% to the writers, per the agreed split sheet. **Public Worship takes 0%.**",
          ],
          [
            "**Publishing** (publisher share)",
            "The administrative side: registering the song with CCLI and the PROs, administering it, stewarding it over time",
            "50% Public Worship Publishing, 50% split among the writers according to their writer splits",
          ],
          [
            "**Master recording**",
            "The recording people stream (one song can have several masters: studio, live, acoustic)",
            "Owned by Public Worship, held by Global Echo Charitable Co.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Producing, playing and engineering aren't writer share",
        text: "You're on the writer split if you contributed lyrics, melody or composition. Producing, mixing, engineering and performing are paid through the four paths at that role's published rate, not with writer credit. Public Worship honors writing by leaving that lane whole.",
      },
      {
        kind: "bullets",
        items: [
          "**Catalog continuity.** Public Worship owns the master because worship songs need to stay available for decades, and team members move, sign elsewhere and change paths. A catalog scattered across former volunteers' accounts is unworkable.",
          "**Clean rights.** Distribution, sync and licensing need unambiguous ownership; a master split across many parties makes them slow or impossible.",
          "**Mission protection.** We can decline uses that contradict the ministry's purpose.",
          "**Reinvestment.** Master income funds the next session, and the nonprofit form makes that enforceable because there are no shareholders.",
        ],
      },
      {
        kind: "p",
        text: "Ownership comes with published stewardship promises. If Global Echo dissolves, the catalog goes to an aligned 501(c)(3) or reverts pro-rata to participation holders. If a release is pulled from distribution and not restored within **18 months**, its master reverts to the named primary artist. No master goes to a for-profit entity without written consent from the named primary artist (or, absent one, holders of a majority of that release's participation points). The policy never waives a writer's statutory right to terminate transfers of the *composition* under 17 U.S.C. §§ 203 and 304(c).",
      },
      {
        kind: "rule",
        title: "Owning the master isn't the same as keeping all the income",
        text: "Master ownership is control of the recording (distribution, licensing, takedowns, sync approval). Participation is a contractual right to a percentage of net master income, without ownership. One point equals 1% of net master income for that release, so \"5 points\" means 5%.",
      },
      {
        kind: "reveal",
        prompt:
          "You mixed the record and wrote none of it. A friend says you belong on the split sheet. Are they right?",
        answer:
          "No. Mixing earns the mix-engineer rate through the four paths, plus credit. The writer share covers only lyrics, melody and composition.",
      },
      {
        kind: "link",
        label: "The walkthrough: publicworship.life/collaborate",
        url: "https://publicworship.life/collaborate",
      },
      {
        kind: "link",
        label: "Further reading: policy §§5–10, rights, writer share, publishing and master",
        url: "https://publicworship.life/music-policy#rights",
      },
    ],
    quiz: [
      {
        prompt: "How much of the writer share does Public Worship take on an official release?",
        options: ["50%", "0%", "25%", "It depends on the song"],
        answerIndex: 1,
        explanation:
          "Writers keep 100% of the writer share, per the split sheet. Public Worship's role as commissioner and steward shows up in the publisher share and master ownership, not in writer credit.",
      },
      {
        prompt: "How does the publisher share split on an Official Public Worship Release?",
        options: [
          "100% Public Worship Publishing",
          "50% Public Worship Publishing, 50% split among the writers per their writer splits",
          "100% to the writers",
          "Evenly among everyone who was in the room",
        ],
        answerIndex: 1,
        explanation:
          "PW Publishing keeps 50% of the publisher share for originating, funding, registering and stewarding the release. The other 50% goes to the writers in proportion to their writer splits.",
      },
      {
        prompt: "What's the difference between master ownership and master income participation?",
        options: [
          "Nothing, they're two names for the same thing",
          "Ownership is control of the recording; participation is a contractual right to a percentage of net master income, without ownership",
          "Participation includes the right to license the song",
          "Ownership applies to the composition, participation to the recording",
        ],
        answerIndex: 1,
        explanation:
          "Public Worship owns and controls the official master (distribution, licensing, takedowns, sync approval) and grants participation in its income. One point equals 1% of net master income for that release.",
      },
      {
        prompt: "What happens if Public Worship pulls a release from distribution and doesn't restore it within 18 months?",
        options: [
          "Nothing, ownership is permanent",
          "Master ownership of that release reverts to the named primary artist (or pro-rata to participation holders)",
          "The song enters the public domain",
          "The writers lose their writer share",
        ],
        answerIndex: 1,
        explanation:
          "The out-of-print reversion is one of the published stewardship promises attached to master ownership, alongside the dissolution reversion and the change-of-control consent requirement. Temporary pauses for remasters or distributor changes don't trigger it.",
      },
    ],
  },

  // ── 13 · Collaborating: the four paths ─────────────────────────────────
  {
    slug: "music-the-four-paths",
    title: "The four paths",
    subtitle: "Cash, participation, donation, decline: equally honored",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Every contributor role on a greenlit release has two published numbers: the **cash fee** at market rate, and the **master income participation** you may take instead. Neither is negotiated per release. Before recording, each contributor picks one of four paths, recorded in writing in the release agreement.",
      },
      {
        kind: "table",
        headers: ["Path", "What it is", "Available"],
        rows: [
          [
            "**Cash fee**",
            "The published rate as a one-time payment",
            "*When funded*, depending on this release's budget",
          ],
          [
            "**Master income participation**",
            "The published points instead of cash, paid from net master income over time",
            "Always",
          ],
          [
            "**Donation to mission**",
            "Your work as an in-kind gift through Global Echo Charitable Co., with credit and gratitude. Under IRS rules donated *services* aren't deductible; only out-of-pocket expenses and tangible property are",
            "Always",
          ],
          [
            "**Decline**",
            "None of the above works for you on this release. A real answer",
            "Always",
          ],
        ],
      },
      {
        kind: "rule",
        title: "All four paths are equally valued, and we say so out loud",
        text: "Cash doesn't mean less invested. Participation isn't greedy; it accepts the risk that the song may not perform. Donation isn't \"the pure option.\" We don't track who chose what, and never imply that donating or taking equity makes someone more spiritual or more deserving of the next invitation.",
      },
      {
        kind: "p",
        text: "**Cash is the conditional path.** Public Worship is new and has no recurring music revenue. Participation and donation need no cash, so every release offers them; a cash fee depends on the release's budget. **Before** anyone signs on, we put in writing the total cash budget, each role's allocation, and whether the going rate is fully, partly or not funded.",
      },
      {
        kind: "table",
        headers: ["Role", "Cash fee", "Master points"],
        rows: [
          ["Lead producer (full song)", "$500", "5%"],
          ["Co-producer", "$250", "2%"],
          ["Recording engineer (tracking)", "$200", "1.5%"],
          ["Mix engineer", "$400", "3%"],
          ["Mastering engineer", "$125", "0.75%"],
          ["Vocal producer", "$250", "2%"],
          ["Arranger", "$200", "1.5%"],
          ["Featured vocalist", "$300", "3%"],
          ["Background vocalist", "$125", "0.75%"],
          ["Session instrumentalist", "$125", "0.75%"],
          ["Marketing / rollout lead", "$500", "3%"],
        ],
      },
      {
        kind: "tip",
        text: "Rates are **per song, not per session**: a producer on three songs is paid for three songs. They match independent-artist market rates, with no \"ministry discount.\" Effective 2026, next review end of 2027; publicworship.life/collaborate is canonical.",
      },
      {
        kind: "p",
        text: "**The featured-artist ladder.** The Featured vocalist row prices a performance, not a **name**. An invited artist brings an audience, so the feature scales. The ladder pays **$300 in cash, or 1 master point, for every 100k monthly listeners**, with cash capping at $1,500 and points at 5. The bottom rung is the $300 featured-vocal rate. Cash stays conditional: a rung prices the role, not what a release can fund.",
      },
      {
        kind: "table",
        headers: ["Monthly audience", "Cash fee, per song", "or master points"],
        rows: [
          ["Under 100k", "$300", "3"],
          ["100k – 199k", "$600", "3"],
          ["200k – 299k", "$900", "3"],
          ["300k – 399k", "$1,200", "4"],
          ["400k+", "$1,500 (cap)", "5"],
        ],
      },
      {
        kind: "table",
        headers: ["Ladder rule", "Why"],
        rows: [
          [
            "**Points cap at 5**",
            "Elsewhere a point costs about $100 ($500 lead producer: 5 points). At that ratio a capped feature would be 15 points, the Primary Artist baseline. A NAME is paid in cash; equity stays with the people building the catalog.",
          ],
          [
            "**Points floor at 3**",
            "The flat featured-vocalist rate, so being invited never costs you participation.",
          ],
          [
            "**Cash and points are alternatives, but divisible**",
            "You can't hand them both in full. Take any percentage of the cash fee and the remaining percentage of the points. At the cap: $1,500, or 5 points, or $750 plus 2.5 points. More points means less cash.",
          ],
          [
            "**Proportional, not an exchange rate**",
            "A dollars-per-point rate would let someone convert a capped cash fee back into points at a ratio the ladder deliberately doesn't offer.",
          ],
          [
            "**Audience is fixed at signing**",
            "Monthly listeners from public streaming data, measured when the agreement is signed. Nothing reopens mid-release in either direction.",
          ],
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You're courting an artist with 180k monthly listeners for a feature. What's the published cash fee, and can you also offer them 3 points to close the deal?",
        answer:
          "$600, the 100k–199k rung. Points would be 3 (the floor beats one per 100k). You can't offer both in full, but you CAN split proportionally, say $300 plus 1.5 points. Credit, writer share and approval rights come regardless. If the cash isn't funded, say so in writing before they choose.",
      },
      {
        kind: "scenario",
        prompt:
          "A background vocalist tells you she needs the cash fee, and this release's budget can't fund her role. What's the honest move?",
        options: [
          {
            text: "Tell her in writing what IS funded before she picks, then offer the other paths: 0.75% participation, a partial cash and equity mix if the budget allows any, or declining at no cost to her standing",
            correct: true,
            feedback:
              "Right. If none of those work for enough of the team, the release is reshaped, postponed or set aside. She never finds out after she's sung.",
          },
          {
            text: "Record her now and sort out payment once the budget is final",
            feedback:
              "No. Funding is disclosed in writing before anyone chooses a path, never after she's sung.",
          },
          {
            text: "Suggest donation as the most committed option",
            feedback:
              "No. All four paths are equally valued. Never imply that donating earns standing or the next invitation.",
          },
        ],
      },
      {
        kind: "link",
        label: "The rate sheet and walkthrough: publicworship.life/collaborate",
        url: "https://publicworship.life/collaborate",
      },
      {
        kind: "link",
        label: "Further reading: policy §§11–13, the four paths, rate sheet and cash availability",
        url: "https://publicworship.life/music-policy#four-paths",
      },
    ],
    quiz: [
      {
        prompt: "Which of the four paths is conditional on a specific release's budget?",
        options: [
          "Master income participation",
          "The cash fee",
          "Donation",
          "All four are conditional",
        ],
        answerIndex: 1,
        explanation:
          "Participation, donation and declining need no cash on hand, so they're available on every release. Only the cash fee depends on what that release's budget funds.",
      },
      {
        prompt: "When does a contributor find out whether their cash fee is funded?",
        options: [
          "After the recording session",
          "Before they choose a path, in writing, including the release's cash budget and what's allocated to their role",
          "When the release goes live",
          "Only if the answer is yes",
        ],
        answerIndex: 1,
        explanation:
          "The total cash budget, each role's allocation, and whether the going rate is fully, partly or not funded are all shared before anyone signs on.",
      },
      {
        prompt: "Is choosing the donation path more spiritual than taking the cash fee?",
        options: [
          "Yes, donating is the most committed option",
          "No. All four paths are equally valued, and we never imply that donating or taking equity earns better standing or future invitations",
          "Yes, but only for volunteers",
          "It depends on the release",
        ],
        answerIndex: 1,
        explanation:
          "We don't track who chose which path as a measure of commitment. Cash is what we offer when we have it; equity is what we can always offer; donation is a gift, never an expectation.",
      },
      {
        prompt: "A lead producer takes participation instead of cash. What does the rate sheet give them?",
        options: ["$500", "5 points, or 5% of net master income", "15 points", "2%"],
        answerIndex: 1,
        explanation:
          "Lead producer (full song) is $500 cash or 5% master income participation, per song. Every role on the sheet publishes both numbers, so the choice is between two known quantities.",
      },
      {
        prompt: "A producer works on three songs for one release cycle. How are they paid?",
        options: [
          "One fee for the session",
          "Per song: three songs means three fees (or three point allocations)",
          "A flat monthly rate",
          "Only for the song that performs best",
        ],
        answerIndex: 1,
        explanation:
          "Rates are per song, not per session. The rate sheet's numbers are all per-song unless noted otherwise.",
      },
    ],
  },

  // ── 14 · Collaborating: what your role receives ────────────────────────
  {
    slug: "music-what-your-role-receives",
    title: "What your role receives",
    subtitle: "Primary artist, featured artist, contributor, and the 50-point cap",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The /collaborate walkthrough sorts people by what they did. It rests on three role families.",
      },
      {
        kind: "table",
        headers: ["Role", "What it means", "What it carries"],
        rows: [
          [
            "**Primary Artist**",
            "The named artist we're building with over time: sound, writing, worship identity, catalog",
            "A **15-point baseline** (15% of net master income) per release, automatic under the Primary Artist Agreement; full writer share on anything written; the writer side of the publisher pool; cash or honorarium where the budget allows; ongoing collaboration",
          ],
          [
            "**Featured Artist**",
            "Prominently featured on one release (*Public Worship feat. [you]*) with no long-term commitment",
            "Featured credit on the release and every DSP; writer share on anything written; a four-paths choice on the featured-artist ladder ($300 cash or 1 point per 100k monthly listeners, capped at $1,500 and 5 points, never below 3)",
          ],
          [
            "**Contributor**",
            "Producers, musicians, engineers, arrangers, vocalists, creative directors",
            "Credit on the release; one of the four paths at the published rate for that role; writer share only if they also contributed lyrics, melody or composition",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Roles compound; credit isn't a path",
        text: "A primary artist who also produces gets the 15-point baseline PLUS the producer's path. Each role is paid at its own rate, so someone who wrote, produced and played is paid three times over. Credit is never one of the four paths: it is owed for what you did, whichever path you take.",
      },
      {
        kind: "p",
        text: "**Why the baseline is 15, not 50.** We expect most releases to have **more than one** primary artist co-leading a song. A 50-point baseline for one artist would make songs zero-sum, hoarded as solo property. We want a catalog where collaboration is the norm and several artists share in a song's income.",
      },
      {
        kind: "rule",
        title: "Contributor points are capped at 50",
        text: "Public Worship may allocate up to 50 points of net master income across all artists and contributors on a release, keeping at least 50 for mission reinvestment. Overages are resolved BEFORE signing, never after, in this order. (1) Show everyone the math at once, never privately with one person. (2) Re-offer the four paths. (3) Reduce non-baseline points pro-rata, preserving the 15-point primary baseline. (4) If it still doesn't fit, reshape the team, postpone or set the song aside.",
      },
      {
        kind: "p",
        text: "**If you leave,** your participation on existing releases continues. The catalog stays with Public Worship; future releases are negotiated fresh. The relationship is non-exclusive: your own music, deals, catalog and career stay yours. **Nothing releases without the paperwork.** Depending on the song, that means a split sheet, a master release agreement and role agreements (producer, featured, primary artist, contributor). It also means a publishing or admin agreement, a master participation agreement, and the per-release budget and recoupment list.",
      },
      {
        kind: "reveal",
        prompt:
          "You're the named primary artist on a release and you also produced it. Do you get the 15-point baseline, or the lead producer's 5 points?",
        answer:
          "Both. The baseline comes with the Primary Artist Agreement; producing is a separate role paid under the four paths ($500 cash, 5 points, donation or decline). Everything must still fit the 50-point cap, reconciled before signing.",
      },
      {
        kind: "link",
        label: "Find your own situation: publicworship.life/collaborate",
        url: "https://publicworship.life/collaborate",
      },
      {
        kind: "link",
        label: "Further reading: policy §10 (participation), §16 (roles), §23 (agreements)",
        url: "https://publicworship.life/music-policy#participation",
      },
    ],
    quiz: [
      {
        prompt: "What does a named Primary Artist receive automatically on a release?",
        options: [
          "50% of net master income",
          "A 15-point baseline (15% of net master income) under the Primary Artist Agreement",
          "Ownership of the master",
          "Nothing automatic; everything is negotiated per song",
        ],
        answerIndex: 1,
        explanation:
          "The 15-point baseline is granted automatically for carrying the named-artist identity, performance, and ongoing relationship. Any other role on the same release is compensated separately on top of it.",
      },
      {
        prompt: "Why is the Primary Artist baseline 15 points rather than 50?",
        options: [
          "Because the ministry can't afford more",
          "Because most releases are expected to have more than one primary artist co-leading, and a 50-point baseline would make artists treat songs as solo property",
          "Because primary artists also get cash",
          "It's an industry-standard number",
        ],
        answerIndex: 1,
        explanation:
          "It's a deliberate anti-hoarding choice. The catalog is meant to be collaborative, with several artists sharing in a song's income instead of one artist holding a song alone.",
      },
      {
        prompt: "Contributor allocations on a release would total 58 points. What happens?",
        options: [
          "The extra 8 points come out of the writers' share",
          "It's reconciled before signing: surface the math to everyone, re-offer the four paths, reduce non-baseline points pro-rata (preserving the 15-point baseline), and reshape or pause if it still doesn't fit",
          "Whoever signed first keeps their points",
          "Public Worship absorbs the overage silently",
        ],
        answerIndex: 1,
        explanation:
          "The 50-point cap is reconciled BEFORE the agreement is signed, never after, and never privately with one person. The order of operations is published so nobody gets quietly reduced.",
      },
      {
        prompt: "Public Worship invites an artist with 660k monthly listeners to feature. What can they take?",
        options: [
          "$300 or 3 points, since the featured-vocalist rate covers every feature",
          "$1,500 or 5 points (both at their cap), or any proportional split of the two",
          "$1,980 and 6.6 points, straight from the formula",
          "$1,500 plus 5 points, since the ladder pays both",
        ],
        answerIndex: 1,
        explanation:
          "660k is past both caps: cash stops at $1,500 (400k) and points at 5. They're alternatives, not a package, but divisible, so $750 plus 2.5 points is equally available. Points cap far below the sheet's usual cash-to-points ratio so a one-song feature never reaches the 15-point Primary Artist baseline.",
      },
      {
        prompt: "A contributor chooses the donation path. Do they still get credited?",
        options: [
          "No, credit goes with the cash or equity paths",
          "Yes. Credit isn't one of the four paths; you're credited for what you did regardless of which path you take",
          "Only if they ask for it in writing",
          "Only on the streaming platforms, not the release",
        ],
        answerIndex: 1,
        explanation:
          "Credit is owed, not traded. The four paths cover compensation for the role; being named for the work you did isn't part of that trade.",
      },
    ],
  },
];

/** The Music stream's theme entry. */
export const MUSIC_THEME: Theme = {
  key: "music",
  title: "Music",
  subtitle: "What we sing, and why it matters.",
};

/**
 * The Music stream's courses, in catalog order: the doxological songwriting
 * and song-selection framework (everyone on a music team), the worship
 * leader's submission checklist (a role course, deliberately one lesson for
 * now), the producer/artist roles, and how a release is split and paid for
 * (the published /collaborate walkthrough, taught to everyone who might end
 * up on a release — writers, players, vocalists, engineers, artists).
 */
export const MUSIC_COURSES: Course[] = [
  {
    slug: "doxology-what-we-sing",
    themeKey: "music",
    title: "Doxology: What We Sing",
    level: "intermediate",
    audience: "team",
    description:
      "The framework behind our songwriting and song selection: why worship " +
      "is a sacrifice, the test that judges a lyric by function instead of " +
      "pronoun, the four doxological shapes and the five anthropological " +
      "drifts they can slide into, and what it takes to run a writing room " +
      "by the same standard.",
    icon: "music",
    moduleSlugs: [
      "music-worship-is-a-sacrifice",
      "music-the-test",
      "music-four-shapes-of-praise",
      "music-the-five-drifts",
      "music-running-the-room",
    ],
  },
  {
    slug: "leading-worship",
    themeKey: "music",
    title: "Leading Worship",
    level: "intermediate",
    audience: "role",
    description:
      "What to submit before you lead a song: the song checked against the " +
      "Selection Philosophy, a reference recording, your own flavor, " +
      "accompaniment, harmonies, and a written arrangement. Set-building " +
      "and rehearsal craft are coming to this course.",
    icon: "mic",
    moduleSlugs: ["music-submitting-a-song"],
  },
  {
    slug: "producing-and-artistry",
    themeKey: "music",
    title: "Producing & Artistry",
    level: "intermediate",
    audience: "role",
    description:
      "What producing actually means (it's broader than beat-making), what " +
      "it takes to build an artist brand (including the standard Public " +
      "Worship-affiliated artists are held to), the honest economics of " +
      "releasing a song, and how to run an invite so a collaborator sees the " +
      "published terms before they answer.",
    icon: "headphones",
    moduleSlugs: [
      "music-what-a-producer-does",
      "music-artist-is-a-brand",
      "music-the-economics-of-a-song",
      "music-inviting-a-collaborator",
    ],
  },
  {
    slug: "collaborating-on-a-release",
    themeKey: "music",
    title: "Collaborating on a Release",
    level: "intermediate",
    audience: "team",
    description:
      "What publicworship.life/collaborate tells the people we make music " +
      "with, so the room knows it too: greenlight and the demo, the three " +
      "rights lanes (writer share, publishing, master), the four " +
      "equally-honored paths and the published rate sheet, and what each " +
      "role receives, including the 15-point Primary Artist baseline and " +
      "the 50-point cap.",
    icon: "percent",
    moduleSlugs: [
      "music-greenlight-and-the-demo",
      "music-three-lanes",
      "music-the-four-paths",
      "music-what-your-role-receives",
    ],
  },
];
