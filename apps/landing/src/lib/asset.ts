// Prepend Astro's configured base path to a public-asset URL.
//
// Astro's `base` config rewrites <a href> internally but does NOT
// auto-prefix <img src>, <link href>, or other static asset URLs.
// Use this helper for every reference to a file under /public so
// the site works both at the root (custom domain) and under a
// project-pages subpath like /public-worship/.

export function asset(path: string): string {
  if (!path.startsWith("/")) return path;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${path}`;
}
