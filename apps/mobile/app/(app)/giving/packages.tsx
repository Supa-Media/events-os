/**
 * GIVING · Packages — the dev-director-editable sponsor package tiers (PRD
 * §4: "packages are editable rows, not constants"). List ordered by
 * `tierRank`; a manage-capability holder can create a tier or edit/deactivate
 * an existing one. Central lens only (mirrors the backend gate).
 */
import { useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
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
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

const AUDIENCE_OPTIONS = [
  { value: "church", label: "Church" },
  { value: "business", label: "Business" },
  { value: "any", label: "Any" },
];
const PRICING_KIND_OPTIONS = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];
const SCOPE_KIND_OPTIONS = [
  { value: "annual", label: "Full year" },
  { value: "season", label: "Season" },
  { value: "event", label: "Single event" },
];

function pricingLabel(pkg: Doc<"sponsorPackages">) {
  const cadence =
    pkg.pricing.kind === "one_time"
      ? "one-time"
      : pkg.pricing.kind === "monthly"
        ? "/mo"
        : "/yr";
  return `${formatCents(pkg.pricing.amountCents)} ${cadence}`;
}

export default function PackagesScreen() {
  const access = useQuery(api.givingPlatform.myGivingAccess, {});

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope !== "central") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Development desk access needed"
            message="Sponsor packages are managed at the org level by a development director."
          />
        </Narrow>
      </Screen>
    );
  }
  return <PackagesBody canManage={access.canManage} />;
}

