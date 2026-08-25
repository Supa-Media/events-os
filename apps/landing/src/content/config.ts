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
 * TEAM SEATS moved to the OS. Job listings used to be a `roles` markdown
 * collection here; they now live in Convex (`jobListings`) and the `/team`
 * pages fetch them at runtime from `GET /api/team/roles` (see
 * `pages/team/index.astro`, `pages/team/role.astro`, and the `scripts/team-*`
 * controllers). The role template that used to be this schema is now the
 * `PublicJobListing` wire contract in `@events-os/shared`'s `hiring.ts`, which
 * the OS serializer and the landing renderer both read. Nothing is built from
 * markdown roles anymore, so the collection is gone.
 */

const beliefs = defineCollection({
  loader: file("src/content/beliefs.yaml"),
  schema: z.object({
    id: z.string(),
    body: z.string(),
  }),
});

export const collections = { links, faqs, impact, beliefs, blog };
