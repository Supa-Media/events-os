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
    "/careers/[slug]": "/team/[slug]",
    "/about": "/#about",
    "/impact": "/#impact",
    "/links": "/#links",
    "/faq": "/#faq",
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
    sitemap({
      // Unpublished posts build to /blog/drafts/* so pw-router can hold them
      // behind a password (infra/router/src/draftGate.ts). Handing their URLs
      // to search engines in the sitemap would defeat the point of gating
      // them — the gate would hold, but the URL would be public knowledge.
      filter: (page) => !page.includes("/blog/drafts"),
    }),
  ],
});