function PackagesBody({ canManage }: { canManage: boolean }) {
  const packages = useQuery(api.sponsorships.listPackages, {});
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<Id<"sponsorPackages"> | null>(null);

  if (packages === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        <Text className="mb-3 text-sm font-semibold text-muted">
          Central · Sponsor packages
        </Text>

        {canManage ? (
          <View className="mb-4">
            <Button
              title={showNew ? "Cancel" : "New package"}
              icon={showNew ? undefined : "plus"}
              variant={showNew ? "secondary" : "primary"}
              onPress={() => {
                setEditingId(null);
                setShowNew((v) => !v);
              }}
            />
            {showNew ? (
              <View className="mt-3">
                <PackageForm onDone={() => setShowNew(false)} />
              </View>
            ) : null}
          </View>
        ) : null}

        <SectionHeader title="Tiers" count={packages.length} />
        {packages.length === 0 ? (
          <EmptyState
            title="No packages yet"
            message="Create the first sponsor package tier above."
          />
        ) : (
          <View className="gap-2">
            {packages.map((pkg) =>
              editingId === pkg._id ? (
                <PackageForm
                  key={pkg._id}
                  existing={pkg}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <PackageRow
                  key={pkg._id}
                  pkg={pkg}
                  canManage={canManage}
                  onEdit={() => {
                    setShowNew(false);
                    setEditingId(pkg._id);
                  }}
                />
              ),
            )}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function PackageRow({
  pkg,
  canManage,
  onEdit,
}: {
  pkg: Doc<"sponsorPackages">;
  canManage: boolean;
  onEdit: () => void;
}) {
  const deactivatePackage = useMutation(api.sponsorships.deactivatePackage);
  const savePackage = useMutation(api.sponsorships.savePackage);

  return (
    <Card padding="md">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <View className="flex-row items-center gap-2">
            <Text className="text-base font-semibold text-ink">{pkg.name}</Text>
            <Badge label={`Tier ${pkg.tierRank}`} tone="neutral" />
            {!pkg.active ? <Badge label="Inactive" tone="warn" /> : null}
          </View>
          <Text className="mt-0.5 text-xs text-muted">
            {pricingLabel(pkg)} ·{" "}
            {SCOPE_KIND_OPTIONS.find((o) => o.value === pkg.scope.kind)?.label} ·{" "}
            {AUDIENCE_OPTIONS.find((o) => o.value === pkg.audience)?.label}
          </Text>
          {pkg.benefits.length > 0 ? (
            <Text className="mt-1.5 text-xs text-ink" numberOfLines={2}>
              Benefits: {pkg.benefits.join(", ")}
            </Text>
          ) : null}
          {pkg.commitments.length > 0 ? (
            <Text className="mt-0.5 text-xs text-ink" numberOfLines={2}>
              We deliver: {pkg.commitments.join(", ")}
            </Text>
          ) : null}
        </View>
        {canManage ? (
          <View className="items-end gap-2">
            <Pressable onPress={onEdit}>
              <Text className="text-xs font-semibold text-accent">Edit</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                pkg.active
                  ? deactivatePackage({ packageId: pkg._id })
                  : savePackage({
                      packageId: pkg._id,
                      name: pkg.name,
                      tierRank: pkg.tierRank,
                      audience: pkg.audience,
                      pricing: pkg.pricing,
                      scope: pkg.scope,
                      benefits: pkg.benefits,
                      commitments: pkg.commitments,
                      active: true,
                    })
              }
            >
              <Text className="text-xs font-semibold text-muted">
                {pkg.active ? "Deactivate" : "Reactivate"}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function PackageForm({
  existing,
  onDone,
}: {
  existing?: Doc<"sponsorPackages">;
  onDone: () => void;
}) {
  const savePackage = useMutation(api.sponsorships.savePackage);
  // `events.list` is scoped to the CALLER's currently-active chapter (the
  // app's existing chapter-context pattern) — a central dev-director picking
  // an event package for a chapter other than their own active one should
  // switch chapters first. A cross-chapter event picker is out of scope here;
  // the backend still validates the chosen `eventId` exists either way.
  const upcomingEvents = useQuery(api.events.list, { scope: "upcoming" });

  const [name, setName] = useState(existing?.name ?? "");
  const [tierRank, setTierRank] = useState(String(existing?.tierRank ?? 1));
  const [audience, setAudience] = useState(existing?.audience ?? "any");
  const [pricingKind, setPricingKind] = useState(existing?.pricing.kind ?? "annual");
  const [amount, setAmount] = useState(
    existing ? String(existing.pricing.amountCents / 100) : "",
  );
  const [scopeKind, setScopeKind] = useState(existing?.scope.kind ?? "annual");
  const [eventId, setEventId] = useState<string | null>(
    existing?.scope.kind === "event" ? existing.scope.eventId : null,
  );
  const [benefits, setBenefits] = useState(existing?.benefits.join("\n") ?? "");
  const [commitments, setCommitments] = useState(
    existing?.commitments.join("\n") ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const eventOptions = (upcomingEvents ?? []).map((e) => ({
    value: e._id,
    label: e.name,
  }));

  async function submit() {
    setError(null);
    const dollars = Number.parseFloat(amount);
    const rank = Number.parseInt(tierRank, 10);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Enter a price greater than zero.");
      return;
    }
    if (!Number.isInteger(rank) || rank <= 0) {
      setError("Tier rank must be a positive whole number.");
      return;
    }
    if (scopeKind === "event" && !eventId) {
      setError("Choose the event this package attaches to.");
      return;
    }
    setSaving(true);
    try {
      await savePackage({
        packageId: existing?._id,
        name,
        tierRank: rank,
        audience: audience as "church" | "business" | "any",
        pricing: {
          kind: pricingKind as "one_time" | "monthly" | "annual",
          amountCents: Math.round(dollars * 100),
        },
        scope:
          scopeKind === "event"
            ? { kind: "event", eventId: eventId as Id<"events"> }
            : { kind: scopeKind as "season" | "annual" },
        benefits: benefits.split("\n"),
        commitments: commitments.split("\n"),
      });
      onDone();
    } catch {
      setError("Couldn't save that package — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <TextField label="Name" value={name} onChangeText={setName} placeholder="LTN Gold" />
      <TextField
        label="Tier rank"
        value={tierRank}
        onChangeText={setTierRank}
        keyboardType="number-pad"
        placeholder="1"
      />
      <Select
        label="Audience"
        value={audience}
        options={AUDIENCE_OPTIONS}
        onChange={(v) => setAudience(v as typeof audience)}
      />
      <Select
        label="Billing"
        value={pricingKind}
        options={PRICING_KIND_OPTIONS}
        onChange={(v) => setPricingKind(v as typeof pricingKind)}
      />
      <TextField
        label="Price (USD)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        placeholder="5000.00"
      />
      <Select
        label="Attaches to"
        value={scopeKind}
        options={SCOPE_KIND_OPTIONS}
        onChange={(v) => setScopeKind(v as typeof scopeKind)}
      />
      {scopeKind === "event" ? (
        <Select
          label="Event"
          value={eventId}
          options={eventOptions}
          onChange={setEventId}
          placeholder="Choose an event…"
        />
      ) : null}
      <TextField
        label="Benefits (one per line)"
        value={benefits}
        onChangeText={setBenefits}
        placeholder={"Logo on flyers\nSunday announcement"}
        multiline
      />
      <TextField
        label="What we commit to (one per line)"
        value={commitments}
        onChangeText={setCommitments}
        placeholder={"Stage mention at LTN\nJoint social post"}
        multiline
      />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <Button title={existing ? "Save changes" : "Create package"} onPress={submit} loading={saving} />
    </Card>
  );
}
