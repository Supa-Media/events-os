/**
 * The public contractor page's same-origin JSON API. Every /api/contract/*
 * route the client script (in contractPage.ts) calls, registered onto the main
 * router by http.ts via `registerContractApiRoutes`. Mirrors
 * `reimburseApiRoutes.ts` — the same `jsonPost` wrapper, the same
 * ConvexError → 400 mapping, the same untrusted-JSON coercers, and the same
 * last-hop IP extraction — because these are the same kind of endpoint with the
 * same threat model.
 *
 * NO AUTH on any of these. The chapter slug scopes the blank request form and
 * a payment's secret token scopes the pre-filled agreement, exactly as the
 * accountless reimburse and RSVP flows work. Each route calls a public function
 * in `contractorPayments.ts`; a thrown ConvexError becomes a friendly 400.
 *
 * ── WHY THE SUBMIT ROUTES ORCHESTRATE ──────────────────────────────────────
 * Creating a payable contractor payment takes an ACTION and then a MUTATION,
 * and they must happen in that order:
 *
 *   1. `linkPublicBankAccount` (action) hands the routing/account digits to
 *      Increase once and returns `{ externalAccountId, last4 }`.
 *   2. `completeAgreement` / `submitPublicRequest` (mutations) write the row
 *      with that reference id.
 *
 * A mutation cannot do network I/O, so the two cannot be one function — which
 * means SOMEBODY has to sequence them, and it must not be the browser. If the
 * page called the action itself and then posted the `externalAccountId` it got
 * back, that id would be a client-supplied string the mutations trust, and
 * anyone could point a payment at any external account Increase holds. Doing it
 * here keeps the raw digits on one hop (in, to Increase, gone) and keeps the
 * external-account id server-side from end to end.
 *
 * And when the link FAILS, these routes 400 rather than proceeding. That is the
 * important half: `linkPublicBankAccount` returns `{ linked: false }` when
 * Increase is unconfigured or refuses, and a payment written without a
 * destination looks complete on the treasurer's queue and can never actually be
 * paid. Better a stranger sees "check those bank details" while they still have
 * the form open than a row that silently cannot pay them.
 */
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  CONTRACTOR_TAX_DOC_KINDS,
  type ContractorTaxDocKind,
  type ExternalAccountFunding,
} from "@events-os/shared";

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
 *  receives the raw `Request` — every route here uses it, to forward the
 *  caller's IP for the rate limiters in `contractorPayments.ts` (a Convex
 *  mutation cannot read a request header for itself). */
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

/** The caller's IP from standard proxy headers (Convex's `httpAction` `req` has
 *  no `.ip` of its own). `x-forwarded-for` is a comma-separated hop chain that
 *  proxies APPEND to, so the LAST entry is the address the platform's own edge
 *  proxy observed for its peer — the one entry the client cannot spoof. The
 *  FIRST entry is client-claimable: anyone can send their own
 *  `x-forwarded-for` with an arbitrary value prepended, and a rate limiter
 *  keyed on that is a rate limiter with a bypass. Falls back to `x-real-ip`;
 *  neither is guaranteed present, so callers treat this as best-effort.
 *  Character-for-character the same as `reimburseApiRoutes.ts`'s — if the hop
 *  reasoning ever changes, both move together. */
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

/** Optional millisecond timestamp from an untrusted JSON body. The date's
 *  SANITY (not more than a year out, not more than three years back) belongs to
 *  `assertServiceDate` server-side — only the SHAPE is settled here. */
function optMs(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * The tax-form kind, checked against the shared tuple rather than cast.
 *
 * An unrecognized value would otherwise fail deep inside Convex's arg
 * validation as an opaque 400, and "pick one of these three" is a fixable
 * answer where "invalid argument" is not. This is the same posture
 * `reimburseApiRoutes.ts#toCoding` takes with expense types.
 */
function toTaxDocKind(value: unknown): ContractorTaxDocKind {
  const kind = String(value ?? "");
  if (!CONTRACTOR_TAX_DOC_KINDS.includes(kind as ContractorTaxDocKind)) {
    throw new ConvexError({
      code: "INVALID_INPUT",
      message: "Pick which tax form you're filing — a W-9, a W-8BEN, or a W-8BEN-E.",
    });
  }
  return kind as ContractorTaxDocKind;
}

/**
 * The bank half of a submit, done ONCE and never trusted from the client.
 *
 * Returns the Increase reference id + display last-4 that the mutations take,
 * or throws the message a stranger can act on. See this module's doc for why
 * failing loudly here is the point rather than a nicety.
 */
async function linkBankOrThrow(
  ctx: ActionCtx,
  body: JsonBody,
  clientIp: string | undefined,
): Promise<{ externalAccountId: string; last4: string }> {
  const bank = await ctx.runAction(api.contractorPayments.linkPublicBankAccount, {
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
        "We couldn't verify those bank details. Please double check the routing and account numbers and try again.",
    });
  }
  return { externalAccountId: bank.externalAccountId, last4: bank.last4 ?? "" };
}

