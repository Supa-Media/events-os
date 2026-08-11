import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://publicworship.life",
  base: "/",
  trailingSlash: "ignore",
  redirects: {
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
