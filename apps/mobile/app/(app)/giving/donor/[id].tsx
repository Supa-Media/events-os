/**
 * GIVING · Donor detail — identity, denormalized rollups, full gift history,
 * a manual record-gift form (the "backfill people's giving history" workflow,
 * PRD §1), and notes. Reads `getDonor` (gated by `requireGivingView`); the
 * record-gift form is shown only to a caller with `giving.manage` and posts to
 * `recordGift` (gated server-side too).
 */
import { useState } from "react";
import { ActivityIndicator, View, Text } from "react-native";
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
  Screen,
  SectionHeader,
  Select,
  TextField,
} from "../../../../components/ui";
import { colors } from "../../../../lib/theme";
import { donorStatusTone } from "../donors";

const GIFT_METHODS: { value: string; label: string }[] = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "wire", label: "Wire" },
  { value: "stripe", label: "Card / Stripe" },
  { value: "in_kind", label: "In-kind" },
  { value: "imported", label: "Imported" },
];

export default function DonorDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const donorId = id as Id<"donors">;
  const access = useQuery(api.givingPlatform.myGivingAccess, {});
  const data = useQuery(api.givingPlatform.getDonor, { donorId });

  if (access === undefined || data === undefined) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const { donor, gifts } = data;
  return (
    <Screen>
      <Narrow>
        <View className="mb-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-2xl font-bold text-ink">{donor.name}</Text>
            <Badge label={donor.status} tone={donorStatusTone(donor.status)} />
          </View>
          {donor.email ? (
            <Text className="mt-1 text-sm text-muted">{donor.email}</Text>
          ) : null}
          {donor.phone ? (
            <Text className="text-sm text-muted">{donor.phone}</Text>
          ) : null}
          <Text className="mt-1 text-xs text-faint">
            {donor.kind}
            {donor.source ? ` · ${donor.source}` : ""}
          </Text>
        </View>

        <View className="mb-4 flex-row flex-wrap gap-3">
          <Stat label="Lifetime" value={formatCents(donor.lifetimeCents)} />
          <Stat label="Gifts" value={String(donor.giftCount)} />
          <Stat
            label="Last gift"
            value={
              donor.lastGiftAt
                ? new Date(donor.lastGiftAt).toLocaleDateString()
                : "—"
            }
          />
        </View>

        {donor.notes ? (
          <View className="mb-4">
            <SectionHeader title="Notes" />
            <Card>
              <Text className="text-sm text-ink">{donor.notes}</Text>
            </Card>
          </View>
        ) : null}

        <BackingSection donorId={donorId} />

        {access.canManage ? <RecordGiftForm donorId={donorId} /> : null}

        <SectionHeader title="Gift history" />
        {gifts.length === 0 ? (
          <EmptyState
            title="No gifts recorded"
            message="Record this donor's first gift above."
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

/** The donor's recurring pledges (F-6 P2), if any — the "active pledge" the
 *  donor-detail screen is meant to surface. Renders nothing when the donor has
 *  never pledged, so it stays out of the way for one-time givers. */
function BackingSection({ donorId }: { donorId: Id<"donors"> }) {
  const pledges = useQuery(api.givingPledges.getDonorPledges, { donorId });
  if (pledges === undefined || pledges.length === 0) return null;
  return (
    <View className="mb-4">
      <SectionHeader title="Backing" />
      <View className="gap-2">
        {pledges.map((p) => (
          <View
            key={p._id}
            className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3"
          >
            <View>
              <Text className="text-base font-semibold text-ink">
                {formatCents(p.amountCents)}
                <Text className="text-xs text-muted"> /mo</Text>
              </Text>
              <Text className="text-xs text-muted">
                {p.origin === "imported" ? "Givebutter (awaiting re-signup)" : "Monthly pledge"}
              </Text>
            </View>
            <Badge
              label={p.status}
              tone={
                p.status === "active"
                  ? "success"
                  : p.status === "past_due"
                    ? "warn"
                    : p.status === "canceled"
                      ? "danger"
                      : "neutral"
              }
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function RecordGiftForm({ donorId }: { donorId: Id<"donors"> }) {
  const recordGift = useMutation(api.givingPlatform.recordGift);
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
      await recordGift({ donorId, amountCents, method: method as never });
      setAmount("");
    } catch {
      setError("Couldn't record that gift — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="mb-4">
      <SectionHeader title="Record a gift" />
      <Card>
        <TextField
          label="Amount (USD)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="500.00"
        />
        <Select
          label="Method"
          value={method}
          options={GIFT_METHODS}
          onChange={setMethod}
        />
        {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
        <Button title="Record gift" onPress={submit} loading={saving} />
      </Card>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-w-[110px] flex-1 rounded-lg border border-border bg-raised p-3">
      <Text className="text-xs text-muted">{label}</Text>
      <Text className="mt-1 text-lg font-bold text-ink">{value}</Text>
    </View>
  );
}
