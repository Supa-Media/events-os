/**
 * Blog helpers — the one place that decides what "published" means, so the
 * index, the post pages, the RSS feed, the sitemap filter, and the nav link
 * can never disagree about whether a post is public.
 *
 * A draft is not hidden by omission: it builds to /blog/drafts/<slug>, which
 * pw-router holds behind a shared password (infra/router/src/draftGate.ts).
 * Everything here just keeps it out of the PUBLIC surfaces.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import { asset } from "./asset";

export type Post = CollectionEntry<"blog">;

/** Where a post lives, given its draft state. The single source of truth for
 *  a post's URL — used for links, canonicals, and the RSS feed alike. */
export function postPath(post: Post): string {
  return asset(
    post.data.draft ? `/blog/drafts/${post.id}` : `/blog/${post.id}`,
  );
}

/** Newest first — the order every listing wants. */
function byNewest(a: Post, b: Post): number {
  return b.data.pubDate.valueOf() - a.data.pubDate.valueOf();
}

/** Public posts, newest first. */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return posts.sort(byNewest);
}

/** Password-gated posts, newest first. */
export async function getDraftPosts(): Promise<Post[]> {
  const posts = await getCollection("blog", ({ data }) => data.draft);
  return posts.sort(byNewest);
}

/**
 * Is there anything to show behind a "Blog" nav link yet?
 *
 * The header only links the blog once a post is actually public — a nav item
 * leading to an empty page is worse than no nav item.
 */
export async function hasPublishedPosts(): Promise<boolean> {
  return (await getPublishedPosts()).length > 0;
}

/** "August 11, 2026" — spelled out, in UTC so the build doesn't shift a date
 *  by a day depending on where it runs. */
export function formatPostDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** `datetime` for <time>. */
export function isoDate(date: Date): string {
  return date.toISOString();
}

/** Rough read time, at 220 wpm — close enough to set expectations, which is
 *  all it is for. Minimum 1 so a short post never reads "0 min". */
export function readingMinutes(body: string | undefined): number {
  const words = (body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}
