/**
 * Does Stripe actually SEND us the events `http.ts` knows how to handle?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The `/stripe/webhook` fan-out in `http.ts` grew a branch per event type as
 * features landed — `invoice.paid` for a backer's billing cycle,
 * `customer.subscription.*` for pledge lifecycle, `payout.*` for the
 * reconciliation fast-path, `financial_connections.*` for the bank sync. But
 * an endpoint only receives the events someone ticked in the Stripe dashboard,
 * and NOTHING in this codebase ever compared the two lists. For a stretch the
 * production endpoint had only `checkout.session.completed` and
 * `checkout.session.expired` enabled, so six handler branches were dead code
 * that looked alive.
 *
 * The audit that found it (2026-08-09) established the loss was $0 — the
 * recurring-giving path had never been exercised: zero subscriptions ever
 * created on the account, zero subscription-mode Checkout sessions, zero
 * invoices attached to a subscription, and zero `gifts` carrying a
 * `stripeInvoiceId`. We got lucky. The `payout.*` gap was real but harmless
 * for the same reason the fan-out comment predicts: the daily reconciliation
 * cron is its backstop.
 *
 * Luck is not a control. The failure mode is silent by construction — a
 * handler that is never invoked raises no error, logs no warning, and passes
 * every test, because the tests call the handler directly. Only a comparison
 * against the LIVE endpoint config can see it.
 *
 * ── WHY A LIST RATHER THAN INTROSPECTION ────────────────────────────────────
 * Convex can't read its own source at runtime, and parsing `http.ts` to derive
 * the handled set would be a build step in service of eight strings. So the
 * set is written out by hand below — and `tests/stripeWebhookCoverage.test.ts`
 * parses `http.ts` and fails if the two ever disagree. The list can't rot
 * without CI saying so, which is the only property that mattered.
 *
 * This deliberately does NOT touch the fan-out in `http.ts`. Adding a branch
 * there means adding one string here; the test names the file and the string
 * when you forget.
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const STRIPE_API = "https://api.stripe.com/v1";

/** The path `http.ts` serves the Stripe fan-out on. */
const WEBHOOK_PATH = "/stripe/webhook";

/**
 * Every event type the `/stripe/webhook` fan-out acts on.
 *
 * An entry ending in `.` is a PREFIX branch (`event.type.startsWith(...)` in
 * `http.ts`) and is satisfied by any enabled event under it. Everything else
 * is an exact match. Keep in sync with `http.ts` — the test enforces it.
 *
 * The three concrete entries UNDER a prefix are deliberate. A prefix branch
 * accepts anything in its namespace, so `payout.created` alone would satisfy
 * `payout.` while the thing the branch actually exists for could still never
 * fire — the same "subscribed to the wrong subset" gap as the incident, one
 * level down. So the events the handlers genuinely depend on are named:
 *   - `payout.paid` — http.ts's own comment: "the one that matters" for the
 *     reconciliation fast-path (created/updated/failed only refresh status).
 *   - `financial_connections.account.refreshed_transactions` — the event that
 *     drives the FC transaction sync (`stripeFinance.ts`).
 *   - `financial_connections.account.disconnected` — its own explicit branch
 *     in `stripeFinance.ts#onFcWebhookEvent`.
 */
export const HANDLED_STRIPE_EVENTS: readonly string[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "payout.",
  "payout.paid",
  "financial_connections.",
  "financial_connections.account.refreshed_transactions",
  "financial_connections.account.disconnected",
];

/**
 * Is a handled event type covered by an endpoint's `enabled_events`?
 *
 * Stripe's `enabled_events` holds exact event names or the single wildcard
 * `"*"` — it has no `payout.*` form — so a prefix branch is covered when ANY
 * enabled event sits under that prefix. Exported for the test.
 */
export function isCovered(
  handled: string,
  enabledEvents: readonly string[],
): boolean {
  if (enabledEvents.includes("*")) return true;
  return handled.endsWith(".")
    ? enabledEvents.some((e) => e.startsWith(handled))
    : enabledEvents.includes(handled);
}

/**
 * Compare the handled set against what our live Stripe endpoint(s) are
 * subscribed to, and log LOUDLY about any handler that can never fire.
 *
 * Runs daily on the cron and is safe to run by hand
 * (`npx convex run stripeWebhookCoverage:checkCoverage`). Read-only — it only
 * ever GETs `/v1/webhook_endpoints`.
 *
 * Union across every ENABLED endpoint pointing at our path, because coverage
 * can legitimately be split across two endpoints; a disabled endpoint delivers
 * nothing and is ignored. No endpoint at all is itself the loudest finding —
 * that's every branch dead, not just some.
 *
 * NOTE ON HISTORY: this reports what Stripe is subscribed to NOW. Stripe keeps
 * no audit of past `enabled_events`, so a clean result says nothing about
 * whether an event was being delivered last month.
 */
export const checkCoverage = internalAction({
  args: {},
  returns: v.object({
    configured: v.boolean(),
    // True when we could not actually ask Stripe. Without this, a failed
    // lookup returns `missing: []`, which reads identically to a clean bill
    // of health — the exact "silence means fine" confusion this module exists
    // to remove.
    checkFailed: v.boolean(),
    endpointsFound: v.number(),
    missing: v.array(v.string()),
    covered: v.array(v.string()),
  }),
  handler: async () => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      // Local/dev without payments wired — not a finding.
      return {
        configured: false,
        checkFailed: false,
        endpointsFound: 0,
        missing: [],
        covered: [],
      };
    }

    const response = await fetch(`${STRIPE_API}/webhook_endpoints?limit=100`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!response.ok) {
      console.error(
        "[stripe-coverage] could not list webhook endpoints:",
        await response.text(),
      );
      return {
        configured: true,
        checkFailed: true,
        endpointsFound: 0,
        missing: [],
        covered: [],
      };
    }
    const body = (await response.json()) as {
      data?: Array<{
        id: string;
        url?: string;
        status?: string;
        enabled_events?: string[];
      }>;
    };

    const ours = (body.data ?? []).filter(
      (e) => e.status === "enabled" && (e.url ?? "").endsWith(WEBHOOK_PATH),
    );
    const enabledEvents = ours.flatMap((e) => e.enabled_events ?? []);

    const missing = HANDLED_STRIPE_EVENTS.filter(
      (t) => !isCovered(t, enabledEvents),
    );
    const covered = HANDLED_STRIPE_EVENTS.filter((t) =>
      isCovered(t, enabledEvents),
    );

    if (ours.length === 0) {
      console.error(
        `[stripe-coverage] NO enabled Stripe webhook endpoint points at ${WEBHOOK_PATH} — ` +
          `every handler in http.ts is dead. Add one in the Stripe dashboard.`,
      );
    } else if (missing.length > 0) {
      console.error(
        `[stripe-coverage] http.ts handles ${missing.length} Stripe event type(s) that no ` +
          `enabled endpoint is subscribed to, so they can never fire: ${missing.join(", ")}. ` +
          `Enable them on the endpoint in the Stripe dashboard, or delete the handler.`,
      );
    }

    return {
      configured: true,
      checkFailed: false,
      endpointsFound: ours.length,
      missing,
      covered,
    };
  },
});
