/**
 * The public reimbursement page's same-origin JSON API + its one public read
 * query. Every /api/reimburse/* route the client script (in reimbursePage.ts)
 * calls, registered onto the main router by http.ts via
 * `registerReimburseApiRoutes`. Mirrors ticketApiRoutes.ts.
 *
 * NO auth on any of these — the chapter slug scopes the form and a request's
 * secret token scopes everything else (the same access model as the accountless
 * RSVP/ticket flow). Each route calls a public function in reimbursements.ts and
 * returns JSON; thrown ConvexErrors map to a 400.
 */
import type { HttpRouter } from "convex/server";
import { httpAction, query } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

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

/** Wrap a public JSON POST endpoint: parse body, run handler, return its result
 *  as JSON (or `{ ok: true }`), map a thrown ConvexError to a 400. */
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

/** Optional string field from an untrusted JSON body. */
function optStr(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

/** Coerce an untrusted line-items payload into the submit mutation's shape.
 *  Money is validated server-side; ids are verified to belong to the chapter. */
function toLines(raw: unknown): Array<{
  description: string;
  amountCents: number;
  categoryId?: Id<"budgetCategories">;
  fundId?: Id<"funds">;
  receiptStorageId?: Id<"_storage">;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const it = item as {
      description?: unknown;
      amountCents?: unknown;
      categoryId?: unknown;
      fundId?: unknown;
      receiptStorageId?: unknown;
    };
    return {
      description: String(it.description ?? ""),
      amountCents: Math.round(Number(it.amountCents)),
      categoryId: it.categoryId
        ? (it.categoryId as Id<"budgetCategories">)
        : undefined,
      fundId: it.fundId ? (it.fundId as Id<"funds">) : undefined,
      receiptStorageId: it.receiptStorageId
        ? (it.receiptStorageId as Id<"_storage">)
        : undefined,
    };
  });
}

export function registerReimburseApiRoutes(http: HttpRouter): void {
  // Chapter display data for the form (categories + fund each maps to).
  http.route({
    path: "/api/reimburse/chapter",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      const slug = url.searchParams.get("slug") ?? "";
      const chapter = await ctx.runQuery(
        api.lib.reimburseApiRoutes.chapterForReimburse,
        { slug },
      );
      if (!chapter) return json({ error: "Not found" }, 404);
      return json(chapter);
    }),
  });

  // Submit the request → { token, reference }.
  http.route({
    path: "/api/reimburse/submit",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug: String(body.chapterSlug ?? ""),
        payeeName: String(body.payeeName ?? ""),
        payeeEmail: optStr(body.payeeEmail),
        payeePhone: optStr(body.payeePhone),
        purpose: optStr(body.purpose),
        bankAccountLast4: optStr(body.bankAccountLast4),
        requestPreApproval: body.requestPreApproval === true,
        lines: toLines(body.lines),
      }),
    ),
  });

  // Accountless receipt-upload URL (token-scoped) → { uploadUrl }.
  http.route({
    path: "/api/reimburse/upload-url",
    method: "POST",
    handler: jsonPost(async (ctx, body) => {
      const uploadUrl = await ctx.runMutation(
        api.reimbursements.publicUploadUrl,
        { token: String(body.token ?? "") },
      );
      return { uploadUrl };
    }),
  });

  // Attach an uploaded receipt to one of the claimant's lines (token-scoped).
  http.route({
    path: "/api/reimburse/attach-receipt",
    method: "POST",
    handler: jsonPost((ctx, body) =>
      ctx.runMutation(api.reimbursements.attachPublicReceipt, {
        token: String(body.token ?? ""),
        lineId: String(body.lineId ?? "") as Id<"reimbursementLineItems">,
        receiptStorageId: String(
          body.receiptStorageId ?? "",
        ) as Id<"_storage">,
      }),
    ),
  });

  // Claimant status view (token-scoped) → getPublicReimbursement (or 404).
  http.route({
    path: "/api/reimburse/status",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      const token = url.searchParams.get("token") ?? "";
      const view = await ctx.runQuery(
        api.reimbursements.getPublicReimbursement,
        { token },
      );
      if (!view) return json({ error: "Not found" }, 404);
      return json(view);
    }),
  });

  // Line ids (token-scoped, order-sorted) so the client can attach receipts to
  // the right line — the documented status view omits ids by design.
  http.route({
    path: "/api/reimburse/lines",
    method: "GET",
    handler: httpAction(async (ctx, req) => {
      const url = new URL(req.url);
      const token = url.searchParams.get("token") ?? "";
      const lines = await ctx.runQuery(api.lib.reimburseApiRoutes.linesForToken, {
        token,
      });
      if (!lines) return json({ error: "Not found" }, 404);
      return json(lines);
    }),
  });
}

// ── Public read queries backing the page (registered as api functions) ────────

/**
 * Chapter display data for the public reimburse form, by slug. Public (no auth)
 * — only non-secret display fields + the chapter's active budget categories
 * (each carrying the fund it rolls up to, so the form can fill the fund in
 * automatically). Null when the slug is unknown.
 */
export const chapterForReimburse = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!chapter) return null;

    const funds = (
      await ctx.db
        .query("funds")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(200)
    )
      .filter((f) => f.isActive !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const fundNameById = new Map(funds.map((f) => [String(f._id), f.name]));

    const categories = (
      await ctx.db
        .query("budgetCategories")
        .withIndex("by_chapter", (q) => q.eq("chapterId", chapter._id))
        .take(500)
    )
      .filter((c) => c.isActive !== false)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    return {
      slug: chapter.slug ?? slug,
      name: chapter.name,
      categories: categories.map((c) => ({
        id: String(c._id),
        name: c.name,
        fundId: String(c.fundId),
        fundName: fundNameById.get(String(c.fundId)) ?? null,
      })),
    };
  },
});

/**
 * A request's line ids (order-sorted) for its token holder — lets the
 * accountless client attach receipts to a specific line. Token-scoped: returns
 * null for an unknown token, and never leaks anything but ids the token already
 * owns. Kept here (not reimbursements.ts) since it exists only for this page.
 */
export const linesForToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const req = await ctx.db
      .query("reimbursementRequests")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (!req) return null;
    const lines = await ctx.db
      .query("reimbursementLineItems")
      .withIndex("by_reimbursement", (q) => q.eq("reimbursementId", req._id))
      .take(200);
    lines.sort((a, b) => a.order - b.order);
    return lines.map((l) => ({
      lineId: String(l._id),
      order: l.order,
      description: l.description,
      hasReceipt: !!l.receiptStorageId,
    }));
  },
});
