/**
 * PEOPLE · Job listings · one posting — edit, open/close, publish, delete.
 *
 * The editor carries the whole role; this screen wraps it with the actions
 * that need a saved listing to act on: the DRAFT ⇄ LIVE toggle (which runs the
 * completeness check on the backend, so a half-written role can't go public),
 * and delete. Status (open/interviewing/not-open/filled) is edited inline in
 * the form like any other field.
 */
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useQuery, useMutation } from "convex/react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Narrow,
  Screen,
  SectionHeader,
} from "../../../../components/ui";
import { ListingEditor } from "./ListingEditor";

export default function ListingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const listingId = id as Id<"jobListings">;
  const access = useQuery(api.hiring.myHiringAccess, {});
  const listing = useQuery(api.listings.getListing, { listingId });

  if (access === undefined || listing === undefined) return <Screen loading />;
  if (!access.canManage) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            icon="lock"
            title="Manage access needed"
            message="You can view listings, but editing one needs hiring-desk edit access. Ask the People Director or the ED."
          />
        </Narrow>
      </Screen>
    );
  }
  if (listing === null) {
    return (
      <Screen>
        <Narrow>
          <EmptyState
            title="Listing not found"
            message="It may have been deleted."
          />
        </Narrow>
      </Screen>
    );
  }

  return (
    <Screen>
      <Narrow>
        <SectionHeader title={listing.title || "Untitled listing"} />
        <PublishControls listingId={listingId} published={listing.published} />
        <View className="pb-10">
          <ListingEditor existing={listing} onSaved={() => {}} />
          <View className="mt-4">
            <DeleteControl listingId={listingId} />
          </View>
        </View>
      </Narrow>
    </Screen>
  );
}

/** The one action that gates on completeness. Publishing a listing missing a
 *  required section throws a message naming what's left (`setListingPublished`);
 *  we surface it verbatim rather than pre-checking here, so the OS and the
 *  backend can't disagree about what "ready" means. */
function PublishControls({
  listingId,
  published,
}: {
  listingId: Id<"jobListings">;
  published: boolean;
}) {
  const setPublished = useMutation(api.listings.setListingPublished);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    setBusy(true);
    try {
      await setPublished({ listingId, published: !published });
    } catch (e) {
      setError(
        (e as { data?: { message?: string } })?.data?.message ??
          "Couldn't change this. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="md">
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          {published ? (
            <Badge label="Live on /team" tone="success" icon="globe" />
          ) : (
            <Badge label="Draft — not public" tone="warn" icon="edit-3" />
          )}
        </View>
      </View>
      <Text className="mb-3 text-xs text-muted">
        {published
          ? "This posting is showing on the public /team page right now."
          : "Publishing checks the listing is complete, then makes it public immediately."}
      </Text>
      {error ? (
        <Text className="mb-2 text-sm text-danger">{error}</Text>
      ) : null}
      <Button
        title={published ? "Unpublish (take off /team)" : "Publish to /team"}
        variant={published ? "secondary" : "primary"}
        onPress={toggle}
        loading={busy}
      />
    </Card>
  );
}

/** Delete is a two-tap: the first arms it, the second commits — there's no
 *  native confirm dialog, and a one-tap delete on a form this long is too easy
 *  to hit by accident. */
function DeleteControl({ listingId }: { listingId: Id<"jobListings"> }) {
  const remove = useMutation(api.listings.deleteListing);
  const router = useRouter();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onPress() {
    if (!arming) {
      setArming(true);
      return;
    }
    setBusy(true);
    try {
      await remove({ listingId });
      router.replace("/people/listings" as never);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="flex-row items-center gap-2">
      <Button
        title={arming ? "Tap again to delete" : "Delete listing"}
        variant="danger"
        icon="trash-2"
        onPress={onPress}
        loading={busy}
      />
      {arming ? (
        <Pressable
          className="flex-row items-center gap-1"
          onPress={() => setArming(false)}
        >
          <Icon name="x" size={12} color="#6b7280" />
          <Text className="text-xs text-muted">cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
