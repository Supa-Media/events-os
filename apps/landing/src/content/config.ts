import { defineCollection, z } from "astro:content";
import { glob, file } from "astro/loaders";

const links = defineCollection({
  loader: file("src/content/links.yaml"),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    url: z.string().optional(),
    thumbnail: z.string().optional(),
    bgImage: z.string().optional(),
    cta: z.string().optional(),
    copy: z.string().optional(),
    align: z.enum(["center", "topLeft"]).default("center"),
    featured: z.boolean().default(false),
    // "lead" cards render before the auto-inserted event cards; "trail" (the
    // default) after. See ImportantLinks.astro / links.yaml header.
    slot: z.enum(["lead", "trail"]).default("trail"),
  }),
});

const faqs = defineCollection({
  loader: file("src/content/faqs.yaml"),
  schema: z.object({
    id: z.string(),
    question: z.string(),
    answer: z.string(),
  }),
});

const impact = defineCollection({
  loader: file("src/content/impact.yaml"),
  schema: z.object({
    id: z.string(),
    value: z.string(),
    label: z.string(),
    sublabel: z.string().optional(),
  }),
});

/**
 * The blog. Markdown files in src/content/blog/, built statically — there is
 * no CMS and no database behind a post, so publishing one is a merge to
 * `main` (which fires .github/workflows/deploy-landing.yml).
 *
 * `draft: true` does NOT mean "hidden". It means the post builds to
 * /blog/drafts/<slug> instead of /blog/<slug>, stays out of the index, the
 * RSS feed, and the sitemap, and is served only behind a shared password by
 * pw-router (infra/router/src/draftGate.ts). That is what makes a
 * work-in-progress shareable with an editor before it is public.
 */
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/blog" }),
  schema: z.object({
    title: z.string(),
    // Used verbatim as the <meta name="description"> and the index card's
    // summary, so write it as a sentence, not keywords.
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default("The Public Worship Team"),
    // Who the post is written for, shown above the title. Posts here are
    // aimed at specific rooms (worship leaders, volunteers, backers) and
    // saying so up front is the difference between a reader leaning in and
    // bouncing.
    audience: z.string().optional(),
    // A standfirst — the italic paragraph under the title, before the body.
    subtitle: z.string().optional(),
    heroImage: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    // The emoji bar (apps/convex/blog.ts). On by default; set false for a
    // post where a reaction would be tasteless.
    reactions: z.boolean().default(true),
  }),
});

/**
 * TEAM SEATS — the join-the-team pages (`/team`, `/team/<slug>`).
 *
 * This schema IS the role template. Every field below is required because a
 * role page that skips one stops being comparable to the others, and the whole
 * point of publishing roles this way is that a candidate can read two of them
 * and tell the difference between the seats rather than between the writers.
 *
 * The section order and the three unusual requirements come from
 * `@events-os/shared`'s `hiring.ts` (`ROLE_TEMPLATE_SECTIONS`), which is also
 * what the Hiring desk and the Academy read. The unusual three:
 *
 *  - `outcomes` — each with a `doneWhen`. Not duties: the results this seat is
 *    accountable for, and how we'd both know one landed.
 *  - `authority` — what the holder decides WITHOUT asking. A responsibility
 *    handed over without stated authority comes straight back, which is the
 *    failure this field exists to prevent.
 *  - `notThisRole` — what the seat does NOT own. Half of every role dispute in
 *    a volunteer org is a boundary nobody wrote down.
 *
 * Adding a role is a markdown file plus a merge to `main` (which fires
 * .github/workflows/deploy-landing.yml). There is no CMS behind this on
 * purpose: a published role is a promise about what someone will be asked to
 * do, and it should go through review like anything else we promise.
 * `docs/guides/recruiting.md` walks a director through it.
 */
const roles = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/roles" }),
  schema: z.object({
    title: z.string(),
    /** `open` and `filling` accept applications; `not_open` and `closed`
     *  render (so a candidate can see where the org is going) but point their
     *  apply button at general interest. Mirrors `ROLE_STATUSES`. */
    status: z.enum(["open", "filling", "not_open", "closed"]),
    /** Which part of the org this sits in, e.g. "People", "Music". */
    team: z.string(),
    /** Every seat here is volunteer today. Stated on the page rather than
     *  assumed, because it is the single most important thing a candidate
     *  needs to know before reading further. */
    commitment: z.string().default("Volunteer"),
    location: z.string(),
    /** Real weekly hours. The availability gate is the org's stated hard gate
     *  (the Academy's `mgmt-the-interview`), so the number goes on the page,
     *  not in the interview where it's too late to be useful. */
    hoursPerWeek: z.number(),
    reportsTo: z.string(),
    worksWith: z.array(z.string()).default([]),
    manages: z.array(z.string()).default([]),
    /** Which Empowerment Trial cadence this role runs on (`TRIAL_TRACKS`) —
     *  drives the "what happens after you apply" timings shown on the page. */
    trialTrack: z.enum(["team_member", "director"]),
    /** The seat in `packages/shared/src/seats.ts` this fills, when it maps to
     *  one. Advisory: the org chart is the app's, the posting is the site's,
     *  and a role can be posted before its seat exists. */
    seatId: z.string().optional(),

    summary: z.string(),
    whyThisSeatExists: z.string(),
    outcomes: z
      .array(z.object({ outcome: z.string(), doneWhen: z.string() }))
      .min(1),
    authority: z.array(z.string()).min(1),
    responsibilities: z
      .array(z.object({ area: z.string(), items: z.array(z.string()).min(1) }))
      .min(1),
    rhythms: z.array(z.string()).min(1),
    firstNinetyDays: z.array(z.string()).min(1),
    required: z.array(z.string()).min(1),
    preferred: z.array(z.string()).default([]),
    notThisRole: z.array(z.string()).min(1),
    successLooks: z.array(z.string()).min(1),
    growthPath: z.string().optional(),

    /** Sort order on the index; lower first. */
    order: z.number().default(100),
    postedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
  }),
});

const beliefs = defineCollection({
  loader: file("src/content/beliefs.yaml"),
  schema: z.object({
    id: z.string(),
    body: z.string(),
  }),
});

export const collections = { links, faqs, impact, beliefs, blog, roles };
