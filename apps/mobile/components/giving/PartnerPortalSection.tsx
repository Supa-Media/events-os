/**
 * GIVING · The partnership composer — the staff half of the partner portal.
 *
 * One agreement's own proposal (title, amount, free-form body, what they
 * receive, what we deliver, terms), the in-kind credit lines that offset it,
 * which payment rails its portal offers, the secret link that opens it, and
 * whatever came back: their view stamps, their signature, their payments.
 *
 * ── WHY THIS IS ONE SCREEN AND NOT A WIZARD ────────────────────────────────
 * A development director composing a partnership is doing ONE thing — writing
 * down a deal they already agreed in a room — and every field is optional
 * because most agreements start as "the tier's copy, at the tier's price" and
 * diverge one field at a time. A wizard would make somebody walk six steps to
 * change an amount. So: one form, one Save, and the fields that matter most at
 * the top.
 *
 * ── WHAT THIS SCREEN HAS TO SAY OUT LOUD ───────────────────────────────────
 * Three facts a composer would otherwise learn by surprise:
 *
 *  1. SAVING A SIGNED TERM UN-SIGNS IT. Editing the amount, terms, benefits,
 *     commitments, summary or title bumps the agreement's version and clears
 *     the partner's signature — because holding a signature against terms
 *     nobody agreed to is worse than asking for a second one. The form warns
 *     BEFORE the save (a live banner the moment a signed field is touched) and
 *     confirms after.
 *  2. THE LINK IS STABLE. "Copy link" is idempotent; the URL a manager pasted
 *     into an email five minutes ago keeps working. Revoking is the one act
 *     that kills it, and it is deliberately the least prominent control here.
 *  3. THE RAIL IS A MONEY DECISION. Card is shown with what it would actually
 *     cost this agreement, and disappears entirely above the ceiling. A manager
 *     ticking it is choosing to spend ~3% for four days of clearing time; the
 *     screen makes that a number, not a preference.
 *
 * Everything gates on `portalAdmin` / the `sponsorPortal` mutations, which own
 * their own permission checks (`lib/sponsorAccess.ts`) — this component renders
 * what it is handed and never decides authority for itself.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CARD_RAIL_MAX_CENTS,
  MAX_SPONSORSHIP_EVENTS,
  SPONSOR_PORTAL_STATE_LABELS,
  SPONSOR_RAIL_LABELS,
  cardRailBlockedReason,
  isAcceptedSponsorDocType,
  sponsorDocKind,
  formatCents,
  type SponsorPaymentRail,
  type SponsorPortalState,
} from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  CheckboxRow,
  CopyButton,
  ProgressBar,
  SectionHeader,
  TextField,
} from "../ui";
import type { BadgeTone } from "../ui";
import { useGivingScope } from "../../lib/useGivingScope";

const STATE_TONE: Record<SponsorPortalState, BadgeTone> = {
  unissued: "neutral",
  awaiting_signature: "warn",
  awaiting_payment: "info",
  payment_clearing: "info",
  settled: "success",
};

/** Dollars ↔ cents at the form boundary, in one place so a stray `* 100`
 *  can't appear twice with different rounding. */
