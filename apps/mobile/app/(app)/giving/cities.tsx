/**
 * GIVING · Cities — the City Launch map's admin desk (F-6 P3). Lists every
 * `cityCampaigns` row (prospect/raising/launched), a create/edit form, and
 * status transitions (launching a city requires picking the chapter it
 * became). This is a CENTRAL-only surface — the backend gates every mutation
 * + the list read on `giving.manage` at central (`cityCampaigns.ts`), unlike
 * Donors/Backers, which are per-chapter. A chapter-scoped giving holder (or a
 * central view-only holder) sees an access-needed state here even though they
 * can see the rest of the desk.
 *
 * Public rendering of what this screen edits lives at `/give` +
 * `/give/<slug>` (`apps/convex/lib/givePage.ts`).
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, View, Text, Pressable, ScrollView } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
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
  Select,
  TextField,
} from "../../../components/ui";
import { colors } from "../../../lib/theme";

type CampaignStatus = "prospect" | "raising" | "launched";

type CampaignRow = {
  _id: Id<"cityCampaigns">;
  name: string;
  region: string;
  lat: number;
  lng: number;
  slug: string;
  status: CampaignStatus;
  chapterId: Id<"chapters"> | null;
  targetBackers: number;
  story: string | null;
  publiclyVisible: boolean;
  backerCount: number;
};

function statusTone(status: CampaignStatus): BadgeTone {
  if (status === "launched") return "success";
  if (status === "raising") return "warn";
  return "neutral";
}

export default function CitiesScreen() {
  const access = useQuery(api.givingPlatform.myGivingAccess, {});

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
            title="Cities is managed centrally"
            message="The City Launch map is a central surface — ask a development director to make changes here."
          />
        </Narrow>
      </Screen>
    );
  }
  return <CitiesBody />;
}

function CitiesBody() {
  const campaigns = useQuery(api.cityCampaigns.listCampaignsAdmin, {}) as
    | CampaignRow[]
    | undefined;
  const chapters = useQuery(api.profiles.listChapters, {}) as
    | { _id: Id<"chapters">; name: string }[]
    | undefined;

  const [editing, setEditing] = useState<Id<"cityCampaigns"> | "new" | null>(
    null,
  );

  const editingCampaign = useMemo(
    () =>
      editing && editing !== "new"
        ? campaigns?.find((c) => c._id === editing) ?? null
        : null,
    [editing, campaigns],
  );

  if (campaigns === undefined) {
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
          <SectionHeader title={`Cities (${campaigns.length})`} />
          <Button
            title="New city"
            size="sm"
            icon="plus"
            onPress={() => setEditing("new")}
          />
        </View>

        {editing ? (
          <CampaignForm
            campaign={editingCampaign}
            chapters={chapters ?? []}
            onDone={() => setEditing(null)}
          />
        ) : campaigns.length === 0 ? (
          <EmptyState
            title="No cities yet"
            message="Add a potential chapter to put it on the /give map."
          />
        ) : (
          <View className="gap-2">
            {campaigns.map((c) => (
              <Pressable key={c._id} onPress={() => setEditing(c._id)}>
                <View className="flex-row items-center justify-between rounded-lg border border-border bg-raised p-3">
                  <View className="flex-1 pr-3">
                    <Text
                      className="text-base font-semibold text-ink"
                      numberOfLines={1}
                    >
                      {c.name}, {c.region}
                    </Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      /give/{c.slug} · {c.publiclyVisible ? "visible" : "hidden"}
                    </Text>
                  </View>
                  <View className="items-end gap-1">
                    <Text className="text-sm font-semibold text-ink">
                      {c.backerCount} / {c.targetBackers}
                    </Text>
                    <Badge label={c.status} tone={statusTone(c.status)} />
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

function CampaignForm({
  campaign,
  chapters,
  onDone,
}: {
  campaign: CampaignRow | null;
  chapters: { _id: Id<"chapters">; name: string }[];
  onDone: () => void;
}) {
  const save = useMutation(api.cityCampaigns.saveCampaign);
  const [name, setName] = useState(campaign?.name ?? "");
  const [region, setRegion] = useState(campaign?.region ?? "");
  const [lat, setLat] = useState(campaign ? String(campaign.lat) : "");
  const [lng, setLng] = useState(campaign ? String(campaign.lng) : "");
  const [slug, setSlug] = useState(campaign?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!campaign);
  const [targetBackers, setTargetBackers] = useState(
    campaign ? String(campaign.targetBackers) : "",
  );
  const [story, setStory] = useState(campaign?.story ?? "");
  const [publiclyVisible, setPubliclyVisible] = useState(
    campaign?.publiclyVisible ?? false,
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
        campaignId: campaign?._id,
        name: name.trim(),
        region: region.trim(),
        lat: latNum,
        lng: lngNum,
        slug: slug.trim().toLowerCase(),
        ...(targetNum !== undefined ? { targetBackers: targetNum } : {}),
        story: story.trim() || undefined,
        publiclyVisible,
      });
      onDone();
    } catch {
      setError(
        "Couldn't save — check the slug is unique and lat/lng are in range.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView>
      <Card>
        <SectionHeader title={campaign ? "Edit city" : "New city"} />
        <TextField
          label="City name"
          value={name}
          onChangeText={(v) => {
            setName(v);
            onNameOrRegionChange(v, region);
          }}
          placeholder="Columbus"
        />
        <TextField
          label="Region"
          value={region}
          onChangeText={(v) => {
            setRegion(v);
            onNameOrRegionChange(name, v);
          }}
          placeholder="OH"
        />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <TextField
              label="Latitude"
              value={lat}
              onChangeText={setLat}
              placeholder="39.9612"
              keyboardType="numbers-and-punctuation"
            />
          </View>
          <View className="flex-1">
            <TextField
              label="Longitude"
              value={lng}
              onChangeText={setLng}
              placeholder="-82.9988"
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
          placeholder="columbus-oh"
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
          label="Story"
          value={story}
          onChangeText={setStory}
          multiline
          numberOfLines={4}
          placeholder="What's the story of this city so far?"
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
          <Text className="text-sm text-ink">Visible on the public /give map</Text>
        </Pressable>

        {error ? <Text className="mb-2 text-sm text-danger">{error}</Text> : null}

        <View className="flex-row gap-2">
          <Button title="Cancel" variant="secondary" onPress={onDone} />
          <Button title="Save" onPress={submit} loading={busy} />
        </View>
      </Card>

      {campaign ? (
        <StatusSection campaign={campaign} chapters={chapters} />
      ) : null}
    </ScrollView>
  );
}

function StatusSection({
  campaign,
  chapters,
}: {
  campaign: CampaignRow;
  chapters: { _id: Id<"chapters">; name: string }[];
}) {
  const setStatus = useMutation(api.cityCampaigns.setCampaignStatus);
  const [chapterId, setChapterId] = useState<string | null>(
    campaign.chapterId,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transition(status: CampaignStatus) {
    setError(null);
    if (status === "launched" && !chapterId) {
      setError("Pick the chapter this city became first.");
      return;
    }
    setBusy(true);
    try {
      await setStatus({
        campaignId: campaign._id,
        status,
        ...(status === "launched"
          ? { chapterId: chapterId as Id<"chapters"> }
          : {}),
      });
    } catch {
      setError("Couldn't update status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="mt-4">
      <SectionHeader title="Status" />
      <Card>
        <Text className="mb-3 text-sm text-muted">
          Current: <Text className="font-semibold text-ink">{campaign.status}</Text>
        </Text>
        <View className="mb-3 flex-row flex-wrap gap-2">
          <Button
            title="Prospect"
            size="sm"
            variant={campaign.status === "prospect" ? "primary" : "secondary"}
            onPress={() => transition("prospect")}
            disabled={busy}
          />
          <Button
            title="Raising"
            size="sm"
            variant={campaign.status === "raising" ? "primary" : "secondary"}
            onPress={() => transition("raising")}
            disabled={busy}
          />
          <Button
            title="Launched"
            size="sm"
            variant={campaign.status === "launched" ? "primary" : "secondary"}
            onPress={() => transition("launched")}
            disabled={busy}
          />
        </View>
        <Select
          label="Chapter this city became (required to launch)"
          value={chapterId}
          onChange={setChapterId}
          options={chapters.map((c) => ({ value: c._id, label: c.name }))}
          placeholder="Pick a chapter…"
        />
        {error ? <Text className="text-sm text-danger">{error}</Text> : null}
      </Card>
    </View>
  );
}
