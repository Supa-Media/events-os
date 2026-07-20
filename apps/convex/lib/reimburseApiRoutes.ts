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
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ExternalAccountFunding } from "@events-os/shared";

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
 *  as JSON (or `{ ok: true }`), map a thrown ConvexError to a 400. `run` also
 *  receives the raw `Request` (most routes ignore it) — the `submit` route
 *  uses it to forward the caller's IP for rate-limiting, which a Convex
 *  mutation can't read for itself. */
function jsonPost(
  run: (ctx: ActionCtx, body: JsonBody, req: Request) => Promise<unknown>,
) {
  return httpAction(async (ctx, req) => {
    try {
      const body = (await req.json()) as JsonBody;
      return json((await run(ctx, body, req)) ?? { ok: true });
    } catch (err) {
      return errorJson(err);
    }
  });
}

/** The caller's IP from standard proxy headers (Convex's `httpAction` `req`
 *  has no `.ip` of its own). `x-forwarded-for` is a comma-separated hop chain
 *  that proxies APPEND to as a request passes through them, so the LAST entry
 *  is the address the platform's own edge proxy observed for its peer — the
 *  one entry the client cannot spoof. The FIRST entry (and everything before
 *  the last hop) is client-claimable: a client can send its own
 *  `x-forwarded-for` header with an arbitrary value prepended. Falls back to
 *  `x-real-ip`. Neither is guaranteed present (e.g. a direct, non-proxied
 *  request in a test), so the caller must treat this as best-effort. */
function clientIpFromRequest(req: Request): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (last) return last;
  const real = req.headers.get("x-real-ip")?.trim();
  return real || undefined;
}

/** Optional string field from an untrusted JSON body. */
function optStr(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

/** Coerce an untrusted line-items payload into the submit mutation's shape.
 *  Money + `transactionDate` are sanity-checked server-side; the receipt id is
 *  verified to belong to the chapter's storage. NO `categoryId`/`fundId` here
 *  on purpose — the public form no longer collects either (categorization is
 *  a finance manager's review-time job); `submitPublicReimbursement`
 *  additionally strips those fields server-side even if a raw API call tries
 *  to smuggle them through. */
function toLines(raw: unknown): Array<{
  description: string;
  amountCents: number;
  receiptStorageId?: Id<"_storage">;
  transactionDate?: number;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const it = item as {
      description?: unknown;
      amountCents?: unknown;
      receiptStorageId?: unknown;
      transactionDate?: unknown;
    };
    return {
      description: String(it.description ?? ""),
      amountCents: Math.round(Number(it.amountCents)),
      receiptStorageId: it.receiptStorageId
        ? (it.receiptStorageId as Id<"_storage">)
        : undefined,
      transactionDate:
        it.transactionDate != null && it.transactionDate !== ""
          ? Math.round(Number(it.transactionDate))
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

  // Submit the request → { token, reference }. ORCHESTRATES the two steps a
  // NEW reimbursement now requires: `linkPublicBankAccount` (an action, no
  // token — the request doesn't exist yet) creates the real Increase
  // External Account from the posted routing/account/type FIRST, THEN
  // `submitPublicReimbursement` (a mutation) writes the request with the
  // resulting `externalAccountId`. No request can be created without a full
  // ACH destination (owner mandate) — a failed/unconfigured bank link
  // surfaces as a 400 before anything is written.
  http.route({
    path: "/api/reimburse/submit",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const clientIp = clientIpFromRequest(req);
      const bank = await ctx.runAction(api.reimbursements.linkPublicBankAccount, {
        routingNumber: String(body.routingNumber ?? ""),
        accountNumber: String(body.accountNumber ?? ""),
        accountHolderName: optStr(body.accountHolderName),
        funding: optStr(body.funding) as ExternalAccountFunding | undefined,
        clientIp,
      });
      if (!bank.linked || !bank.externalAccountId) {
        throw new ConvexError({
          code: "BANK_LINK_FAILED",
          message:
            "We couldn't verify those bank details. Please double check them and try again.",
        });
      }
      return await ctx.runMutation(api.reimbursements.submitPublicReimbursement, {
        chapterSlug: String(body.chapterSlug ?? ""),
        payeeName: String(body.payeeName ?? ""),
        // Required now (SoD + reminder contact) — the mutation rejects a blank.
        payeeEmail: String(body.payeeEmail ?? ""),
        payeePhone: optStr(body.payeePhone),
        // Required (the "why") — the mutation rejects a blank.
        purpose: String(body.purpose ?? ""),
        requestPreApproval: body.requestPreApproval === true,
        lines: toLines(body.lines),
        // Never the raw routing/account numbers — only the Increase
        // reference id + a display last-4 land in Convex.
        externalAccountId: bank.externalAccountId,
        bankAccountLast4: bank.last4,
        // Forwarded so the mutation can rate-limit per IP (see reimbursements.ts).
        clientIp,
      });
    }),
  });

  // Pre-submit receipt-upload URL — no token (the request doesn't exist yet),
  // scoped by chapter slug + rate-limited per IP. The client uploads each
  // line's receipt HERE before calling /api/reimburse/submit, then includes
  // the returned storageId as that line's `receiptStorageId`.
  http.route({
    path: "/api/reimburse/pre-upload-url",
    method: "POST",
    handler: jsonPost((ctx, body, req) =>
      ctx.runMutation(api.reimbursements.preSubmitUploadUrl, {
        chapterSlug: String(body.chapterSlug ?? ""),
        clientIp: clientIpFromRequest(req),
      }).then((uploadUrl) => ({ uploadUrl })),
    ),
  });

  // Accountless receipt-upload URL (token-scoped) → { uploadUrl }. Kept for
  // REPLACING a receipt on an already-editable, already-submitted request
  // (the initial submission's receipts now go through pre-upload-url above).
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
 * — ONLY non-secret display fields: the chapter's name + its own slug. NO
 * funds or budget categories here (owner mandate, public-page privacy): a
 * logged-out visitor never sees the chapter's internal fund/category
 * structure — categorizing a line is a finance manager's review-time job,
 * done in their own tooling after the request lands. Null when the slug is
 * unknown.
 */
export const chapterForReimburse = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const chapter = await ctx.db
      .query("chapters")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!chapter) return null;

    return {
      slug: chapter.slug ?? slug,
      name: chapter.name,
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
