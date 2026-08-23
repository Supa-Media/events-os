/**
 * The two ways a person joins, as same-origin JSON APIs:
 *
 *   POST /api/team/apply        `/team/apply`'s application form
 *                               (`apps/landing/src/scripts/team-apply.ts`) →
 *                               `hiring.submitApplication`.
 *   POST /api/volunteer/signup  `/serve`'s signup form
 *                               (`apps/landing/src/scripts/volunteer-signup.ts`)
 *                               → `volunteers.submitSignup`.
 *
 * Two endpoints because they are two pipelines — a seat on the chart and a
 * pair of hands at a gathering (see `@events-os/shared`'s `volunteers.ts`).
 * Both mirror `giveApiRoutes.ts` exactly: same `jsonPost` wrapper, same
 * "coerce the body, call the real mutation, let its `ConvexError` become the
 * user's message" flow. Registered onto the main router by `http.ts` via
 * `registerJoinApiRoutes`.
 *
 * On `publicworship.life` this is reachable because pw-router already proxies
 * everything under `/api/` to Convex (`infra/router/src/route.ts`) — no router
 * change was needed to ship this endpoint, and none should be needed for the
 * next one under the same prefix.
 *
 * ONE-WAY. There is deliberately no GET here. Published roles are content in
 * the landing repo (built into the page), and an application is never readable
 * over the public surface — see `schema/hiring.ts`'s PII note.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Map a thrown ConvexError to its friendly message (generic fallback). */
function errorJson(err: unknown): Response {
  const message =
    (err as { data?: { message?: string } })?.data?.message ??
    "Something went wrong. Please try again.";
  return json({ error: message }, 400);
}

type JsonBody = Record<string, unknown>;

/** Wrap a public JSON POST endpoint (identical shape to `giveApiRoutes.ts`'s
 *  `jsonPost` — kept local rather than shared so neither file depends on the
 *  other's internals). */
function jsonPost(run: (ctx: ActionCtx, body: JsonBody) => Promise<unknown>) {
  return httpAction(async (ctx, req) => {
    try {
      const body = (await req.json()) as JsonBody;
      return json((await run(ctx, body)) ?? { ok: true });
    } catch (err) {
      return errorJson(err);
    }
  });
}

export function registerJoinApiRoutes(http: HttpRouter): void {
  // `/api/careers/apply` is the ORIGINAL path, kept alive alongside the
  // renamed one for exactly one reason: a browser holding the old page in
  // cache would otherwise post an application into a 404 and tell the
  // candidate to try again. Pages redirect; a POST from a cached page can't.
  for (const path of ["/api/team/apply", "/api/careers/apply"]) {
    http.route({
      path,
      method: "POST",
      handler: jsonPost(async (ctx, body) => {
        // Honeypot: a field styled off-screen that a human never sees and a
        // naive bot always fills. Answer 200 rather than an error — a bot told
        // it failed tries again with the field blank, and the candidate-facing
        // form has no way to trip this.
        const honeypot = String(body.website ?? "").trim();
        if (honeypot) return { ok: true };

        const answers: Record<string, string> = {};
        const rawAnswers = body.answers;
        if (rawAnswers && typeof rawAnswers === "object") {
          for (const [key, value] of Object.entries(
            rawAnswers as Record<string, unknown>,
          )) {
            answers[key] = String(value ?? "");
          }
        }
        const links = Array.isArray(body.links)
          ? body.links.map((l) => String(l ?? "").trim()).filter(Boolean)
          : [];

        const roleSlug = String(body.roleSlug ?? "").trim();
        const roleTitle = String(body.roleTitle ?? "").trim();
        const phone = String(body.phone ?? "").trim();
        const location = String(body.location ?? "").trim();
        const referredBy = String(body.referredBy ?? "").trim();

        await ctx.runMutation(api.hiring.submitApplication, {
          ...(roleSlug ? { roleSlug } : {}),
          ...(roleTitle ? { roleTitle } : {}),
          name: String(body.name ?? ""),
          email: String(body.email ?? ""),
          ...(phone ? { phone } : {}),
          ...(location ? { location } : {}),
          ...(links.length ? { links } : {}),
          ...(referredBy ? { referredBy } : {}),
          answers,
        });
        return { ok: true };
      }),
    });
  }

  // The volunteer hand-raise. Asks for almost nothing; validation and caps
  // live in `volunteers.submitSignup`.
  http.route({
    path: "/api/volunteer/signup",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const honeypot = String(body.website ?? "").trim();
      if (honeypot) return { ok: true };

      const areas = Array.isArray(body.areas)
        ? body.areas.map((a) => String(a ?? "").trim()).filter(Boolean)
        : [];
      const phone = String(body.phone ?? "").trim();
      const location = String(body.location ?? "").trim();
      const availability = String(body.availability ?? "").trim();
      const message = String(body.message ?? "").trim();

      await ctx.runMutation(api.volunteers.submitSignup, {
        name: String(body.name ?? ""),
        email: String(body.email ?? ""),
        areas,
        ...(phone ? { phone } : {}),
        ...(location ? { location } : {}),
        ...(availability ? { availability } : {}),
        ...(message ? { message } : {}),
      });
      return { ok: true };
    }),
  });
}
