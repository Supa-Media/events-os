/**
 * Convex JWT-issuer config, required by `@convex-dev/auth` (wired here via
 * `@supa-media/convex`'s `createSupaAuth` in `auth.ts`) to verify the
 * identity tokens this deployment issues to signed-in users.
 *
 * Without this file, `ctx.auth.getUserIdentity()` always returns `null` —
 * per `apps/convex/_generated/ai/guidelines.md` — which means every
 * `requireAccess`/`getUserEmail` call in `lib/access.ts` would treat every
 * caller as signed out.
 *
 * `domain` is `process.env.CONVEX_SITE_URL` rather than a hardcoded URL
 * because this is self-issued JWT auth: the deployment is its own issuer,
 * and that URL differs between local dev, preview deployments, and prod
 * (`vivid-rhinoceros-688`).
 */
export default {
  providers: [
    {
      // The local/cloud Convex deployment's site URL is the JWT issuer.
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
