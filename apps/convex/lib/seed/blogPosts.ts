/**
 * The ONE post that existed as markdown when the blog moved into the OS.
 *
 * `apps/landing/src/content/blog/doxology.md`, migrated VERBATIM: the body
 * below is the file's markdown byte for byte (frontmatter removed — those
 * fields became columns), and the fields around it are that frontmatter's
 * values, including its `pubDate: 2026-08-25`. Nothing is paraphrased and
 * nothing is "tidied", because this post is live, has been shared, and has
 * `blogReactions` rows recorded against its slug.
 *
 * ── The slug is pinned, not derived ─────────────────────────────────────────
 * `doxology` is the live URL: Astro's glob loader sets `post.id` from the
 * filename (`doxology.md`), `[...slug].astro` routes on `post.id`, and PR #795
 * shipped it as "Publish the doxology essay at /blog/doxology".
 * `blogSlugFromTitle("Why We Sing What We Sing")` would produce
 * `why-we-sing-what-we-sing` — a tidier slug that would 404 every shared link
 * and orphan every `blogReactions` row. The migration keeps the URL people
 * already hold.
 *
 * DO NOT take `doxological-worship` from `tests/blogReactions.test.ts` as the
 * answer here. That is an arbitrary fixture string in a test about slug
 * NORMALIZATION, not a record of what the post is called; an earlier draft of
 * this file used it and would have 404'd the one live post on the day the blog
 * moved. The authority is the filename and the two commits that named the URL
 * (#782 renamed the file precisely so the post would live at /blog/doxology,
 * noting the previous slug had never been linked).
 *
 * Consumed by `marketingBlog.ts#seedBlogPostsIfEmpty`, which inserts it only
 * into an empty table — the same "if empty" rule as
 * `listings.ts#seedListingsIfEmpty` and `marketingSite.ts#seedSiteContentIfEmpty`.
 */

/** `pubDate: 2026-08-25` from the frontmatter, as ms. UTC midnight, matching
 *  how Astro's content collection parsed a bare `YYYY-MM-DD` — the date the
 *  page prints must not move by a day under a reader mid-migration. */
export const DOXOLOGY_PUBLISHED_AT = Date.UTC(2026, 7, 25);

/** The migrated post, minus the fields only a live row can have (ids, the
 *  preview token, timestamps) — `seedBlogPostsIfEmpty` supplies those. */
export const DOXOLOGY_POST = {
  slug: "doxology",
  status: "published" as const,
  title: "Why We Sing What We Sing",
  description:
    "Most of our songs are about God. Not about how we feel about God, or what we get from God. Just God Himself. Here is the word for that kind of song, and the test we run every lyric through.",
  subtitle:
    "What you should expect when you worship with us, and the standard we invite every worship leader who serves with us into.",
  audience: "everyone who worships with us",
  author: "The Public Worship Team",
  tags: ["Songwriting", "Song Selection", "Worship"],
  reactionsEnabled: true,
  publishedAt: DOXOLOGY_PUBLISHED_AT,
};

