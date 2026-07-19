/**
 * GIVING · Territories — the launch-map admin desk (giving-territories
 * addendum). Lists every territory (prospect/raising/launched), a create/edit
 * form, and stage transitions. Creating a territory CREATES a real (inactive)
 * "shadow chapter" behind the scenes; launching FLIPS that chapter live and
 * provisions its banking — so there's no chapter picker here anymore.
 *
 * CENTRAL-only: the backend gates every mutation + the list read on
 * `giving.manage`/`giving.view` at central (`territories.ts`), unlike
 * Donors/Backers, which are per-chapter. A chapter-scoped giving holder (or a
 * central view-only holder) sees an access-needed state here.
 *
 * Public rendering of what this screen edits lives at `/give` + `/give/<slug>`
 * (`apps/convex/lib/givePage.ts`).
 */
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  View,
  Text,
  Pressable,
  ScrollView,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { formatCents } from "@events-os/shared";
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";
import { useGivingScope } from "../../../lib/useGivingScope";

type TerritoryStage = "prospect" | "raising" | "launched";

type TerritoryRow = {
  _id: Id<"territories">;
  chapterId: Id<"chapters">;
  name: string;
  region: string;
  lat: number;
  lng: number;
  slug: string;
  stage: TerritoryStage;
  targetBackers: number;
  story: string | null;
  publiclyVisible: boolean;
  launchFundCents: number;
  launchFundTargetCents: number;
  launchedAt: number | null;
  backerCount: number;
  chapterIsActive: boolean;
};

function stageTone(stage: TerritoryStage): BadgeTone {
  if (stage === "launched") return "success";
  if (stage === "raising") return "warn";
  return "neutral";
}

export default function TerritoriesScreen() {
  // WP-S follow-up: the app's chapter lens — see `useGivingScope`'s own doc.
  // Territories is CENTRAL-only (like Sponsorships/Packages), so wiring the
  // lens through means it's reachable only while at the central desk.
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
  if (access.scope !== "central" || !access.canManage) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Territories are managed centrally"
            message="The launch map is a central surface — ask a development director to make changes here."
          />
        </Narrow>
      </Screen>
    );
  }
  return <TerritoriesBody />;
}

