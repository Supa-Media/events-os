import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://publicworship.life",
  base: "/",
  trailingSlash: "ignore",
  redirects: {
    // /careers shipped for a few hours before the name changed. We are 100%
    // volunteer-run, so "careers" was the wrong word for it — the page is
    // about joining the team, and it lives at /team now. Kept as a redirect
    // because a link that was shared once is shared forever.
    "/careers": "/team",
    // Role pages used to live at /team/<slug> (statically generated from a
    // markdown collection); listings now come live from the OS and render at
    // /team/role?slug=<slug>. people-director is the one slug that was ever
    // public, so the two old URLs that carried it get a concrete redirect.
    // (No dynamic `[slug]` pattern anymore — there's no static route to
    // enumerate paths from, and new roles were only ever born at the new URL.)
    "/careers/people-director": "/team/role?slug=people-director",
    "/team/people-director": "/team/role?slug=people-director",
    "/about": "/#about",
    "/impact": "/#impact",
    "/links": "/#links",
    "/faq": "/#faq",
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
    // No filter: the only pages this build produces are public ones. It used
    // to exclude /blog/drafts/*, the password-gated unpublished posts, which
    // no longer exist — a draft is a Convex row shared with a per-post preview
    // token now. NOTE that this sitemap covers the STATIC pages only: /blog,
    // /blog/<slug>, /give and /finances are served by Convex and no build step
    // here knows they exist. The blog publishes its own at /blog/sitemap.xml
    // (apps/convex/lib/blogPage.ts), named in public/robots.txt.
    sitemap(),
  ],
});
