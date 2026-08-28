/**
 * The routes `http.ts` actually registers.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * A `register*ApiRoutes(http)` helper that is defined, exported, imported by
 * nobody, and therefore never called is invisible to every other check in this
 * repo: it typechecks, it lints, its own module's unit tests pass, and the
 * router's drift test only scrapes `http.ts` for route LITERALS — which a
 * `lib/` module's routes are not.
 *
 * That is not hypothetical. `registerBlogPageRoutes` shipped into review
 * unwired: `lib/blogPage.ts` was complete and tested, pw-router had already
 * been changed to proxy `/blog` and `/blog/*` to Convex, and the Astro blog
 * pages plus `content/blog/doxology.md` were deleted in the same change. One
 * missing line would have taken the entire blog — including a live, shared
 * post — off the internet on deploy, and nothing would have failed.
 *
 * So this asserts the wiring itself, through `HttpRouter#lookup`, which
 * answers the real question ("would a request for this path find a handler?")
 * rather than "does this string appear in that file". Add a case here whenever
 * a public path is one whose disappearance would be a visible outage.
 */
import { describe, expect, test } from "vitest";
import {
  BLOG_FEED_PATH,
  BLOG_INDEX_PATH,
  BLOG_SITEMAP_PATH,
  blogPostPath,
} from "@events-os/shared";
import http from "../http";

/** Every path below must resolve to SOME handler for GET. `lookup` returns
 *  `[handler, method, matchedRoute]`, or null when nothing claims the path. */
function resolves(path: string): boolean {
  return http.lookup(path, "GET") !== null;
}

describe("public routes are actually registered", () => {
  test("the blog serves its index, a post, the feed, and the sitemap", () => {
    // Paths come from the shared contract rather than being retyped, so a
    // rename moves the test with the thing it guards.
    expect(resolves(BLOG_INDEX_PATH)).toBe(true);
    expect(resolves(blogPostPath("doxology"))).toBe(true);
    expect(resolves(BLOG_FEED_PATH)).toBe(true);
    expect(resolves(BLOG_SITEMAP_PATH)).toBe(true);
  });

  test("the marketing desk's public feeds resolve", () => {
    // The homepage reads this on every visit; an unwired route here is a
    // homepage that silently falls back to its build-time content forever.
    expect(resolves("/api/site/home")).toBe(true);
    expect(resolves("/api/site/link-image/abc/thumb")).toBe(true);
  });

  test("the surfaces the blog move touched still resolve", () => {
    // Regression guard for the migration itself: these were live before the
    // blog moved and must not have been collateral.
    expect(resolves("/api/team/roles")).toBe(true);
    expect(resolves("/api/events/upcoming")).toBe(true);
    expect(resolves("/give")).toBe(true);
    expect(resolves("/rsvp/anything")).toBe(true);
  });

  test("POST-only public intakes resolve for POST and not for GET", () => {
    // `/api/subscribe` is deliberately write-only — a GET must find nothing,
    // because a readable mailing-list endpoint is the one thing that endpoint
    // must never become.
    expect(http.lookup("/api/subscribe", "POST")).not.toBeNull();
    expect(http.lookup("/api/subscribe", "GET")).toBeNull();
  });
});
