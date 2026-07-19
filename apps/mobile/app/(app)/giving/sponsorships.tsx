/**
 * GIVING · Sponsorships — the institutional-giving pipeline (PRD §4): prospect
 * → pitched → committed → active, with lapsed/declined collapsed under a
 * "closed" section. Central lens only (mirrors the backend's
 * `requireGivingView(ctx, "central")` gate — see `schema/sponsorships.ts`), so
 * a chapter-only caller sees an access-needed state instead.
 *
 * A manage-capability holder can open "New sponsorship" (donor + package
 * picker) and jump to the Packages management screen. Tapping a row opens the
 * agreement detail (`sponsorship/[id].tsx`).
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text, Pressable } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Narrow,
  Screen,
  SectionHeader,
  Select,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";

const STAGE_ORDER = ["prospect", "pitched", "committed", "active"] as const;
const CLOSED_STATUSES = ["lapsed", "declined"] as const;

const STAGE_LABEL: Record<string, string> = {
  prospect: "Prospect",
  pitched: "Pitched",
  committed: "Committed",
  active: "Active",
  lapsed: "Lapsed",
  declined: "Declined",
};

export function sponsorshipStatusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "committed") return "info";
  if (status === "pitched") return "accent";
  return "neutral"; // prospect / lapsed / declined
}

type SponsorshipRow = {
  sponsorship: Doc<"sponsorships">;
  donor: Doc<"donors"> | null;
  package: Doc<"sponsorPackages"> | null;
};

export default function SponsorshipsScreen() {
  // WP-S follow-up: the app's chapter lens — see `useGivingScope`'s own doc.
  // Sponsorships is inherently central-scoped data (no per-chapter
  // equivalent — the org-wide institutional-giving pipeline), so wiring the
  // lens through here means it's only reachable while the switcher is at the
  // central desk, same as the central-only actions on the Finances
  // dashboard (`atCentralDesk`-gated "New budget"/"Milestone ladder") that
  // hide while peeking a chapter.
  const chapterId = useGivingScope();
  const access = useQuery(api.givingPlatform.myGivingAccess, { chapterId });

  if (access === undefined) return <Screen loading />;
  if (!access.canView || access.scope === null) {
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
  if (access.scope !== "central") {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Sponsorships is a central-lens desk"
            message="The sponsorship pipeline and package tiers are managed at the org level, not per chapter — switch to the Central desk to see them."
          />
        </Narrow>
      </Screen>
    );
  }
  return <SponsorshipsBody canManage={access.canManage} />;
}

function SponsorshipsBody({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const rows = useQuery(api.sponsorships.listSponsorships, {});
  const [showNew, setShowNew] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const byStatus = useMemo(() => {
    const grouped: Record<string, SponsorshipRow[]> = {};
    for (const row of rows ?? []) {
      (grouped[row.sponsorship.status] ??= []).push(row);
    }
    return grouped;
  }, [rows]);

  if (rows === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function openRow(id: Id<"sponsorships">) {
    router.navigate(`/giving/sponsorship/${id}` as never);
  }

  return (
    <Screen>
      <Narrow>
        <View className="mb-1 flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-muted">
            Central · Sponsorships
          </Text>
          {canManage ? (
            <Pressable onPress={() => router.navigate("/giving/packages" as never)}>
              <Text className="text-sm font-semibold text-accent">
                Manage packages
              </Text>
            </Pressable>
          ) : null}
        </View>

        {canManage ? (
          <View className="mt-3">
            <Button
              title={showNew ? "Cancel" : "New sponsorship"}
              icon={showNew ? undefined : "plus"}
              variant={showNew ? "secondary" : "primary"}
              onPress={() => setShowNew((v) => !v)}
            />
            {showNew ? (
              <View className="mt-3">
                <NewSponsorshipForm onDone={() => setShowNew(false)} />
              </View>
            ) : null}
          </View>
        ) : null}

        {STAGE_ORDER.map((stage) => (
          <StageSection
            key={stage}
            stage={stage}
            rows={byStatus[stage] ?? []}
            onOpen={openRow}
          />
        ))}

        <SectionHeader
          title="Closed"
          count={
            (byStatus.lapsed?.length ?? 0) + (byStatus.declined?.length ?? 0)
          }
          right={
            <Pressable onPress={() => setShowClosed((v) => !v)}>
              <Text className="text-xs font-semibold text-accent">
                {showClosed ? "Hide" : "Show"}
              </Text>
            </Pressable>
          }
        />
        {showClosed
          ? CLOSED_STATUSES.map((stage) => (
              <StageSection
                key={stage}
                stage={stage}
                rows={byStatus[stage] ?? []}
                onOpen={openRow}
                hideHeaderWhenEmpty
              />
            ))
          : null}
      </Narrow>
    </Screen>
  );
}

function StageSection({
  stage,
  rows,
  onOpen,
  hideHeaderWhenEmpty,
}: {
  stage: string;
  rows: SponsorshipRow[];
  onOpen: (id: Id<"sponsorships">) => void;
  hideHeaderWhenEmpty?: boolean;
}) {
  if (hideHeaderWhenEmpty && rows.length === 0) return null;
  return (
    <View>
      <SectionHeader title={STAGE_LABEL[stage] ?? stage} count={rows.length} />
      {rows.length === 0 ? (
        <EmptyState
          title={`No ${(STAGE_LABEL[stage] ?? stage).toLowerCase()} agreements`}
          message="Nothing here yet."
        />
      ) : (
        <View className="gap-2">
          {rows.map(({ sponsorship, donor, package: pkg }) => (
            <Pressable key={sponsorship._id} onPress={() => onOpen(sponsorship._id)}>
              <Card padding="md">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-base font-semibold text-ink" numberOfLines={1}>
                      {donor?.name ?? "Unknown org"}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {pkg?.name ?? "No package"}
                      {sponsorship.nextTouchpointAt
                        ? ` · Next touch ${new Date(
                            sponsorship.nextTouchpointAt,
                          ).toLocaleDateString()}`
                        : ""}
                    </Text>
                  </View>
                  <Badge
                    label={STAGE_LABEL[sponsorship.status] ?? sponsorship.status}
                    tone={sponsorshipStatusTone(sponsorship.status)}
                  />
                </View>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function NewSponsorshipForm({ onDone }: { onDone: () => void }) {
  const donors = useQuery(api.givingPlatform.listDonors, { scope: "central" });
  const packages = useQuery(api.sponsorships.listPackages, {});
  const upsertSponsorship = useMutation(api.sponsorships.upsertSponsorship);

  const [donorId, setDonorId] = useState<string | null>(null);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const donorOptions = (donors ?? [])
    .filter((d) => d.kind !== "individual")
    .map((d) => ({ value: d._id, label: `${d.name} (${d.kind})` }));
  const packageOptions = (packages ?? []).map((p) => ({
    value: p._id,
    label: p.active ? p.name : `${p.name} (inactive)`,
  }));

  async function submit() {
    setError(null);
    if (!donorId || !packageId) {
      setError("Choose an org donor and a package.");
      return;
    }
    setSaving(true);
    try {
      await upsertSponsorship({
        donorId: donorId as Id<"donors">,
        packageId: packageId as Id<"sponsorPackages">,
      });
      onDone();
    } catch {
      setError("Couldn't create that sponsorship — check your access and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      {donorOptions.length === 0 ? (
        <Text className="mb-3 text-sm text-muted">
          No church/business/foundation donors yet — add one from the Donors
          tab first.
        </Text>
      ) : (
        <Select
          label="Organization"
          value={donorId}
          options={donorOptions}
          onChange={setDonorId}
          placeholder="Choose an org donor…"
        />
      )}
      <Select
        label="Package"
        value={packageId}
        options={packageOptions}
        onChange={setPackageId}
        placeholder="Choose a package…"
      />
      {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}
      <Button title="Create sponsorship" onPress={submit} loading={saving} />
    </Card>
  );
}
