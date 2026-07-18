/**
 * The Music stream — the doxological-worship songwriting/song-selection
 * framework, the worship-leader submission checklist, and the producer/artist
 * roles. Also the Music theme + its three courses.
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
    subtitle: "Doxa + logos — the content is God, not us",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Doxology comes from two Greek words: **doxa** (δόξα) — glory, weight, the visible splendor of who God is — and **logos** (λόγος) — word or declaration. A doxology is, at its simplest, a declaration of God's glory.",
      },
      {
        kind: "p",
        text: '"Glory be to the Father, and to the Son, and to the Holy Spirit" is a doxology. "Praise God from whom all blessings flow" is a doxology. When Paul, mid-argument in Romans, breaks into "For from him and through him and to him are all things. To him be the glory forever. Amen" (Rom 11:36) — that is a doxology. When the angels cry "Holy, holy, holy" (Isa 6:3; Rev 4:8) — that is a doxology.',
      },
      {
        kind: "rule",
        title: "The content is God, not us",
        text: "A doxology does not report what God did for me. It does not describe how I feel about God. It declares who God is — His character, His acts, His worth — and stops there. The worshiper may be present, but only as the voice carrying the declaration, never as its subject.",
      },
      { kind: "heading", text: "Worship is a sacrifice" },
      {
        kind: "p",
        text: "Worship, in the Hebrew of the Old Testament, is **shâchâh** — to bow down. In John 4, Jesus says the Father seeks worshipers who worship in spirit and in truth. In Hebrews 13:15 the writer calls it a **sacrifice of praise** — the fruit of lips that openly profess his name. Three anchors: worship is a bow, it is offered in truth, and it is a sacrifice. Something is given. Something leaves the worshiper's hand and is laid at God's feet.",
      },
      {
        kind: "rule",
        title: "A song whose lyrics never leave the worshiper has not yet brought a sacrifice",
        text: "Romans 12:1 calls worship a sacrifice. A sacrifice is, by definition, something carried out of the worshiper's possession and laid down in front of God. If the song never makes it past their own story, no sacrifice has been offered — there has been feeling, sometimes the deepest feeling of the week, but nothing has been given.",
      },
      {
        kind: "p",
        text: "Not every worship song must be doxological. Scripture sings in many registers, and lament, testimony, confession, and petition are all faithful forms of worship in their proper place. Sung once, in their proper moment, they are holy. Sung as a steady diet, they can quietly train a congregation to spend its whole worship set thinking about itself — its situation, its journey, its longings, its sins — and to walk out having brought nothing to God at all.",
      },
      {
        kind: "p",
        text: "Doxology is the form of worship in which it is hardest to inject the self in a way that becomes unintentional self-idolatry. When a song's entire content is who God is, there is no grammatical room left for the singer to drift to the center. Other forms can be worship — but they require a vigilance the doxological form does not, because in them the path back to the self is always one careless line away.",
      },
      {
        kind: "reveal",
        prompt:
          "A congregation sings a beautiful song about how safe and loved they feel this morning. Has a sacrifice been brought?",
        answer:
          "Not by this song alone. If the lyrics never leave the worshiper's own feelings, nothing has been carried out and laid at God's feet — that's real feeling, not yet a sacrifice. It doesn't make the moment fake; it means the sacrifice of praise Hebrews 13:15 describes is still waiting to be brought, by this song or another in the set.",
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
          "Doxa is glory — the weight and visible splendor of who God is. Logos is word or declaration. A doxology is a declaration of God's glory, nothing more and nothing less.",
      },
      {
        prompt: "What is the common thread across every doxology, from the Gloria Patri to Romans 11:36?",
        options: [
          "They all use the word \"holy\"",
          "The content is God, not us — they declare who He is and stop there",
          "They're all sung, never spoken",
          "They all come from the book of Psalms",
        ],
        answerIndex: 1,
        explanation:
          "A doxology doesn't report what God did for me or how I feel about Him — it declares who He is and stops. The worshiper may carry the declaration, but is never its subject.",
      },
      {
        prompt: "What does Hebrews 13:15 call worship?",
        options: [
          "A feeling of gratitude",
          "A sacrifice of praise — the fruit of lips that openly profess His name",
          "A weekly obligation",
          "A performance for the congregation",
        ],
        answerIndex: 1,
        explanation:
          "Hebrews 13:15's \"sacrifice of praise\" is one of three anchors (with shâchâh — to bow — and worship \"in spirit and in truth\") behind the conviction that worship is something given, not just felt.",
      },
      {
        prompt: "What does it mean for a song's lyrics to \"never leave the worshiper\"?",
        options: [
          "The song is too long",
          "The lyrics stay entirely inside the worshiper's own story or feelings and never actually declare anything about God",
          "The worshiper forgets the words",
          "The song isn't in the church's usual key",
        ],
        answerIndex: 1,
        explanation:
          "A sacrifice is carried out of the worshiper's possession and laid down before God. A song whose content never gets past the worshiper's own experience — however moving — hasn't made that trip. Feeling happened; nothing was given.",
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
        text: "For any lyric — one we've written or are considering leading — we ask: **what is the function of the worshiper's presence?** And: **is she giving something to God, or reporting something about herself?** The pronoun does not decide it. The function does.",
      },
      {
        kind: "rule",
        title: "The test is grammatical-person-blind",
        text: 'Swapping "I" for "we" does not move a song from one zone to the other. "We\'ll never be more loved than we are right now" is still self-as-recipient-of-affection — just collective. Read for function, not for pronoun.',
      },
      { kind: "heading", text: "Why pronoun-counting fails" },
      {
        kind: "p",
        text: 'The same holds for possessives. "My King, my Rock, my Savior" is relational ascription — naming God by what He is, with "my" indicating covenant rather than experience. "My story, my journey, my experience" is testimony — the worshiper\'s biography as content. Same pronoun, opposite function.',
      },
      {
        kind: "p",
        text: 'Even the same verb can point in opposite directions. "When I in awesome wonder consider all the worlds Thy hands have made" uses "I" as the giver of consideration outward, toward God\'s works — offering, and welcome. "Who thought I\'d find You at the lowest place?" uses "I" as the reporter of personal surprise — testimony, and not the diet. Both have "I" as grammatical subject; the function is opposite.',
      },
      {
        kind: "reveal",
        prompt:
          "\"Take my life and let it be consecrated, Lord, to Thee.\" Self surrenders using \"my life.\" Does the possessive make this about the worshiper?",
        answer:
          "No — direction is what matters, not the possessive. \"My life\" is being GIVEN to God here, yielded to His authority; the line runs outward. Compare \"my story, my journey\" — same word, but pointed at the worshiper's own biography as the content. Read for function, not the word.",
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
          "What the function of the worshiper's presence is — giving to God, or reporting about herself",
          "Whether it rhymes",
          "How many times God is mentioned by name",
        ],
        answerIndex: 1,
        explanation:
          "The test is a function question, not a word-count exercise: is the worshiper's presence there to give something to God, or to report something about herself? The pronoun never settles it.",
      },
      {
        prompt: "Why does counting \"I\" vs. \"we\" fail as a test?",
        options: [
          "Because \"we\" always drifts to testimony",
          "Because the test is grammatical-person-blind — \"We'll never be more loved than we are right now\" is still self-as-recipient, just collective",
          "Because congregations only sing \"we\"",
          "Because \"I\" is always doxological",
        ],
        answerIndex: 1,
        explanation:
          "Swapping the pronoun doesn't change the function. A song about receiving love is about receiving love whether it says \"I\" or \"we\" — the drift is the same, just collectivized.",
      },
      {
        prompt: "\"My King, my Rock, my Savior\" and \"My story, my journey, my experience\" share the same possessive. What's true?",
        options: [
          "They're both testimony because they both use \"my\"",
          "They're opposite functions — the first names God by covenant relationship (ascription), the second makes the worshiper's biography the content (testimony)",
          "Neither passes the test",
          "Possessives always fail the test",
        ],
        answerIndex: 1,
        explanation:
          "Same pronoun, opposite function: \"my\" can indicate covenant (naming who God is to me) or it can make the worshiper's own story the subject. Read for function, not the word.",
      },
      {
        prompt: "\"When I in awesome wonder consider all the worlds Thy hands have made\" — what makes this offering, not testimony, despite the \"I\"?",
        options: [
          "It's an old hymn, so it's automatically doxological",
          "\"I\" is the giver of consideration outward, toward God's works — the direction is Godward, not inward",
          "It doesn't mention God directly",
          "It has more words than a typical testimony line",
        ],
        answerIndex: 1,
        explanation:
          "The verb \"consider\" points outward at God's works here — the worshiper's faculties are the instrument, God's works are the content. Compare to a line where \"I\" reports personal surprise or experience: same subject, opposite function.",
      },
    ],
  },

  // ── 3 · Doxology: four shapes of praise ────────────────────────────────
  {
    slug: "music-four-shapes-of-praise",
    title: "Four shapes of praise",
    subtitle: "Ascription, offering, diminishment, surrender",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "Ascription is the core of doxological worship — the purest form. The other three shapes are expressions of it: ways the worshiper's presence serves the declaration of God's glory rather than competing with it.",
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
            "Self as the giver of attention, wonder, voice, awe — faculties turned Godward as instruments of the declaration. \"Bless the Lord, O my soul\" is the paradigm: the soul is the addressee, God is the destination.",
            "Ps 34:3; Ps 103:1; Ps 121:1; Ps 145:1–2; Lk 1:46",
          ],
          [
            "**Diminishment** (inverse doxology)",
            "Self appears only to be made small so that God's glory appears larger. \"He must increase, I must decrease.\"",
            "Job 40:4; Isa 6:5; Lk 5:8; Gen 18:27; Jn 3:30",
          ],
          [
            "**Surrender** (embodied doxology)",
            "Self appears only to be yielded to God's authority — the worshiper's life itself becomes a declaration of His lordship.",
            "Rom 12:1; Lk 22:42; Lk 1:38; Isa 6:8",
          ],
        ],
      },
      {
        kind: "rule",
        title: "The welcome zone has four shapes",
        text: "Self appears only to make God greater, or not at all. Each is a different way of pointing the same declaration back at Him — ascribing His worth, offering your faculties to it, shrinking beneath it, or yielding your life to it.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study — \"A thousand generations falling down in worship, to sing the song of ages to the Lamb\" (Holy Forever). Which shape, and why?",
        answer:
          "Ascription. The worshiper disappears into \"a thousand generations\" — the content is the Lamb receiving worship across all time, not the worshiper's own experience. The catalog rates the whole song doxological throughout on this pattern.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study — \"O Lord my God, when I in awesome wonder, consider all the worlds Thy hands have made\" (How Great Thou Art, v.1). Which shape?",
        answer:
          "Offering — the philosophy's own canonical example. \"I\" is the giver of wonder, sight, and hearing, turned outward to God's works. The worshiper's faculties are the instrument of the declaration, not its content — the magnifying glass, not what you see through it.",
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
        prompt: "Which shape is described as \"the core of doxological worship — the purest form\"?",
        options: ["Offering", "Ascription", "Diminishment", "Surrender"],
        answerIndex: 1,
        explanation:
          "Ascription — direct declaration of who God is — is the center. The other three shapes (offering, diminishment, surrender) are ways the worshiper's presence serves that same declaration rather than competing with it.",
      },
      {
        prompt: "\"Bless the Lord, O my soul\" is the paradigm of which shape?",
        options: ["Ascription", "Offering", "Diminishment", "Surrender"],
        answerIndex: 1,
        explanation:
          "Offering — the soul is addressed as the instrument, and God is the destination. The worshiper's faculties (voice, attention, wonder) are turned Godward as instruments of the declaration.",
      },
      {
        prompt: "\"He must increase, I must decrease\" is the shape of...",
        options: ["Offering", "Surrender", "Diminishment", "Ascription"],
        answerIndex: 2,
        explanation:
          "Diminishment — self appears only to be made small so God's glory appears larger by contrast. It's inverse doxology: the worshiper shrinks, the glory grows.",
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
          "Ascription, offering, diminishment, and surrender are four different postures pointed at the same target: making God greater. Whenever self shows up in one of these shapes, it's serving the declaration, not competing with it.",
      },
    ],
  },

  // ── 4 · Doxology: the five drifts ──────────────────────────────────────
  {
    slug: "music-the-five-drifts",
    title: "The five drifts",
    subtitle: "Discoverer, recipient, testifier, resolved, petitioner — not the diet",
    minutes: 4,
    blocks: [
      {
        kind: "p",
        text: "The songs outside the welcome zone are not bad — they are anthropological rather than doxological. Their content is the human experience of God rather than God Himself. Lament, testimony, confession, and petition are all faithful forms of worship in their proper place. We sing these. We do not build our identity around them, because the church already has them in abundance.",
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
            "Self as supplicant — asking, requesting, naming need",
            "\"Open the eyes of my heart, Lord\"",
          ],
        ],
      },
      {
        kind: "rule",
        title: "Not forbidden — not the diet",
        text: "The welcome zone has four shapes; the not-the-diet zone has five. None of the five is wrong to sing. The conviction is only that a catalog built mainly from these five trains a congregation to spend its whole worship set thinking about itself — moved, perhaps deeply, but never past its own perimeter.",
      },
      { kind: "heading", text: "How the drift happens" },
      {
        kind: "p",
        text: "Each of the four doxological shapes can slide into its closest anthropological cousin, usually mid-line: **ascription → testimony** (\"You are Faithful Father, never failing\" drifts to \"You've never failed me yet\"), **offering → recipient** (\"I lift my hands to bless the Lord\" drifts to \"I lift my hands to receive all You have for me\"), **diminishment → discoverer** (\"I am nothing without You\" drifts to \"how did I get this lucky?\"), and **surrender → resolved** (\"Have Your way in me\" drifts to \"I'll never let go of Your hand\"). The drift is rarely deliberate — it's the gravity of the worshiper's own story pulling the line back to herself.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study — \"All my life You have been faithful, all my life You have been so, so good\" (Goodness of God). Ascription, or a drift into testimony?",
        answer:
          "Testimony — the catalog's verdict on the whole song is anthropological. Compare it to plain ascription, \"You are faithful\": the \"all my life\" prefix turns a declaration about God into biography about the worshiper. Same claim, different function — the classic ascription → testimony drift.",
      },
      {
        kind: "reveal",
        prompt:
          "Case study — \"Open up my eyes in wonder, and show me who You are and fill me with Your heart\" (Build My Life, chorus). Which anthropological shape?",
        answer:
          "Self as petitioner — the fifth anthropological shape. \"Open, show, fill, lead\" all ask God to act on the worshiper; the direction reverses from giving to receiving. It's the same shape as \"Open the eyes of my heart, Lord\" in the test.",
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
          "The welcome zone has four shapes (ascription, offering, diminishment, surrender). The not-the-diet zone has five (discoverer, recipient, testifier, resolved, petitioner) — self carries the song in every one of the five.",
      },
      {
        prompt: "Are the five anthropological shapes forbidden?",
        options: [
          "Yes — they should never be sung",
          "No — they're faithful forms of worship in their proper place; the concern is making them the steady diet, not singing them at all",
          "Only \"petitioner\" is forbidden",
          "Only in congregational settings",
        ],
        answerIndex: 1,
        explanation:
          "Not the diet, not forbidden. Lament, testimony, confession, and petition are faithful in their place — the conviction is against building a catalog's identity around them, not against ever singing them.",
      },
      {
        prompt: "\"Have Your way in me\" drifting to \"I'll never let go of Your hand\" is an example of which drift pair?",
        options: [
          "Ascription → testimony",
          "Offering → recipient",
          "Surrender → resolved",
          "Diminishment → discoverer",
        ],
        answerIndex: 2,
        explanation:
          "Surrender (yielding to God's authority) drifts to resolved (the worshiper's own promise or commitment) — the energy moves from God acting on the worshiper to the worshiper's resolve about herself.",
      },
      {
        prompt: "What causes the drift from a doxological shape to its anthropological cousin, according to the philosophy?",
        options: [
          "Bad theology on the songwriter's part, always deliberate",
          "The gravity of the worshiper's own story pulling the line back to herself — rarely deliberate",
          "Using contemporary instrumentation",
          "Singing in the first person",
        ],
        answerIndex: 1,
        explanation:
          "The drift is rarely a deliberate theological choice — it's the natural pull of the worshiper's own story reasserting itself mid-line. That's exactly why the test has to be applied line by line, not just to a song's overall theme.",
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
          "**Singability.** Songs are ideally written so a congregation can actually sing them in the rooms where we lead worship.",
        ],
      },
      {
        kind: "rule",
        title: "Fear of God in the room",
        text: "Songwriting that calls itself worship is no small thing. We approach the work as people who will give an account. \"The fear of the LORD is the beginning of wisdom\" (Proverbs 9:10).",
      },
      {
        kind: "p",
        text: "We do not begin with method. We begin with bowing. We will fail. When we do, we want to be told, with Scripture in hand. This work is submitted to God and to His people — every song, whether we wrote it or are simply leading it this Sunday.",
      },
      {
        kind: "reveal",
        prompt:
          "Your team wants to cover a wildly popular new worship song everyone already knows. Does its popularity mean it skips the test?",
        answer:
          "No — the same standard applies to every song, whether you wrote it or it's already in wide circulation. Popularity doesn't exempt a cover, a hymn, or a radio hit from the same line-by-line test as an original.",
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
          "Every writing room designates someone whose job is applying the doxological test to the lyric before the song is considered finished — the standard is a role, not an afterthought.",
      },
      {
        prompt: "Does a song's popularity exempt it from the test when leading a cover?",
        options: [
          "Yes — popular songs are already vetted by their success",
          "No — a cover, hymn, or already-circulating worship song goes through the same test as an original",
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
          "It's a posture, not an emotion — treating worship songwriting with the seriousness of people who will answer for what they put in a congregation's mouth.",
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
        text: "Before you lead a song — a cover, a hymn, or something new — there's a short checklist to work through with your Music Lead. It exists so the whole team (accompanists, harmony singers, sound) knows what you're bringing well before the day you sing it.",
      },
      {
        kind: "bullets",
        items: [
          "**Name of song and artist**, checked against the Selection Philosophy — the same test every song in the catalog goes through.",
          "**A short reference recording** (30 seconds to a minute) of the version you want to cover.",
          "**Your own version, with your own flavor** — a recording of you singing the cover with your modifications, not just the original.",
          "**Accompaniment plans** — what you want backing the song (keyboard, guitar, drums, etc.).",
          "**Harmony coordination** — coordinate harmonies yourself, or let your Music Lead know in advance that you'll need help pulling other singers in.",
          "**Pre-recorded, or performed live the day of** — decide which, and say so.",
          "**A written arrangement** of the song (e.g. v1, chorus ×2, bridge) — chord progression is optional but welcome.",
        ],
      },
      {
        kind: "rule",
        title: "The philosophy comes first",
        text: "Checking the song against the Selection Philosophy is the first item on the list, not an afterthought — the same test from the doxology course applies whether the song is a hymn, a cover, or something you wrote yourself.",
      },
      {
        kind: "reveal",
        prompt:
          "You've picked a cover and you know exactly how you want to sing it, but you haven't recorded a demo of your own version yet — just filled out the checklist form. Ready to submit?",
        answer:
          "Not quite — the checklist wants an actual recording of you singing the cover with your modifications, not just a plan. The reference recording shows what you're covering; your own take shows how.",
      },
      {
        kind: "tip",
        text: "Set-building and rehearsal craft are coming to this course — for now, this is the per-song submission checklist.",
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
          "Checking against the Selection Philosophy comes first — every song, cover or original, goes through the same doxological test before anything else is planned.",
      },
      {
        prompt: "You want harmony singers on your cover. What does the checklist ask you to do?",
        options: [
          "Nothing — harmonies are always arranged automatically",
          "Coordinate them yourself, or tell your Music Lead in advance that you'll need help pulling other singers in",
          "Sing without harmonies",
          "Only the Music Lead can request harmonies",
        ],
        answerIndex: 1,
        explanation:
          "Harmony coordination is on you or your Music Lead — but it has to happen in advance, not day-of, so the other singers have time to learn their parts.",
      },
      {
        prompt: "Why does the checklist ask for a recording of your OWN version, not just a reference recording of the original?",
        options: [
          "It doesn't — only the original matters",
          "Because you're expected to bring your own flavor to the cover, and the team needs to hear what that sounds like, not just the source",
          "To prove you can sing",
          "For copyright purposes only",
        ],
        answerIndex: 1,
        explanation:
          "Two recordings serve two different purposes: the reference recording shows what you're covering, and your own version shows how you're covering it — the modifications and flavor you're bringing.",
      },
      {
        prompt: "What does this course's description say is coming next?",
        options: [
          "Nothing — this is the complete course",
          "Set-building and rehearsal craft",
          "A producing certification",
          "A songwriting bootcamp",
        ],
        answerIndex: 1,
        explanation:
          "This course is deliberately one lesson for now — the per-song submission checklist. Set-building and rehearsal craft are marked coming soon.",
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
        text: "\"Producer\" is a broad, versatile term. It can trip people up because you don't necessarily need to play an instrument, sing, or make beats to be one. Producing is about bringing order to chaos to achieve a desired result — taking all the moving parts of making music (the chaos, opinions, egos, people, and ideas) and transforming them into a finished song, ready for release.",
      },
      { kind: "heading", text: "A different perspective: the apple metaphor" },
      {
        kind: "table",
        headers: ["Producer", "What they do"],
        rows: [
          [
            "**The Gardener**",
            "Nurtures apple trees directly — studies the plants, masters the climate, spends years cultivating, harvests their own apples.",
          ],
          [
            "**The Farm Owner**",
            "Doesn't grow apples themselves — hires the Gardener, recruits workers to wash/package/brand, arranges transport. Produces apples by coordinating resources.",
          ],
          [
            "**The Shopper**",
            "Doesn't plant or farm at all — drives to the store, picks a bag of apples, delivers them. Different method, same result: apples delivered.",
          ],
        ],
      },
      {
        kind: "rule",
        title: "All three are \"producing\"",
        text: "Producing is about understanding all the steps to a result and either executing them yourself, coordinating others to complete them, or using pre-existing solutions to get there faster. It's about vision and leadership more than any specific skill set.",
      },
      { kind: "heading", text: "Example workflows" },
      {
        kind: "bullets",
        items: [
          "**Traditional hip-hop producing:** choose a sample → build an instrumental around the loop → write lyrics → adjust the instrumental to fit → book studio time and an engineer → record.",
          "**Inspiration hit:** hum ideas into a voice memo → turn the memo into an instrumental → write lyrics → record.",
          "**\"$$$\":** find a songwriter → buy a song from them → re-record it with your artist.",
          "**The messy-first method:** buy an instrumental → loop it and record an open-ended freestyle → refine the best parts into lyrics → hate it (this step is important) → wake up the next day and love it → share it with trusted friends/artist for feedback → finish the song based on their reactions.",
          "**\"DJ Khaled\":** know a lot of artists → gather them in one room → play instrumentals → record the best ideas → add your signature tagline.",
        ],
      },
      {
        kind: "tip",
        text: "Hate it. (This step is important.) — the messy-first method's third step isn't a joke: writing something you initially dislike, then coming back to it with fresh ears, is a real and repeatable part of finishing a song.",
      },
      { kind: "heading", text: "Choosing your steps" },
      {
        kind: "p",
        text: "There's no universal formula — just like there's no guaranteed recipe for making a million dollars. The steps you take depend on your **time** (what's your deadline?), **budget** (how much can you spend?), **talent** (what skills do you have?), **collaborators** (who can you work with, and what are their strengths?), and **vision** (who will be the face of the project?).",
      },
      {
        kind: "reveal",
        prompt:
          "You don't play an instrument, sing, or make beats — you just buy a finished instrumental and hand it to a songwriter and an engineer. Are you producing?",
        answer:
          "Yes — that's Producer C in the apple metaphor, the Shopper. You don't grow or farm anything, but you still deliver the result. Producing is about understanding the steps to a result and either executing them, coordinating them, or using pre-existing solutions — not one specific hands-on skill.",
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
          "No — producing means bringing order to chaos to deliver finished music, and that can be done by coordinating others or using existing solutions",
          "Only if you're the artist too",
          "Only for hip-hop production",
        ],
        answerIndex: 1,
        explanation:
          "The Farm Owner and the Shopper in the apple metaphor never touch an instrument either — they coordinate or acquire. All three are still \"producing\" because the result (apples, or a finished song) gets delivered.",
      },
      {
        prompt: "In the apple metaphor, what do the Gardener, the Farm Owner, and the Shopper have in common?",
        options: [
          "They all personally grow the apples",
          "They all deliver apples to someone, by different methods — all three count as \"producing\" them",
          "Only the Gardener actually produces anything",
          "Nothing — they're unrelated roles",
        ],
        answerIndex: 1,
        explanation:
          "Different methods, same result: apples delivered. Producing music works the same way — hands-on creation, coordination, or acquisition can all be legitimate production.",
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
          "The step is called out as important on purpose — disliking a rough draft is normal, not a signal to abandon it. Coming back the next day with fresh ears is part of the process.",
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
          "There's no universal formula for producing music — the right steps depend on your deadline (time), what you can spend (budget), your own skills (talent), who you can work with (collaborators), and who will be the face of the project (vision).",
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
        text: "An artist is more than just a musician — they are a brand. Think of yourself as a business: your music is your product, but your brand — your image, values, and presence — is what sells it. Two artists can sing the exact same song, yet their branding can make those performances feel entirely different.",
      },
      {
        kind: "bullets",
        items: [
          "Your brand should **reflect who you are authentically.**",
          "Your brand should **build trust and loyalty** with your audience.",
          "Your brand should **convey a clear, consistent message** through everything you do — the music you release, the pictures and videos you share.",
        ],
      },
      { kind: "heading", text: "Practical branding tips" },
      {
        kind: "bullets",
        items: [
          "**Be intentional with visuals.** Every photo or video you post adds to your public image — make sure it aligns with your brand values.",
          "**Stay consistent.** From your logo to your social presence, maintain a unified aesthetic and tone.",
          "**Engage your audience.** Build relationships with your fans — respond to comments, show gratitude, share moments of vulnerability or joy.",
        ],
      },
      {
        kind: "rule",
        title: "Public Worship standards",
        text: "As an artist associated with Public Worship, you're held to a higher standard. Your music doesn't need to be explicitly worship-focused, but it must align with Christian values — artists should view themselves as role models, akin to teachers or leaders within the church.",
      },
      {
        kind: "bullets",
        items: [
          "**Content integrity** — your lyrics, themes, and visuals stay consistent with a Christian lifestyle.",
          "**Public behavior** — you represent not just yourself but the broader faith community, online and offline.",
          "**Spiritual accountability** — surround yourself with mentors and peers who hold you to your commitments.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "You post a personal, unfiltered photo that doesn't match anything else on your page. Does that count as branding?",
        answer:
          "It still shapes your brand — just not intentionally. Every photo or video you post adds to your public image, so the practical move is to be deliberate about visuals rather than random. Consistency is part of what builds trust.",
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
          "The brand — image, values, and presence — not just the song itself",
          "The record label",
          "Streaming algorithm placement",
        ],
        answerIndex: 1,
        explanation:
          "Two artists can sing the exact same song and it can feel entirely different — the brand around the music is what sells it, not the song in isolation.",
      },
      {
        prompt: "Does a Public Worship-affiliated artist's non-worship music need to be explicitly Christian in content?",
        options: [
          "Yes, every release must be a worship song",
          "No — but it must still align with Christian values, since the artist is held to a higher standard as a representative of the faith community",
          "No standards apply outside worship music",
          "Only if the artist is a paid staff member",
        ],
        answerIndex: 1,
        explanation:
          "The music itself doesn't have to be worship-focused, but content integrity and public behavior standards still apply — the artist is seen as a role model, not just a musician.",
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
          "It's relational, not procedural — having people in your life who can actually speak into your choices and hold you to the standard you've claimed.",
      },
      {
        prompt: "Why can two artists singing the same song feel completely different to an audience?",
        options: [
          "Different microphones",
          "Their branding — image, values, and consistent presence — shapes how the performance is received",
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
        text: "Because of the real costs involved in producing and releasing a track, the artist is usually the one taking on the financial responsibility for a project — which is part of why an artist can also act as a producer, a vocalist, or even a company.",
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
        text: "For Public Worship songs where the organization is the artist, Public Worship typically takes on the majority of the fiscal responsibility for the release — which is exactly why we're selective about the songs we choose to release. This isn't personal; it's stewardship, not gatekeeping. We may not always agree on which songs should get that privilege.",
      },
      {
        kind: "p",
        text: "The good news: you always have the option to take on that financial responsibility yourself and release your song as your own artist. As an artist, you're a business owner — and any successful business owner knows the importance of calculating return on investment.",
      },
      { kind: "heading", text: "The fork in the road" },
      {
        kind: "p",
        text: "Not everyone who loves music should be the artist fronting a release budget. There are other ways to contribute meaningfully:",
      },
      {
        kind: "bullets",
        items: [
          "**Producing** — shaping the sound and vision of songs.",
          "**Writing** — crafting lyrics and melodies for other artists.",
          "**Vocal performance** — recording backing or lead vocals for others.",
          "**Playing instruments** — contributing your musical skills to live or recorded projects.",
        ],
      },
      {
        kind: "reveal",
        prompt:
          "A songwriter asks Public Worship to release their song idea as an official release. The team says no. Is that a verdict on their talent?",
        answer:
          "No — it's stewardship, not personal judgment. Asking Public Worship to release an idea is asking the organization to bet $500 or more on it, since PW typically takes on the majority of the fiscal responsibility for its own releases. Selectivity protects that bet; it isn't a verdict on the songwriter.",
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
          "Production, recording, mixing/mastering, distribution, and marketing add up to roughly $300–650+ — real money, which is exactly why releases aren't approved casually.",
      },
      {
        prompt: "Why is Public Worship selective about which songs it releases as an organization?",
        options: [
          "Personal taste of whoever is in charge that week",
          "Releasing a song means betting real money ($500+) on it — selectivity is stewardship of that money, not gatekeeping someone's talent",
          "There's a strict quota of releases per year",
          "Only staff-written songs are eligible",
        ],
        answerIndex: 1,
        explanation:
          "Since the organization typically fronts the fiscal responsibility for its own releases, asking to release an idea is asking Public Worship to bet real money on it — the selectivity is about stewarding that bet, not judging the person.",
      },
      {
        prompt: "If you're not ready to front the budget for your own release, what's an alternative path into music, per this lesson?",
        options: [
          "There is none — you must be the artist or nothing",
          "Producing, writing, vocal performance, or playing instruments for other artists",
          "Only working for a label",
          "Waiting until you can self-fund a full album",
        ],
        answerIndex: 1,
        explanation:
          "The \"fork in the road\" names four other ways to contribute meaningfully — producing, writing, vocal performance, and playing instruments — without being the artist who fronts the release budget.",
      },
      {
        prompt: "As an artist financially responsible for your own release, what does the lesson say you should calculate?",
        options: [
          "Nothing — art shouldn't be measured financially",
          "Return on investment, the same way any business owner would",
          "Only your streaming numbers",
          "Your total studio hours",
        ],
        answerIndex: 1,
        explanation:
          "Being an artist who funds your own release makes you a business owner in a real sense — and calculating ROI on that investment is part of treating it like one.",
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
 * now), and the producer/artist roles.
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
      "What to submit before you lead a song — checked against the " +
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
      "it takes to build an artist brand — including the standard Public " +
      "Worship-affiliated artists are held to — and the honest economics of " +
      "releasing a song.",
    icon: "headphones",
    moduleSlugs: [
      "music-what-a-producer-does",
      "music-artist-is-a-brand",
      "music-the-economics-of-a-song",
    ],
  },
];