export function registerContractApiRoutes(http: HttpRouter): void {
  // Tax-document upload URL. ONE route, two scopes: a pre-filled agreement
  // sends its `token` (and the mutation refuses unless the link is still open
  // for changes), a blank request sends its `chapterSlug` (and the mutation
  // refuses unless the chapter is real). Both are rate-limited per IP with the
  // same `contract_upload_ip:` budget, so neither is an open upload endpoint
  // for the internet. The browser PUTs the file to the returned URL itself; the
  // resulting `storageId` only becomes a tax document when a submit route
  // accepts it, which is where content-type and size are actually checked
  // (`attachTaxDocument`).
  http.route({
    path: "/api/contract/upload-url",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const clientIp = clientIpFromRequest(req);
      const token = optStr(body.token);
      const uploadUrl = token
        ? await ctx.runMutation(api.contractorPayments.publicTaxDocUploadUrl, {
            token,
            clientIp,
          })
        : await ctx.runMutation(api.contractorPayments.publicRequestUploadUrl, {
            chapterSlug: String(body.chapterSlug ?? ""),
            clientIp,
          });
      return { uploadUrl };
    }),
  });

  // Stand-alone bank-details check → { linked, last4 }.
  //
  // DELIBERATELY DOES NOT RETURN `externalAccountId`. A caller that held one
  // could hand it to the submit routes as a destination, which is exactly the
  // trust this file's doc explains we don't extend to the browser — so the id
  // stays server-side even in the diagnostic path.
  //
  // The page does NOT call this before submitting, on purpose: a successful
  // pre-flight would mint an Increase External Account that the submit route
  // then mints again, littering the provider with duplicates for one payment.
  // It exists as the "are these digits even valid?" probe for support and for a
  // future verify-then-continue step, and it rides the separate
  // `contract_bank_ip:` rate-limit budget precisely so probing can't burn the
  // submit budget.
  http.route({
    path: "/api/contract/link-bank",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const bank = await ctx.runAction(
        api.contractorPayments.linkPublicBankAccount,
        {
          routingNumber: String(body.routingNumber ?? ""),
          accountNumber: String(body.accountNumber ?? ""),
          accountHolderName: optStr(body.accountHolderName),
          funding: optStr(body.funding) as ExternalAccountFunding | undefined,
          clientIp: clientIpFromRequest(req),
        },
      );
      return { linked: bank.linked === true, last4: bank.last4 };
    }),
  });

  // The contractor completes a PRE-FILLED agreement → { reference }.
  //
  // Note what is absent from the payload we forward: `serviceDescription`,
  // `agreedAmountCents`, `serviceDate`. `completeAgreement` has no parameters
  // for them — the terms are the org's testimony and are unrepresentable here,
  // so a crafted POST cannot edit what somebody is signing. This route does not
  // filter those keys out; there is nothing to filter them into.
  http.route({
    path: "/api/contract/complete",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const clientIp = clientIpFromRequest(req);
      const bank = await linkBankOrThrow(ctx, body, clientIp);
      return await ctx.runMutation(api.contractorPayments.completeAgreement, {
        token: String(body.token ?? ""),
        payeeName: String(body.payeeName ?? ""),
        payeeEmail: String(body.payeeEmail ?? ""),
        payeePhone: optStr(body.payeePhone),
        payeeBusinessName: optStr(body.payeeBusinessName),
        taxDocStorageId: String(body.taxDocStorageId ?? "") as Id<"_storage">,
        taxDocKind: toTaxDocKind(body.taxDocKind),
        taxDocFileName: optStr(body.taxDocFileName),
        // Never the raw digits — only the Increase reference id and a display
        // last-4 land in Convex.
        externalAccountId: bank.externalAccountId,
        bankAccountLast4: bank.last4,
        signature: String(body.signature ?? ""),
        // Forwarded so the mutation can rate-limit per IP and stamp
        // `acceptedIp` on the signature.
        clientIp,
      });
    }),
  });

  // A BLANK self-serve request → { reference, token }. The token comes back so
  // the page can redirect the requester to their own status link; it is the
  // only place this token is ever handed out, and it goes to the person who
  // just created the row.
  //
  // The requester's own account of what the money is for rides in
  // `agreementNotes`, NOT in the coding fields: `submitPublicRequest` lands the
  // row UNCODED and `approve` refuses until a human has said which budget it
  // belongs to. A stranger's claim is a starting point for that conversation,
  // not evidence — which is also why this route offers no way to send one.
  http.route({
    path: "/api/contract/request",
    method: "POST",
    handler: jsonPost(async (ctx, body, req) => {
      const clientIp = clientIpFromRequest(req);
      const bank = await linkBankOrThrow(ctx, body, clientIp);
      return await ctx.runMutation(api.contractorPayments.submitPublicRequest, {
        chapterSlug: String(body.chapterSlug ?? ""),
        payeeName: String(body.payeeName ?? ""),
        payeeEmail: String(body.payeeEmail ?? ""),
        payeePhone: optStr(body.payeePhone),
        payeeBusinessName: optStr(body.payeeBusinessName),
        // Published verbatim. Coerced only for shape here — the shared
        // `publicTextProblems` + length cap are enforced by
        // `assertPublicDescription` inside the mutation, which is the same
        // check the page shows inline. The page is not the guard.
        serviceDescription: String(body.serviceDescription ?? ""),
        serviceDate: optMs(body.serviceDate),
        // Dollars became integer cents in the browser; rounded again here so a
        // hand-rolled POST can't smuggle a fractional cent past
        // `contractorAmountProblems`, which requires an integer.
        requestedAmountCents: Math.round(Number(body.requestedAmountCents)),
        agreementNotes: optStr(body.agreementNotes),
        taxDocStorageId: String(body.taxDocStorageId ?? "") as Id<"_storage">,
        taxDocKind: toTaxDocKind(body.taxDocKind),
        taxDocFileName: optStr(body.taxDocFileName),
        externalAccountId: bank.externalAccountId,
        bankAccountLast4: bank.last4,
        signature: String(body.signature ?? ""),
        clientIp,
      });
    }),
  });
}