/** The post's markdown, exactly as it stood in the repo. */
export const DOXOLOGY_BODY = `We center our catalog on doxological worship: songs whose whole subject is the glory of God, with the worshiper present only as an instrument of that declaration.

Most of the songs we write and sing are directed towards God. Not about how we feel about God. Not about what we get from God. Just God Himself.

That is on purpose.

This is a focus, not a verdict on other forms of worship music. Scripture sings in many faithful registers, including lament, testimony, confession, petition, and thanksgiving, and we honor them. We sing them too. We are choosing to specialize in what we believe is hardest to find right now: songs that declare God Himself from the first line to the last.

## The word: doxology

Doxology comes from two Greek words: doxa (δόξα), meaning glory, the weight, radiance, and visible splendor of who God is; and logos (λόγος), meaning word or declaration. A doxology is, at its simplest, a declaration of God's glory.

You have sung doxologies your whole life, even if you have never used the word. "Praise God from whom all blessings flow" is a doxology. The angels' "Holy, holy, holy" is a doxology (Isa 6:3; Rev 4:8). When Paul, in the middle of an argument, breaks into "For from him and through him and to him are all things. To him be the glory forever. Amen," that is a doxology (Rom 11:36).

What they have in common is simple: the song is about God, not about us.

A doxology does not report what God did for me or describe how I feel about Him. It declares who God is: His character, His acts, and His worth. Then it stops there.

What He has done can be the reason for the praise. It is never the place the song sits down.

You are still in the room, still singing. You are the instrument, not the subject.

When we say we center our catalog on doxological worship, we mean that we are writing and selecting songs whose content, from the first line to the last, is the glory of God declared.

## Why we build on it

The Hebrew word for worship, shâchâh, means to bow down. Jesus says the Father seeks worshipers who worship in spirit and truth (John 4:23). Hebrews 13:15 calls worship a sacrifice of praise, the fruit of lips that openly profess His name.

A bow. An honest one. A sacrifice.

Which leads to our conviction:

> A song whose lyrics never leave the worshiper has not yet brought a sacrifice.

A sacrifice is something that leaves your hands. It is carried out of your possession and laid before God (Rom 12:1). A lyric leaves your hands the same way: when it is handed to God. If a song never gets outside your own story and is never handed to anyone, nothing has left your hands yet.

Lament, testimony, confession, petition, and thanksgiving all belong in christian music. Scripture gives them to us. Sung in their proper moment, they are holy.

But each form carries a risk we do not always feel while singing it. A testimony song can keep us dwelling on what God did for us. A petition song can keep us dwelling on what we still need. A confession song can keep us dwelling on what we have done. If those forms become our steady diet, they can quietly train a room to spend its whole time in worship thinking about itself: its situation, its journey, its longings, and its sins.

That is the danger we are addressing. These songs are not wrong. Many of them have served people deeply. The danger is that their lyrics can leave us inside our own perimeter for the entire song, moved perhaps, but still the subject of our own attention.

> The room may have wept, but the altar is still empty.

To be especially clear about grief: God's people lament throughout Scripture, and a lament is handed to God. "How long, O LORD?" is aimed straight up, even though it is about our pain (Ps 13). It is simply not the diet we are centering on, because its subject is our condition, and we are centering on songs whose subject is Him. A room where people cannot bring their grief to God has failed in the opposite direction. We do not want to build that room.

We are not writing against these other forms. We are writing for the form we believe keeps them pointed in the right direction, and the form the wider church already has less of: sustained declaration of God Himself.

When we look honestly at contemporary worship, we believe the inward drift has happened on a wide scale. Many of the most-sung worship songs put the singer dangerously close to the center. A steady diet of those songs can form people who turn inward the moment the music starts and never make it back out.

So we hold two things:

Doxology is the shape where it is hardest to end up at the center. Put plainly, it is the shape where it is hardest to accidentally worship yourself or your situation. Almost nobody does that on purpose. That is exactly why the shape of the song matters. When the whole song declares who God is, the giving is built into the form.

A catalog needs a strong doxological core to keep its other songs honest. Lament, testimony, confession, petition, and thanksgiving remain worship when they are sung by people whose ears know what pure declaration of God sounds like. Cut off from that center, they can become songs about ourselves with a worship melody underneath.

## The test

For any lyric, whether ours or a song we are considering leading, we ask one question:

> Why is the singer in this line?

Are they giving something to God, or reporting something about themselves?

Some of the examples below come from songs we love, and some come directly from Scripture. Being biblical is nonnegotiable. But a lyric can be faithful and fully scriptural, even taken straight from the biblical text, without being the form we want at the center of this particular catalog. The question here is what job the singer is doing in the line, and whether that is the job we want to build our catalog around.

<div class="pw-scroll">
<table>
  <thead>
    <tr>
      <th>Why the singer is in the line</th>
      <th>Example</th>
      <th>Verdict</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Not there at all, or there only to bow and name who God is (<strong>ascription</strong>)</td>
      <td><em>&ldquo;A thousand generations falling down in worship&rdquo;</em></td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There to hand something over: attention, wonder, or voice (<strong>offering</strong>)</td>
      <td><em>&ldquo;I will bless the Lord at all times&rdquo;</em> (Ps 34:1)</td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There to ask to see, know, encounter, or apprehend God Himself (<strong>beholding</strong>)</td>
      <td><em>&ldquo;Open the eyes of my heart... I want to see You&rdquo;</em></td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There only to get smaller so God appears greater (<strong>diminishment</strong>)</td>
      <td><em>&ldquo;If the highest place I reach is at Your feet&rdquo;</em></td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There to hand their life over to His authority (<strong>surrender</strong>)</td>
      <td><em>&ldquo;Take my life and let it be consecrated, Lord, to Thee&rdquo;</em></td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There to call others to look at Him (<strong>offering, turned outward</strong>)</td>
      <td><em>&ldquo;Magnify the LORD with me&rdquo;</em> (Ps 34:3)</td>
      <td>✓ Welcome</td>
    </tr>
    <tr>
      <td>There as the one discovering or figuring something out about themselves</td>
      <td><em>&ldquo;I didn't know I was broken till I found You&rdquo;</em></td>
      <td>✗ Not our main diet</td>
    </tr>
    <tr>
      <td>There as the one receiving love, identity, or safety</td>
      <td><em>&ldquo;I'll never be more loved than I am right now&rdquo;</em></td>
      <td>✗ Not our main diet</td>
    </tr>
    <tr>
      <td>There to tell the story of what God did for them</td>
      <td><em>&ldquo;He makes me lie down in green pastures&rdquo;</em></td>
      <td>✗ Not our main diet</td>
    </tr>
    <tr>
      <td>There to promise their own constancy</td>
      <td><em>&ldquo;I'll never let go of Your hand&rdquo;</em></td>
      <td>✗ Not our main diet</td>
    </tr>
    <tr>
      <td>There to sing about God's benefits</td>
      <td><em>&ldquo;I have joy, joy, joy in my heart&rdquo;</em></td>
      <td>✗ Not our main diet</td>
    </tr>
  </tbody>
</table>
</div>

In the first six lines, God remains the subject, object, or destination of the song. In the last five, the singer or the singer's benefit carries the song.

<div class="pw-note">
<p><strong>💡 Pronouns are not the test.</strong> Swapping "I" for "we" changes nothing. "We'll never be more loved" is still the singer receiving, just as a group. "My King, my Rock" passes because "my" names a covenant relationship and still tells us who God is. "My story, my journey" does not. Same word, opposite job.</p>
</div>

## The five shapes we welcome

Ascription is the core. The other four serve it. They are ways the singer can be present without competing with the declaration of God's glory or making God a means to another end.

**Ascription: saying who He is.** Straight declaration of who God is and what He has done. The worshiper may be absent from the lyric or present only as one of those declaring. This is the center of our catalog. Isa 6:3; Rev 5:12; Ps 99; Phil 2:6-11.

**Offering: pointing everything at Him.** Your attention, wonder, and voice turn Godward. "Bless the Lord, O my soul" is the clearest case (Ps 103:1). Your soul is who is being addressed; God is where it lands. You are in the song, but only as the magnifying glass. God is what you see. The address can turn outward too: "Magnify the LORD with me" (Ps 34:3) does to the room what "Bless the Lord, O my soul" does to your own soul, and Scripture commands it; we sing to one another and to the Lord in the same breath (Eph 5:19; Col 3:16). Whoever is being addressed, God is where it lands. Vows of praise belong here too. "I will bless the Lord at all times" promises God something: praise. Test what a promise offers, not the fact that it promises.

**Beholding: seeking God Himself.** You ask to see, know, encounter, or apprehend God, and God remains the destination of the desire. "Show me Your glory" is a petition, but what is requested is God Himself. Ex 33:18; Ps 27:4; Eph 1:17-18.

**Diminishment: getting smaller on purpose.** You appear only to be brought low so God's glory appears greater. "He must increase, I must decrease." Isa 6:5; Lk 5:8; Jn 3:30. Confession born of seeing Him lives here. Isaiah says "Woe is me" because his eyes have seen the King. The vision is the subject; the woe is its echo.

**Surrender: handing your life over.** You appear only to yield yourself to God's authority. Your life becomes a declaration of His lordship. Rom 12:1; Lk 22:42; Isa 6:8.

## Where good songs drift

Each of the five shapes can slide toward its nearest cousin, sometimes in the middle of a line:

Ascription (saying who He is) → telling my story. "You are Faithful Father" becomes "You've never failed me yet." Now my experience is the proof.

Offering (pointing at Him) → reaching for me. "I lift my hands to bless the Lord" becomes "I lift my hands to receive all you have for me." Same posture, opposite direction.

Beholding (seeking Him) → seeking what He can give me. "Show me Your glory" becomes "and give me my breakthrough." Now we ask for more than just Him.

Diminishment (getting smaller) → figuring it out. "I am nothing without You" becomes "How did I end up this blessed?" Now my surprise is the point.

Surrender (handing over) → promising. "Have Your way in me" becomes "I'll never let go." Now the center is my willpower.

Almost nobody does this on purpose. It is simply gravity. Our own story pulls the line back home.

## What we sing but do not build on

**Songs centered on human experience.** Lament (Ps 13), testimony (Ps 23), confession seeking cleansing (Ps 51), and ordinary petition (Ps 40) all have a biblical place. Their subject is the human experience of God. We sing them. We do not build our identity around them because the wider church already has them in abundance, while sustained declaration of God is harder to find.

A petition that asks for God Himself, the sight of His glory, or the knowledge of Him belongs under Beholding rather than ordinary petition. The fact that the singer receives grace or revelation does not make the song self-centered when God Himself remains the end.

**Mixed songs.** Many beloved worship songs and hymns have a strong chorus about God wrapped in verses about the singer's journey. We will sing some of them. We hold two standards here: what we write is strict, and what we lead is discernment. A set can hold a lament and a testimony and be faithful; we watch where the hour comes to rest. But the shape we are trying to write more of is God-centered from the first line to the last, with nothing placed on the altar and then taken back off.

**Thanksgiving.** Thanksgiving is a biblical form. Paul writes it. So do Peter and other biblical writers (Eph 1:3-14; 1 Pet 1:3-5; 2 Cor 1:3-4). These songs stay pointed at God while they declare what God is like and what Christ has done. They drift when they settle on the benefit rather than the Giver and make our experience the center. The form is not the problem. Test the song line by line.

## How we hold ourselves to this

**Scripture comes first.** Every song we release is checked against Scripture and our Statement of Beliefs. That part is not negotiable.

**Someone owns the test.** In every writing room, someone has the responsibility to ask the test question before the song leaves the room.

**Popularity does not create an exemption.** Covers, hymns, and songs already in circulation go through the same test as songs we write.

**We write with the fear of God.** We will give an account for what we put in people's mouths when they worship. We approach the work that way.

## An invitation

This is the part we care about most.

We want the next wave of worshipers to write songs shaped by what moves God, songs that stay pointed at Him from the first line to the last and are held to Scripture before they are held to the algorithm.

We have not figured this out. We expect to keep working through it in writing rooms, in the places where we lead, and with anyone willing to hold us to Scripture while we do.

If that is you, we would love to hear what you write, and we would love the conversation even more.

> "The fear of the LORD is the beginning of wisdom." (Proverbs 9:10)

We do not start with a method. We start by bowing.

We will get things wrong. When we do, tell us, with Scripture in hand. We are submitting this work to God and to His people.

*&mdash; The Public Worship Team*

## Further reading

We are working through as many worship songs as we can and will publish that list when it is ready. Until then, read both groups below.

**Voices that shaped us**

- **[A.W. Tozer, *Whatever Happened to Worship?*](https://www.goodreads.com/en/book/show/721486.Whatever_Happened_to_Worship)** (sermons preached 1961). Worship as the thing we were made for and the jewel the church misplaced.
- **Augustine of Hippo, *Confessions*, Book X.33** (c. 400). A searching reflection on the danger of being more moved by the singing than by what is sung.
- **[Marva Dawn, *Reaching Out without Dumbing Down*](https://a.co/d/02CmICyZ)** (1995). A theology of worship where God is both the subject and the audience, with a warning against letting the surrounding culture set the terms.
- **[Bob Kauflin, "Evaluating Worship Song Lyrics"](https://worshipmatters.com/2006/12/01/worship-leaders-pastors-evaluating-worship-song-lyrics/)** (2006). A working worship pastor's checklist.

**Voices that check us**

- **[Isaac Watts, Preface to *Hymns and Spiritual Songs*](https://www.ccel.org/ccel/ccel/eee/files/wattsprh.htm)** (1707). The case for worship written in the singer's own voice and a check on overcorrecting.
- **[Justin Taylor, "Don't Neglect the Horizontal Dimension of Singing and Worship"](https://www.thegospelcoalition.org/blogs/justin-taylor/dont-neglect-the-horizontal-dimension-of-singing-and-worship/)** (TGC, 2017). An argument through Eph 5:19 and Col 3:16 that singing is also addressed to one another. He is right; calling others in lives inside Offering because of him. Read it before you trust us too much.
- **[Walter Brueggemann, "The Costly Loss of Lament"](https://doi.org/10.1177/030908928601103605)** (JSOT, 1986). A warning that a catalog with no place for grief becomes dangerous in the opposite direction.
`;