function TerritoriesBody() {
  const territories = useQuery(api.territories.listTerritoriesAdmin, {}) as
    | TerritoryRow[]
    | undefined;

  const [editing, setEditing] = useState<Id<"territories"> | "new" | null>(
    null,
  );

  const editingTerritory = useMemo(
    () =>
      editing && editing !== "new"
        ? territories?.find((t) => t._id === editing) ?? null
        : null,
    [editing, territories],
  );

  if (territories === undefined) {
    return (
      <View className="items-center justify-center py-16">
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Narrow>
        <View className="mb-4 flex-row items-center justify-between">
          <SectionHeader title={`Territories (${territories.length})`} />
          <Button
            title="New territory"
            size="sm"
            icon="plus"
            onPress={() => setEditing("new")}
          />
        </View>

        {editing ? (
          <TerritoryForm
            territory={editingTerritory}
            onDone={() => setEditing(null)}
          />
        ) : territories.length === 0 ? (
          <EmptyState
            title="No territories yet"
            message="Add a place raising backers to put it on the /give map. A shadow chapter is created behind the scenes."
          />
        ) : (
          <View className="gap-2">
            {territories.map((tr) => (
              <Pressable key={tr._id} onPress={() => setEditing(tr._id)}>
                <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                  <View className="flex-1 pr-3">
                    <Text
                      className="text-base font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {tr.name}, {tr.region}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      /give/{tr.slug} ·{" "}
                      {tr.publiclyVisible ? "visible" : "hidden"}
                    </Text>
                    {tr.stage !== "launched" ? (
                      <Text className="text-xs text-muted" numberOfLines={1}>
                        Launch fund: {formatCents(tr.launchFundCents)} of{" "}
                        {formatCents(tr.launchFundTargetCents)}
                      </Text>
                    ) : null}
                  </View>
                  <View className="items-end gap-1">
                    <Text className="text-sm font-semibold text-ink">
                      {tr.backerCount} / {tr.targetBackers}
                    </Text>
                    <Badge label={tr.stage} tone={stageTone(tr.stage)} />
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </Narrow>
    </Screen>
  );
}

function slugify(name: string, region: string): string {
  return `${name}-${region}`
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Dollars string → integer cents, or undefined when blank/invalid. */
function dollarsToCents(v: string): number | undefined {
  const n = Number(v.trim().replace(/^\$/, ""));
  if (!v.trim() || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function TerritoryForm({
  territory,
  onDone,
}: {
  territory: TerritoryRow | null;
  onDone: () => void;
}) {
  const save = useMutation(api.territories.saveTerritory);
  const [name, setName] = useState(territory?.name ?? "");
  const [region, setRegion] = useState(territory?.region ?? "");
  const [lat, setLat] = useState(territory ? String(territory.lat) : "");
  const [lng, setLng] = useState(territory ? String(territory.lng) : "");
  const [slug, setSlug] = useState(territory?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!territory);
  const [targetBackers, setTargetBackers] = useState(
    territory ? String(territory.targetBackers) : "",
  );
  const [story, setStory] = useState(territory?.story ?? "");
  const [publiclyVisible, setPubliclyVisible] = useState(
    territory?.publiclyVisible ?? false,
  );
  const [launchFundTarget, setLaunchFundTarget] = useState(
    territory ? String(territory.launchFundTargetCents / 100) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onNameOrRegionChange(nextName: string, nextRegion: string) {
    if (!slugTouched) setSlug(slugify(nextName, nextRegion));
  }

  async function submit() {
    setError(null);
    const latNum = Number(lat);
    const lngNum = Number(lng);
    const targetNum = targetBackers.trim()
      ? Math.round(Number(targetBackers))
      : undefined;
    if (!name.trim() || !region.trim()) {
      setError("Name and region are required.");
      return;
    }
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      setError("Latitude and longitude must be numbers.");
      return;
    }
    setBusy(true);
    try {
      await save({
        territoryId: territory?._id,
        name: name.trim(),
        region: region.trim(),
        lat: latNum,
        lng: lngNum,
        slug: slug.trim().toLowerCase(),
        ...(targetNum !== undefined ? { targetBackers: targetNum } : {}),
        story: story.trim() || undefined,
        publiclyVisible,
        ...(dollarsToCents(launchFundTarget) !== undefined
          ? { launchFundTargetCents: dollarsToCents(launchFundTarget) }
          : {}),
      });
      onDone();
    } catch {
      setError(
        "Couldn't save — check the slug is unique (across territories AND chapters) and lat/lng are in range.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView>
      <Card>
        <SectionHeader title={territory ? "Edit territory" : "New territory"} />
        <TextField
          label="Territory name"
          value={name}
          onChangeText={(v) => {
            setName(v);
            onNameOrRegionChange(v, region);
          }}
          placeholder="Queens"
        />
        <TextField
          label="Region"
          value={region}
          onChangeText={(v) => {
            setRegion(v);
            onNameOrRegionChange(name, v);
          }}
          placeholder="NY"
        />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextField
              label="Latitude"
              value={lat}
              onChangeText={setLat}
              placeholder="40.7282"
              keyboardType="numbers-and-punctuation"
            />
          </View>
          <View className="flex-1">
            <TextField
              label="Longitude"
              value={lng}
              onChangeText={setLng}
              placeholder="-73.7949"
              keyboardType="numbers-and-punctuation"
            />
          </View>
        </View>
        <TextField
          label="Slug (/give/…)"
          value={slug}
          onChangeText={(v) => {
            setSlugTouched(true);
            setSlug(v);
          }}
          placeholder="queens-ny"
          autoCapitalize="none"
        />
        <TextField
          label="Target backers"
          value={targetBackers}
          onChangeText={setTargetBackers}
          placeholder="Defaults to the ladder's first rung"
          keyboardType="number-pad"
        />
        <TextField
          label="Launch fund goal ($)"
          value={launchFundTarget}
          onChangeText={setLaunchFundTarget}
          placeholder="Defaults to the launch-budget total"
          keyboardType="numbers-and-punctuation"
        />
        <TextField
          label="Story"
          value={story}
          onChangeText={setStory}
          multiline
          numberOfLines={4}
          placeholder="What's the story of this territory so far?"
        />
        <Pressable
          className="mb-3 flex-row items-center gap-2"
          onPress={() => setPubliclyVisible((v) => !v)}
        >
          <View
            className={`h-5 w-5 items-center justify-center rounded border ${
              publiclyVisible
                ? "border-accent bg-accent"
                : "border-border-strong bg-raised"
            }`}
          >
            {publiclyVisible ? (
              <Icon name="check" size={13} color="#fff" />
            ) : null}
          </View>
          <Text className="text-sm text-ink">
            Visible on the public /give map
          </Text>
        </Pressable>

        {error ? (
          <Text className="mb-2 text-sm text-danger">{error}</Text>
        ) : null}

        <View className="flex-row gap-2">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
          <Button title="Save" onPress={submit} loading={busy} />
        </View>
      </Card>

      {territory ? <StageSection territory={territory} /> : null}
    </ScrollView>
  );
}

function StageSection({ territory }: { territory: TerritoryRow }) {
  const setStage = useMutation(api.territories.setTerritoryStage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launched = territory.stage === "launched";

  async function transition(stage: TerritoryStage) {
    setError(null);
    setBusy(true);
    try {
      await setStage({ territoryId: territory._id, stage });
    } catch {
      setError("Couldn't update stage.");
    } finally {
      setBusy(false);
    }
  }

  function confirmLaunch() {
    Alert.alert(
      `Launch ${territory.name}?`,
      "This activates the shadow chapter (it goes live) and provisions its banking. Launching is permanent — a territory can't go back to prospect or raising.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Launch",
          style: "destructive",
          onPress: () => void transition("launched"),
        },
      ],
    );
  }

  return (
    <View className="mt-4">
      <SectionHeader title="Stage" />
      <Card>
        <Text className="mb-3 text-sm text-muted">
          Current:{" "}
          <Text className="font-semibold text-ink">{territory.stage}</Text>
          {"  ·  "}
          Chapter: {territory.chapterIsActive ? "active" : "inactive (shadow)"}
        </Text>
        <View className="mb-3 flex-row flex-wrap gap-2">
          <Button
            title="Prospect"
            size="sm"
            variant={territory.stage === "prospect" ? "primary" : "secondary"}
            onPress={() => transition("prospect")}
            disabled={busy || launched}
          />
          <Button
            title="Raising"
            size="sm"
            variant={territory.stage === "raising" ? "primary" : "secondary"}
            onPress={() => transition("raising")}
            disabled={busy || launched}
          />
          <Button
            title="Launch"
            size="sm"
            variant={launched ? "primary" : "secondary"}
            onPress={confirmLaunch}
            disabled={busy || launched}
          />
        </View>

        {/* Launch pot — display only; accrual/freeze wiring lands next PR. */}
        <View className="rounded-lg border border-border bg-sunken p-3">
          <Text className="text-xs text-muted">Launch fund</Text>
          <Text className="text-sm font-semibold text-ink">
            {formatCents(territory.launchFundCents)} of{" "}
            {formatCents(territory.launchFundTargetCents)}
          </Text>
        </View>

        {error ? (
          <Text className="mt-2 text-sm text-danger">{error}</Text>
        ) : null}
      </Card>
    </View>
  );
}
