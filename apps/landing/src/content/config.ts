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
 * THE BLOG MOVED TO CONVEX. Posts were a markdown collection here, built
 * statically, so publishing one was a pull request and a deploy — which meant
 * the seat that owns the org's public voice could not publish the org's public
 * writing. They are rows now (`apps/convex/schema/blog.ts`), and /blog,
 * /blog/<slug>, the feed, and the sitemap are server-rendered by
 * `apps/convex/lib/blogPage.ts` so a post still reaches crawlers with a real
 * title, canonical, and description on the first byte. See
 * `packages/shared/src/marketingBlog.ts` for the whole argument.
 */

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

export const collections = { links, faqs, impact, beliefs };
