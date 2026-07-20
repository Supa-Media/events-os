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
  integrations: [tailwind({ applyBaseStyles: false }), sitemap()],
});
