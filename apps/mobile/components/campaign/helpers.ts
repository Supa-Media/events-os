/**
 * Shared helpers for the Campaigns desk — status → Badge tone, the
 * cross-platform confirm dialog (mirrors `ticketing/helpers.ts#confirmAction`
 * and `TemplatesView`'s `confirmArchiveTemplate`), and small display helpers.
 */
import { Alert, Platform } from "react-native";
import type { BadgeTone } from "../ui";

/** A campaign's lifecycle status, per the `campaigns` contract. Two-party
 *  approval (founder requirement, 2026-07-24) added `pending_approval` /
 *  `approved` / `changes_requested` / `denied` between `draft` and
 *  `sending` — see `campaigns.ts`'s state-machine doc. */
export type CampaignStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "changes_requested"
  | "denied";

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  approved: "Approved — ready to send",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  changes_requested: "Changes requested",
  denied: "Denied",
};

const STATUS_TONE: Record<CampaignStatus, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "success",
  sending: "warn",
  sent: "success",
  failed: "danger",
  changes_requested: "danger",
  denied: "danger",
};

export function campaignStatusLabel(status: string): string {
  return STATUS_LABEL[status as CampaignStatus] ?? status;
}

export function campaignStatusTone(status: string): BadgeTone {
  return STATUS_TONE[status as CampaignStatus] ?? "neutral";
}

/** Cross-platform confirm: window.confirm on web, Alert.alert on native. */
export function confirmAction({
  title,
  message,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
}): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`)) {
      onConfirm();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    {
      text: confirmLabel,
      style: destructive ? "destructive" : "default",
      onPress: onConfirm,
    },
  ]);
}

/** "1 recipient" / "3 recipients". */
export function pluralCount(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "1 reply" / "3 replies" — `pluralCount` can't handle the irregular plural. */
export function pluralReply(n: number): string {
  return `${n} repl${n === 1 ? "y" : "ies"}`;
}

/** "Name <email>" when a name is given, else just the bare email — mirrors
 *  the backend's `lib/resend.ts#formatFromAddress`, kept as a small
 *  client-side twin so the send-confirm/status-card copy can show the exact
 *  From line a send will actually use without a round-trip. */
export function formatSenderDisplay(
  name: string | null | undefined,
  email: string,
): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} <${email}>` : email;
}

const AUDIENCE_SOURCE_LABEL: Record<string, string> = {
  guests: "Guests",
  donors: "Donors",
  people: "People (roster)",
  person_filters: "Filters",
};

/** A short "who this targets" description for the approval review card —
 *  the audience's SOURCE + its own filters, plain-language. Deliberately
 *  doesn't resolve event/chapter/seat ids to names (no extra round-trip);
 *  good enough for a reviewer to sanity-check the SHAPE of the audience, with
 *  the live recipient count (from `previewAudience`) carrying the real
 *  number. Person-centric audiences Phase 3 (specs/person-centric-audiences.md
 *  "Phase 3" item 6) — `person_filters`'s richer criteria + hand-picks are
 *  summarized here too, automatically, so the two-party approval review card
 *  (PR #399) shows the new picker's shape without any changes on its own
 *  side — see `CampaignStatusCard.tsx`'s call site. */
export function describeAudience(
  source: string,
  filters: {
    eventId?: string | null;
    chapterId?: string | null;
    donorStatus?: string | null;
    gaveWithinDays?: number | null;
    givingLifetimeMinCents?: number | null;
    givingLifetimeMaxCents?: number | null;
    giftCountMin?: number | null;
    backerStatus?: string | null;
    attendedEventId?: string | null;
    attendedWithinDays?: number | null;
    rsvpStatus?: string | null;
    seatId?: string | null;
    teamOnly?: boolean | null;
    contactsOnly?: boolean | null;
    verifiedEmailOnly?: boolean | null;
  },
  handPicks?: { includeCount?: number; excludeCount?: number },
): string {
  const parts = [AUDIENCE_SOURCE_LABEL[source] ?? source];
  if (source === "person_filters") {
    if (filters.chapterId) parts.push("one chapter");
    if (filters.teamOnly) parts.push("team only");
    if (filters.contactsOnly) parts.push("contacts only");
    if (filters.givingLifetimeMinCents != null || filters.givingLifetimeMaxCents != null) {
      parts.push("giving amount");
    }
    if (filters.giftCountMin != null) parts.push(`≥${filters.giftCountMin} gifts`);
    if (filters.donorStatus) parts.push(`donor: ${filters.donorStatus}`);
    if (filters.gaveWithinDays != null) parts.push(`gave within ${filters.gaveWithinDays}d`);
    if (filters.backerStatus) parts.push(`backer: ${filters.backerStatus}`);
    if (filters.attendedEventId) parts.push("attended one event");
    if (filters.attendedWithinDays != null) parts.push(`attended within ${filters.attendedWithinDays}d`);
    if (filters.rsvpStatus) parts.push(`rsvp: ${filters.rsvpStatus}`);
    if (filters.seatId) parts.push("holds a role");
    if (filters.verifiedEmailOnly) parts.push("verified email");
    if (handPicks?.includeCount) parts.push(`+${handPicks.includeCount} hand-picked`);
    if (handPicks?.excludeCount) parts.push(`−${handPicks.excludeCount} excluded`);
    if (parts.length === 1) parts.push("everyone");
    return parts.join(" · ");
  }
  if (filters.eventId) parts.push("one event");
  if (filters.chapterId) parts.push("one chapter");
  if (filters.donorStatus) parts.push(`status: ${filters.donorStatus}`);
  if (filters.gaveWithinDays != null) parts.push(`gave within ${filters.gaveWithinDays}d`);
  return parts.join(" · ");
}
