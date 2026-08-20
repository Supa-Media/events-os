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
import { Linking, Pressable, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  CARD_RAIL_MAX_CENTS,
  SPONSOR_PORTAL_STATE_LABELS,
  SPONSOR_RAIL_LABELS,
  cardRailBlockedReason,
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
  canManage,
}: {
  sponsorshipId: Id<"sponsorships">;
  canManage: boolean;
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
      terms.trim() !== (p.terms ?? "")
    );
  }, [data, title, amountCents, summary, benefits, commitments, terms]);

  if (data === undefined) return null;

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
      {canManage ? (
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
      {canManage ? (
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

      {/* ── Who signs ───────────────────────────────────────────────────── */}
      {canManage ? (
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
      {canManage ? (
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
      {canManage ? (
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

      {canManage ? (
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
