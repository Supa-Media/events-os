/**
 * GIVING · Sponsorship detail — one agreement: org, package, attached events,
 * owner, due-diligence + terms, next touchpoint, and the linked-gifts total
 * (PRD §4 deliverable). Reads `getSponsorship` (gated `requireGivingView`);
 * manage-capability holders can move the pipeline stage, edit the
 * relationship fields, and record a payment against the agreement.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Narrow,
  PersonPicker,
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { sponsorshipStatusTone } from "../sponsorships";

const STATUS_OPTIONS = [
  { value: "prospect", label: "Prospect" },
  { value: "pitched", label: "Pitched" },
  { value: "committed", label: "Committed" },
  { value: "active", label: "Active" },
  { value: "lapsed", label: "Lapsed" },
  { value: "declined", label: "Declined" },
];

const GIFT_METHODS: { value: string; label: string }[] = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "wire", label: "Wire" },
  { value: "stripe", label: "Card / Stripe" },
  { value: "in_kind", label: "In-kind" },
  { value: "imported", label: "Imported" },
];

function pricingLabel(pkg: { pricing: { kind: string; amountCents: number } }) {
  const cadence =
    pkg.pricing.kind === "one_time"
      ? "one-time"
      : pkg.pricing.kind === "monthly"
        ? "/mo"
        : "/yr";
  return `${formatCents(pkg.pricing.amountCents)} ${cadence}`;
}

function scopeLabel(scope: { kind: string }) {
  if (scope.kind === "event") return "Single event";
  if (scope.kind === "season") return "Season";
  return "Full year";
}

export default function SponsorshipDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sponsorshipId = id as Id<"sponsorships">;
  const access = useQuery(api.givingPlatform.myGivingAccess, {});
  const data = useQuery(api.sponsorships.getSponsorship, { sponsorshipId });
  // Called unconditionally (rules of hooks) even though the control it feeds
  // only renders for a manage-capability holder — see the Select below.
  const setStatus = useMutation(api.sponsorships.setSponsorshipStatus);

  if (access === undefined || data === undefined) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!access.canView) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Ask a development director to grant you access to the giving desk."
          />
        </Narrow>
      </Screen>
    );
  }

  const { sponsorship, donor, package: pkg, events, gifts, giftsTotalCents, ownerPerson } =
    data;
  const canManage = access.canManage;

  return (
    <Screen>
      <Narrow>
        <View className="mb-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-2xl font-bold text-ink">
              {donor?.name ?? "Unknown org"}
            </Text>
            <Badge
              label={
                STATUS_OPTIONS.find((o) => o.value === sponsorship.status)?.label ??
                sponsorship.status
              }
              tone={sponsorshipStatusTone(sponsorship.status)}
            />
          </View>
          <Text className="mt-1 text-xs text-faint">{donor?.kind}</Text>
        </View>

        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Package" value={pkg?.name ?? "—"} />
          <Stat label="Price" value={pkg ? pricingLabel(pkg) : "—"} />
          <Stat label="Scope" value={pkg ? scopeLabel(pkg.scope) : "—"} />
          <Stat label="Linked gifts" value={formatCents(giftsTotalCents)} />
        </View>

        {canManage ? (
          <View className="mb-4">
            <SectionHeader title="Pipeline stage" />
            <Card>
              <Select
                value={sponsorship.status}
                options={STATUS_OPTIONS}
                onChange={(status) =>
                  void setStatus({ sponsorshipId, status: status as never })
                }
              />
            </Card>
          </View>
        ) : null}

        <SectionHeader title="Attached events" />
        {events.length === 0 ? (
          <EmptyState title="No events attached" message="This agreement isn't tied to a specific event." />
        ) : (
          <View className="mb-4 gap-2">
            {events.map((e) => (
              <View key={e._id} className="rounded-lg border border-border bg-raised p-3">
                <Text className="text-sm font-semibold text-ink">{e.name}</Text>
                <Text className="text-xs text-muted">
                  {new Date(e.eventDate).toLocaleDateString()}
                </Text>
              </View>
            ))}
          </View>
        )}

        {canManage ? (
          <RelationshipForm
            sponsorshipId={sponsorshipId}
            sponsorship={sponsorship}
            ownerName={ownerPerson?.name ?? null}
          />
        ) : (
          <ReadOnlyRelationship sponsorship={sponsorship} />
        )}

        {canManage ? <RecordGiftForm sponsorshipId={sponsorshipId} /> : null}

        <SectionHeader title="Gift history" count={gifts.length} />
        {gifts.length === 0 ? (
          <EmptyState
            title="No gifts recorded"
            message="Record this sponsorship's first payment above."
          />
        ) : (
          <View className="gap-2">
            {gifts.map((g) => (
              <View
                key={g._id}
                className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3"
              >
                <View>
                  <Text className="text-base font-semibold text-ink">
                    {formatCents(g.amountCents)}
                  </Text>
                  <Text className="text-xs text-muted">
                    {new Date(g.receivedAt).toLocaleDateString()} · {g.method}
                  </Text>
                </View>
                {g.note ? (
                  <Text className="ml-3 flex-1 text-right text-xs text-faint" numberOfLines={2}>
                    {g.note}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[140px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text className="mt-1 text-lg font-bold text-ink" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function ReadOnlyRelationship({
  sponsorship,
}: {
  sponsorship: {
    ownerPersonId?: Id<"people">;
    dueDiligenceNotes?: string;
    terms?: string;
    nextTouchpointAt?: number;
  };
}) {
  if (!sponsorship.dueDiligenceNotes && !sponsorship.terms && !sponsorship.nextTouchpointAt) {
    return null;
  }
  return (
    <View className="mb-4">
      <SectionHeader title="Relationship" />
      <Card>
        {sponsorship.dueDiligenceNotes ? (
          <Text className="mb-2 text-sm text-ink">
            Due diligence: {sponsorship.dueDiligenceNotes}
          </Text>
        ) : null}
        {sponsorship.terms ? (
          <Text className="mb-2 text-sm text-ink">Terms: {sponsorship.terms}</Text>
        ) : null}
        {sponsorship.nextTouchpointAt ? (
          <Text className="text-sm text-ink">
            Next touchpoint: {new Date(sponsorship.nextTouchpointAt).toLocaleDateString()}
          </Text>
        ) : null}
      </Card>
    </View>
  );
}

function RelationshipForm({
  sponsorshipId,
  sponsorship,
  ownerName: initialOwnerName,
}: {
  sponsorshipId: Id<"sponsorships">;
  sponsorship: {
    donorId: Id<"donors">;
    packageId: Id<"sponsorPackages">;
    eventIds?: Id<"events">[];
    ownerPersonId?: Id<"people">;
    dueDiligenceNotes?: string;
    terms?: string;
    nextTouchpointAt?: number;
  };
  ownerName: string | null;
}) {
  const upsertSponsorship = useMutation(api.sponsorships.upsertSponsorship);
  const [ownerPersonId, setOwnerPersonId] = useState<Id<"people"> | undefined>(
    sponsorship.ownerPersonId,
  );
  const [ownerName, setOwnerName] = useState<string | null>(initialOwnerName);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notes, setNotes] = useState(sponsorship.dueDiligenceNotes ?? "");
  const [terms, setTerms] = useState(sponsorship.terms ?? "");
  const [touchpoint, setTouchpoint] = useState(
    sponsorship.nextTouchpointAt
      ? new Date(sponsorship.nextTouchpointAt).toISOString().slice(0, 10)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server round-trips the picked owner's name via `getSponsorship`
  // (reactive) after `save()` — sync it back in once it lands.
  useEffect(() => setOwnerName(initialOwnerName), [initialOwnerName]);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const nextTouchpointAt = touchpoint
        ? new Date(`${touchpoint}T00:00:00`).getTime()
        : undefined;
      await upsertSponsorship({
        sponsorshipId,
        donorId: sponsorship.donorId,
        packageId: sponsorship.packageId,
        eventIds: sponsorship.eventIds ?? [],
        ownerPersonId,
        dueDiligenceNotes: notes,
        terms,
        nextTouchpointAt,
      });
    } catch {
      setError("Couldn't save — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-4">
      <SectionHeader title="Relationship" />
      <Card>
        <View className="mb-3">
          <Text className="mb-1.5 text-sm font-semibold text-ink">Owner</Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            className="rounded-md border border-border-strong bg-raised px-3 py-2.5"
          >
            <Text className="text-base text-ink">{ownerName ?? "Unassigned"}</Text>
          </Pressable>
        </View>
        <TextField
          label="Due diligence notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Statement of beliefs, pastor relationship, visited a service…"
          multiline
        />
        <TextField
          label="Terms"
          value={terms}
          onChangeText={setTerms}
          placeholder="Agreed deliverables, invoicing cadence…"
          multiline
        />
        <TextField
          label="Next touchpoint (YYYY-MM-DD)"
          value={touchpoint}
          onChangeText={setTouchpoint}
          placeholder="2026-08-01"
        />
        {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
        <Button title="Save" onPress={save} loading={saving} />
      </Card>
      <PersonPicker
        visible={pickerOpen}
        title="Sponsorship owner"
        selectedId={ownerPersonId ?? null}
        onPick={(personId) => {
          setOwnerPersonId(personId as Id<"people">);
          setPickerOpen(false);
        }}
        onClear={() => {
          setOwnerPersonId(undefined);
          setOwnerName(null);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

function RecordGiftForm({ sponsorshipId }: { sponsorshipId: Id<"sponsorships"> }) {
  const recordGift = useMutation(api.sponsorships.recordSponsorshipGift);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("check");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    const dollars = Number.parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    const amountCents = Math.round(dollars * 100);
    setSaving(true);
    try {
      await recordGift({ sponsorshipId, amountCents, method: method as never });
      setAmount("");
    } catch {
      setError("Couldn't record that gift — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-4">
      <SectionHeader title="Record a payment" />
      <Card>
        <TextField
          label="Amount (USD)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="500.00"
        />
        <Select label="Method" value={method} options={GIFT_METHODS} onChange={setMethod} />
        {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
        <Button title="Record payment" onPress={submit} loading={saving} />
      </Card>
    </View>
  );
}