function centsFromDollars(input: string): number | null {
  const n = Number.parseFloat(input.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
function dollarsFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** One credit line as the form holds it — amount stays a STRING while being
 *  typed, so "25" on the way to "2500" isn't repeatedly re-rounded under the
 *  cursor. */
type CreditDraft = { label: string; amount: string; note: string };

export function PartnerPortalSection({
  sponsorshipId,
}: {
  sponsorshipId: Id<"sponsorships">;
}) {
  const data = useQuery(api.sponsorPortal.portalAdmin, { sponsorshipId });
  const saveProposal = useMutation(api.sponsorPortal.saveProposal);
  const issueLink = useMutation(api.sponsorPortal.issuePortalLink);
  const revokeLink = useMutation(api.sponsorPortal.revokePortalLink);
  const sendInvite = useMutation(api.sponsorPortal.sendPortalInvite);

  // ── Form state, seeded from the server and re-seeded when the row changes
  //    underneath us (another manager saved, or a payment landed).
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [summary, setSummary] = useState("");
  const [benefits, setBenefits] = useState("");
  const [commitments, setCommitments] = useState("");
  const [terms, setTerms] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactTitle, setContactTitle] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [rails, setRails] = useState<SponsorPaymentRail[]>(["ach"]);
  const [credits, setCredits] = useState<CreditDraft[]>([]);
  const [eventIds, setEventIds] = useState<Id<"events">[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!data || seeded) return;
    setTitle(data.proposal.title);
    setAmount(dollarsFromCents(data.proposal.amountCents));
    setSummary(data.proposal.summary ?? "");
    setBenefits(data.proposal.benefits.join("\n"));
    setCommitments(data.proposal.commitments.join("\n"));
    setTerms(data.proposal.terms ?? "");
    setContactName(data.contact.name ?? "");
    setContactTitle(data.contact.title ?? "");
    setContactEmail(data.contact.email ?? "");
    setRails(data.proposal.rails);
    setEventIds(data.events.map((e) => e._id));
    setCredits(
      data.proposal.inKindCredits.map((c) => ({
        label: c.label,
        amount: dollarsFromCents(c.amountCents),
        note: c.note ?? "",
      })),
    );
    setSeeded(true);
  }, [data, seeded]);

  const amountCents = centsFromDollars(amount);

  /**
   * Would saving right now invalidate the partner's signature?
   *
   * Computed from the SAME field list the server bumps on, so the warning and
   * the behaviour can't disagree. Shown live rather than as a save-time
   * confirm: somebody who is about to retype a terms paragraph should know
   * before they start, not after they press the button.
   */
  const willClearSignature = useMemo(() => {
    if (!data?.signature) return false;
    const p = data.proposal;
    // Same six comparisons `save()` uses to decide what to send. Kept in step
    // by hand rather than shared, because the payload needs the values and
    // this needs only the verdict — but if one moves, move both.
    return (
      title.trim() !== p.title ||
      (amountCents ?? p.amountCents) !== p.amountCents ||
      summary.trim() !== (p.summary ?? "") ||
      benefits.trim() !== p.benefits.join("\n") ||
      commitments.trim() !== p.commitments.join("\n") ||
      terms.trim() !== (p.terms ?? "") ||
      // Which events this covers is a SIGNED term (see `saveProposal`'s
      // SIGNED_FIELDS): "Ignite is standing behind Love Thy Neighbor and the
      // Sept 18 gathering" is the substance of the deal, not metadata about it.
      // Order-insensitive, because reordering a checkbox list is not a change
      // to what anybody agreed to.
      !sameIds(eventIds, data.events.map((e) => e._id))
    );
  }, [data, title, amountCents, summary, benefits, commitments, terms, eventIds]);

  if (data === undefined) return null;

  // AUTHORITY COMES FROM THE AGREEMENT, NOT THE GIVING-WIDE MANAGE FLAG. The
  // partnership team (a Partnership/Fundraising Associate) holds
  // `giving.partners.edit` — they compose and issue links WITHOUT the donor-CRM
  // manage power — so these are resolved server-side in `portalAdmin` and the
  // controls gate on them, not on whether the caller can record a gift.
  const canCompose = data.canCompose;
  const canSend = data.canSend;

  const cardBlocked = cardRailBlockedReason(amountCents ?? data.proposal.amountCents);

  async function save() {
    setError(null);
    setNotice(null);
    if (amountCents == null) {
      setError("Enter a partnership amount greater than zero.");
      return;
    }
    setSaving(true);
    try {
      const p = data!.proposal;
      // ── ONLY SEND WHAT CHANGED ───────────────────────────────────────────
      // Every signed field is omitted unless the manager actually altered it,
      // and that is load-bearing rather than tidy. The form SEEDS from the
      // resolved proposal, which falls back to the package tier — so a form
      // that posted everything would write the tier's title onto an agreement
      // that had been happily inheriting it, register that as a changed term,
      // and clear the partner's signature. Somebody correcting a contact email
      // would have un-signed a $3,500 agreement without touching a term.
      //
      // The comparisons here are the same ones `willClearSignature` renders,
      // so the warning the manager reads and the payload the server receives
      // can never disagree.
      const result = await saveProposal({
        sponsorshipId,
        ...(title.trim() !== p.title ? { title: title.trim() } : {}),
        ...(amountCents !== p.amountCents ? { amountCents } : {}),
        ...(summary.trim() !== (p.summary ?? "") ? { summary } : {}),
        ...(benefits.trim() !== p.benefits.join("\n")
          ? { benefits: benefits.split("\n") }
          : {}),
        ...(commitments.trim() !== p.commitments.join("\n")
          ? { commitments: commitments.split("\n") }
          : {}),
        ...(terms.trim() !== (p.terms ?? "") ? { terms } : {}),
        ...(sameIds(eventIds, data!.events.map((e) => e._id))
          ? {}
          : { eventIds }),
        // The unsigned fields are always sent: none of them can bump the
        // version, and always sending them is what makes "clear this box and
        // save" work.
        contactName,
        contactTitle,
        contactEmail,
        paymentRails: rails,
        inKindCredits: credits.flatMap((c) => {
          const cents = centsFromDollars(c.amount);
          if (!c.label.trim() || cents == null) return [];
          return [
            {
              label: c.label.trim(),
              amountCents: cents,
              ...(c.note.trim() ? { note: c.note.trim() } : {}),
            },
          ];
        }),
      });
      setNotice(
        result.signatureCleared
          ? "Saved. The terms changed, so the signature was cleared — the partner will be asked to sign again."
          : "Saved.",
      );
    } catch (err) {
      setError(messageOf(err, "Couldn't save — check your access and try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-4">
      <SectionHeader title="Partner portal" />

      {/* ── Where it stands ─────────────────────────────────────────────── */}
      <Card>
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Badge
            label={SPONSOR_PORTAL_STATE_LABELS[data.state]}
            tone={STATE_TONE[data.state]}
          />
          <Text className="text-sm font-semibold text-ink">
            {formatCents(data.balance.coveredCents)} of{" "}
            {formatCents(data.balance.committedCents)}
          </Text>
        </View>
        <View className="mt-2.5">
          <ProgressBar fraction={data.balance.percentCovered / 100} />
        </View>
        <View className="mt-2 flex-row flex-wrap gap-x-4 gap-y-1">
          <Text className="text-xs text-muted">
            In-kind {formatCents(data.balance.inKindCents)}
          </Text>
          <Text className="text-xs text-muted">
            Received {formatCents(data.balance.paidCents)}
          </Text>
          <Text className="text-xs text-muted">
            Remaining {formatCents(data.balance.balanceCents)}
          </Text>
          {data.pendingCents > 0 ? (
            <Text className="text-xs text-info">
              {formatCents(data.pendingCents)} clearing
            </Text>
          ) : null}
        </View>

        {data.signature ? (
          <View className="mt-3 rounded-md border border-border bg-sunken p-3">
            <Text className="text-sm font-semibold text-ink">
              Signed by {data.signature.name}
            </Text>
            <Text className="mt-0.5 text-xs text-muted">
              {data.signature.title ? `${data.signature.title} · ` : ""}
              {new Date(data.signature.at).toLocaleString()} · terms v
              {data.signature.termsVersion}
            </Text>
          </View>
        ) : null}

        {/* A signature a terms edit invalidated. Surfaced rather than dropped —
            somebody has to know this partner needs to sign again. */}
        {data.staleSignature ? (
          <View className="mt-3 rounded-md border border-warn bg-warn-bg p-3">
            <Text className="text-sm font-semibold text-ink">
              Needs re-signing
            </Text>
            <Text className="mt-0.5 text-xs text-muted">
              {data.staleSignature.name} signed terms v
              {data.staleSignature.termsVersion} on{" "}
              {new Date(data.staleSignature.at).toLocaleDateString()}; the
              agreement is now v{data.proposal.termsVersion}.
            </Text>
          </View>
        ) : null}
      </Card>

      {/* ── The link ────────────────────────────────────────────────────── */}
      {canSend ? (
        <View className="mt-3">
          <Card>
            {data.portal ? (
              <>
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Portal link
                </Text>
                <View className="mt-1.5 flex-row items-center gap-2">
                  <Text
                    className="flex-1 text-xs text-ink"
                    numberOfLines={1}
                    selectable
                  >
                    {data.portal.url ?? data.portal.path}
                  </Text>
                  <CopyButton text={data.portal.url ?? data.portal.path} label />
                </View>
                <Text className="mt-2 text-xs text-faint">
                  {data.portal.firstViewedAt
                    ? `Opened ${new Date(data.portal.lastViewedAt ?? data.portal.firstViewedAt).toLocaleString()}`
                    : "Not opened yet."}
                </Text>
                <View className="mt-3 flex-row flex-wrap gap-2">
                  {data.portal.url ? (
                    <Button
                      title="Open"
                      variant="secondary"
                      size="sm"
                      onPress={() => void Linking.openURL(data.portal!.url!)}
                    />
                  ) : null}
                  <Button
                    title="Email it to the contact"
                    variant="secondary"
                    size="sm"
                    onPress={async () => {
                      setError(null);
                      setNotice(null);
                      try {
                        const r = await sendInvite({ sponsorshipId });
                        setNotice(`Sent to ${r.sentTo}.`);
                      } catch (err) {
                        setError(
                          messageOf(err, "Couldn't send that — try again."),
                        );
                      }
                    }}
                  />
                  <Pressable
                    onPress={() => void revokeLink({ sponsorshipId })}
                    className="justify-center px-2"
                  >
                    <Text className="text-xs font-semibold text-muted">
                      Revoke
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <Text className="text-sm text-muted">
                  {data.revokedAt
                    ? "The previous link was revoked. Creating a new one issues a fresh address."
                    : "No link yet. Create one to let this partner read, sign, and pay their agreement."}
                </Text>
                <View className="mt-3">
                  <Button
                    title="Create the portal link"
                    onPress={() => void issueLink({ sponsorshipId })}
                  />
                </View>
              </>
            )}
          </Card>
        </View>
      ) : null}

      {/* ── The proposal ────────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <Card>
            {willClearSignature ? (
              <View className="mb-3 rounded-md border border-warn bg-warn-bg p-3">
                <Text className="text-xs text-ink">
                  Saving these changes will clear {data.signature?.name}&apos;s
                  signature — the partner will be asked to sign the new terms.
                </Text>
              </View>
            ) : null}

            <TextField
              label="Agreement title"
              value={title}
              onChangeText={setTitle}
              placeholder={data.packageName ?? "Production Partner"}
            />
            <TextField
              label="Amount (USD)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="3500.00"
            />
            {data.packagePriceCents != null &&
            amountCents != null &&
            amountCents !== data.packagePriceCents ? (
              <Text className="-mt-2 mb-3 text-xs text-muted">
                The {data.packageName} tier lists at{" "}
                {formatCents(data.packagePriceCents)} — this agreement is
                negotiated.
              </Text>
            ) : null}
            <TextField
              label="The proposal, in your words"
              value={summary}
              onChangeText={setSummary}
              placeholder={
                "## What this partnership is\nIgnite stands behind Love Thy Neighbor…\n\n- Use ## for a heading\n- Use - for a bullet"
              }
              multiline
            />
            <TextField
              label="What they receive (one per line)"
              value={benefits}
              onChangeText={setBenefits}
              placeholder={"Named production credit on the whole event\nFull photo report"}
              multiline
            />
            <TextField
              label="What we deliver (one per line)"
              value={commitments}
              onChangeText={setCommitments}
              placeholder={"A hosted Worship with Strangers on your anniversary weekend"}
              multiline
            />
            <TextField
              label="Terms"
              value={terms}
              onChangeText={setTerms}
              placeholder={
                "The run of show is settled together in writing, in advance…"
              }
              multiline
            />
          </Card>
        </View>
      ) : null}

      {/* ── What it covers ──────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <CoveragePicker
            selected={eventIds}
            onChange={setEventIds}
            attached={data.events}
          />
        </View>
      ) : null}

      {/* ── Who signs ───────────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <Card>
            <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Partner contact
            </Text>
            <TextField
              label="Name"
              value={contactName}
              onChangeText={setContactName}
              placeholder="Jane Adeyemi"
            />
            <TextField
              label="Role"
              value={contactTitle}
              onChangeText={setContactTitle}
              placeholder="Executive Pastor"
            />
            <TextField
              label="Email"
              value={contactEmail}
              onChangeText={setContactEmail}
              placeholder="jane@church.org"
              keyboardType="email-address"
            />
          </Card>
        </View>
      ) : null}

      {/* ── How they pay ────────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <Card>
            <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              How they can pay
            </Text>
            <Text className="mb-3 text-xs text-muted">
              Bank transfer costs a flat $5.00 at most, whatever the amount. A
              card takes about 3% with no cap — {formatCents(
                Math.round((amountCents ?? data.proposal.amountCents) * 0.029) + 30,
              )}{" "}
              on this agreement.
            </Text>
            <CheckboxRow
              checked
              disabled
              onPress={() => {}}
              label={`${SPONSOR_RAIL_LABELS.ach} — always available`}
            />
            {cardBlocked ? (
              <Text className="text-xs text-muted">
                Card is unavailable above{" "}
                {formatCents(CARD_RAIL_MAX_CENTS)} — the processor&apos;s cut
                would be too large a share of the partnership.
              </Text>
            ) : (
              <CheckboxRow
                checked={rails.includes("card")}
                onPress={() =>
                  setRails((prev) =>
                    prev.includes("card")
                      ? prev.filter((r) => r !== "card")
                      : [...prev, "card"],
                  )
                }
                label={`Also allow ${SPONSOR_RAIL_LABELS.card}`}
              />
            )}
          </Card>
        </View>
      ) : null}

      {/* ── In-kind credits ─────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <Card>
            <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              In-kind credit
            </Text>
            <Text className="mb-3 text-xs text-muted">
              Non-cash value counting against this partnership — a reviewed
              production proposal, donated equipment. Valued at our own budget
              lines, and listed line by line on their page.
            </Text>
            {credits.map((c, i) => (
              <View key={i} className="mb-3 rounded-md border border-border p-3">
                <TextField
                  label="What it covers"
                  value={c.label}
                  onChangeText={(t) => updateCredit(setCredits, i, { label: t })}
                  placeholder="Full production suite — backline, AV, engineers"
                />
                <TextField
                  label="Value (USD)"
                  value={c.amount}
                  onChangeText={(t) => updateCredit(setCredits, i, { amount: t })}
                  keyboardType="decimal-pad"
                  placeholder="2500.00"
                />
                <TextField
                  label="Note (optional)"
                  value={c.note}
                  onChangeText={(t) => updateCredit(setCredits, i, { note: t })}
                  placeholder="Reviewed 2026-08-22 against the LTN budget"
                />
                <Pressable
                  onPress={() =>
                    setCredits((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  <Text className="text-xs font-semibold text-danger">
                    Remove this line
                  </Text>
                </Pressable>
              </View>
            ))}
            <Button
              title="Add a credit line"
              variant="secondary"
              size="sm"
              onPress={() =>
                setCredits((prev) => [
                  ...prev,
                  { label: "", amount: "", note: "" },
                ])
              }
            />
          </Card>
        </View>
      ) : null}

      {/* ── Documents ───────────────────────────────────────────────────── */}
      {canCompose ? (
        <View className="mt-3">
          <DocumentsCard sponsorshipId={sponsorshipId} documents={data.documents} />
        </View>
      ) : null}

      {canCompose ? (
        <View className="mt-3">
          {error ? (
            <Text className="mb-2 text-sm text-danger">{error}</Text>
          ) : null}
          {notice ? (
            <Text className="mb-2 text-sm text-success">{notice}</Text>
          ) : null}
          <Button title="Save the proposal" onPress={save} loading={saving} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * WHICH EVENTS THIS PARTNERSHIP COVERS.
 *
 * A partnership is routinely more than one date — the Ignite agreement stands
 * behind Love Thy Neighbor on Sept 26 AND the hosted Worship with Strangers on
 * Sept 18 — and until now nothing in the app could say so. `eventIds` has been
 * on the schema since sponsorships shipped, but the detail screen only ever
 * passed the stored value straight back, so every agreement carried an empty
 * list and the partner's page had nothing to show.
 *
 * ── WHY ALREADY-ATTACHED EVENTS RENDER FIRST, ALWAYS ────────────────────────
 * The list is drawn from `events.list` at scope "all" and then split: the
 * events this agreement already covers, then everything else. Without that
 * split, an agreement covering a date that has since passed would find that
 * date missing from the picker — and the first save that touched anything else
 * would silently drop it from what the partner was promised.
 *
 * ── AND WHY THE CHAPTER LENS IS NAMED OUT LOUD ──────────────────────────────
 * `events.list` is scoped to the caller's active chapter, while agreements are
 * central. A central director browsing from the wrong lens sees the wrong
 * city's calendar — the same limitation the packages screen carries — so the
 * empty state says which chapter it is looking at rather than claiming there
 * are no events.
 */
function CoveragePicker({
  selected,
  onChange,
  attached,
}: {
  selected: Id<"events">[];
  onChange: (next: Id<"events">[]) => void;
  attached: { _id: Id<"events">; name: string; eventDate: number }[];
}) {
  const chapterId = useGivingScope();
  const events = useQuery(api.events.list, { scope: "all", chapterId });

  // Already-attached first (so a past date can never fall off the list), then
  // everything else soonest-first.
  const rows = useMemo(() => {
    const chosen = new Set<string>(selected);
    const byId = new Map<string, { _id: Id<"events">; name: string; eventDate: number }>();
    for (const e of attached) byId.set(e._id, e);
    for (const e of events ?? []) {
      byId.set(e._id, { _id: e._id, name: e.name, eventDate: e.eventDate });
    }
    const all = [...byId.values()];
    return [
      ...all.filter((e) => chosen.has(e._id)).sort((a, b) => a.eventDate - b.eventDate),
      ...all.filter((e) => !chosen.has(e._id)).sort((a, b) => a.eventDate - b.eventDate),
    ];
  }, [events, attached, selected]);

  const atCap = selected.length >= MAX_SPONSORSHIP_EVENTS;

  function toggle(id: Id<"events">) {
    onChange(
      selected.includes(id)
        ? selected.filter((e) => e !== id)
        : [...selected, id],
    );
  }

  return (
    <Card>
      <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        What this partnership covers
      </Text>
      <Text className="mb-3 text-xs text-muted">
        Every gathering this one agreement stands behind. A partnership can
        carry several — the partner sees each one by name and date on their
        page.
      </Text>

      {events === undefined ? (
        <Text className="py-2 text-sm text-muted">Loading events…</Text>
      ) : rows.length === 0 ? (
        <Text className="py-2 text-sm text-muted">
          No events on this chapter&apos;s calendar yet. Switch chapters if this
          partnership covers another city&apos;s gatherings.
        </Text>
      ) : (
        <View>
          {rows.map((e) => {
            const on = selected.includes(e._id);
            return (
              <CheckboxRow
                key={e._id}
                checked={on}
                disabled={!on && atCap}
                onPress={() => toggle(e._id)}
                label={`${e.name} · ${new Date(e.eventDate).toLocaleDateString(
                  "en-US",
                  { month: "short", day: "numeric", year: "numeric" },
                )}`}
              />
            );
          })}
        </View>
      )}

      {selected.length === 0 ? (
        <Text className="mt-1 text-xs text-muted">
          Nothing selected — the partner&apos;s page will show no dates. That is
          right for a season or full-year agreement, and wrong for a spot at a
          specific gathering.
        </Text>
      ) : (
        <Text className="mt-1 text-xs text-muted">
          {selected.length} of {MAX_SPONSORSHIP_EVENTS} — changing this asks the
          partner to sign again, because it changes what they agreed to.
        </Text>
      )}
    </Card>
  );
}

/**
 * FREE-FORM DOCUMENTS on the agreement — the paperwork behind the deal.
 *
 * The founder's case: a partner covering production themselves has an agreed
 * proposal, and this is where that PDF lives — the evidence a `inKindCredits`
 * line points at. Each document is INTERNAL until the desk explicitly shows it
 * on the partner's page, because the failure worth ordering against is a draft
 * or an internal note leaking to a partner (see `attachDocument`'s doc).
 *
 * ── WEB IS THE UPLOAD PATH, DELIBERATELY ────────────────────────────────────
 * A PDF comes off a laptop, and the giving desk runs on the web build. The web
 * branch is a real file input that takes PDFs and images alike. The native
 * branch falls back to the photo library — enough for a photographed or
 * scanned agreement — because a full native document picker means a new native
 * module and a dev-client rebuild, which is not this PR's job. The gap is
 * named here rather than hidden.
 */
function DocumentsCard({
  sponsorshipId,
  documents,
}: {
  sponsorshipId: Id<"sponsorships">;
  documents: {
    _id: Id<"sponsorshipDocuments">;
    label: string;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    shared: boolean;
    uploadedAt: number;
  }[];
}) {
  const uploadUrl = useMutation(api.sponsorPortal.documentUploadUrl);
  const attach = useMutation(api.sponsorPortal.attachDocument);
  const setVisibility = useMutation(api.sponsorPortal.setDocumentVisibility);
  const remove = useMutation(api.sponsorPortal.removeDocument);

  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(
    blob: Blob,
    contentType: string,
    fileName: string,
    sizeBytes: number,
  ) {
    setError(null);
    if (!isAcceptedSponsorDocType(contentType)) {
      setError("Attach a PDF or an image (PNG, JPEG, WebP, or HEIC).");
      return;
    }
    setBusy(true);
    try {
      const url = await uploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      const { storageId } = (await res.json()) as {
        storageId: Id<"_storage">;
      };
      await attach({
        sponsorshipId,
        storageId,
        // The label is the desk's words; default it to the filename so an
        // upload is never nameless, and let them type a better one first.
        label: label.trim() || fileName.replace(/\.[^.]+$/, ""),
        fileName,
        contentType,
        sizeBytes,
        // Never shared on upload. Showing it to the partner is a second,
        // deliberate tap on the row below.
      });
      setLabel("");
    } catch (err) {
      setError(messageOf(err, "Couldn't attach that — try again."));
    } finally {
      setBusy(false);
    }
  }

  function pickWeb() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void upload(file, file.type || "application/pdf", file.name, file.size);
    };
    input.click();
  }

  async function pickNative() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    const resp = await fetch(asset.uri);
    const blob = await resp.blob();
    await upload(
      blob,
      asset.mimeType || blob.type || "image/jpeg",
      asset.fileName ?? "Scanned document",
      asset.fileSize ?? blob.size ?? 0,
    );
  }

  return (
    <Card>
      <Text className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Documents
      </Text>
      <Text className="mb-3 text-xs text-muted">
        Attach any paperwork behind this partnership — the agreed production
        proposal, a signed side letter. Each stays internal to the desk until
        you choose to show it on the partner&apos;s page.
      </Text>

      {documents.length > 0 ? (
        <View className="mb-3">
          {documents.map((d) => (
            <View
              key={d._id}
              className="mb-2 rounded-md border border-border p-3"
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-ink">
                    {d.label}
                  </Text>
                  <Text className="mt-0.5 text-xs text-faint" numberOfLines={1}>
                    {sponsorDocKind(d.contentType ?? undefined).toUpperCase()}
                    {d.fileName ? ` · ${d.fileName}` : ""}
                  </Text>
                </View>
                <Badge
                  label={d.shared ? "On their page" : "Desk only"}
                  tone={d.shared ? "info" : "neutral"}
                />
              </View>
              <View className="mt-2.5 flex-row flex-wrap items-center gap-4">
                <Pressable
                  onPress={() =>
                    void setVisibility({ documentId: d._id, shared: !d.shared })
                  }
                >
                  <Text className="text-xs font-semibold text-accent">
                    {d.shared ? "Hide from their page" : "Show on their page"}
                  </Text>
                </Pressable>
                <Pressable onPress={() => void remove({ documentId: d._id })}>
                  <Text className="text-xs font-semibold text-danger">
                    Remove
                  </Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <TextField
        label="Label (optional)"
        value={label}
        onChangeText={setLabel}
        placeholder="Production proposal — full suite"
      />
      {error ? (
        <Text className="mb-2 text-sm text-danger">{error}</Text>
      ) : null}
      <View className="flex-row items-center gap-3">
        <Button
          title={busy ? "Uploading…" : "Attach a document"}
          variant="secondary"
          size="sm"
          disabled={busy}
          onPress={() => (Platform.OS === "web" ? pickWeb() : void pickNative())}
        />
        {busy ? <ActivityIndicator size="small" /> : null}
      </View>
      {Platform.OS !== "web" ? (
        <Text className="mt-2 text-xs text-faint">
          On this device you can attach a photo or scan. To attach a PDF, open
          the partnership on the web.
        </Text>
      ) : null}
    </Card>
  );
}

/** Two id lists carrying the same set — order-insensitive, because reordering
 *  a checkbox list is not a change to what anybody agreed to. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function updateCredit(
  setCredits: React.Dispatch<React.SetStateAction<CreditDraft[]>>,
  index: number,
  patch: Partial<CreditDraft>,
) {
  setCredits((prev) =>
    prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
  );
}

/** A ConvexError's own sentence, or the fallback. The server writes messages a
 *  manager can act on ("Card isn't available on a partnership this size"), and
 *  swallowing them for a generic string is how a fixable refusal becomes a
 *  mystery. */
function messageOf(err: unknown, fallback: string): string {
  const data = (err as { data?: { message?: string } })?.data;
  return data?.message ?? fallback;
}
