/**
 * PersonDetailModal — shared, read-only person card (contact info + event
 * history) for any surface that just needs "who is this" without leaving
 * the page. Modeled on `CrewSections.tsx`'s private `PersonDetail`/
 * `PersonDetailBody` (same queries, same chrome), but public and reusable
 * since it isn't tied to a specific feature's own table.
 *
 * The only way out to the full People-tab profile (edit form, full history)
 * is the explicit "View full profile" button below — everything else here
 * is look-don't-touch.
 */
import { Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar, Badge, Button, Icon } from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";
import { personProfileRoute } from "./personProfileRoute.logic";

export function PersonDetailModal({
  personId,
  onClose,
}: {
  personId: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={personId !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        className="flex-1 items-center justify-center bg-ink/30 p-6"
      >
        <Pressable
          onPress={() => {}}
          className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-pop"
        >
          {personId ? (
            <PersonDetailBody personId={personId} onClose={onClose} />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function PersonDetailBody({
  personId,
  onClose,
}: {
  personId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const person = useQuery(api.people.get, {
    personId: personId as Id<"people">,
  });
  const history = useQuery(api.engagements.historyForPerson, {
    personId: personId as Id<"people">,
  });
  const name = person?.name ?? "";
  const email = person?.email ?? null;
  const phone = person?.phone ?? null;

  return (
    <>
      <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
        <View className="flex-1 flex-row items-center gap-3">
          <Avatar name={name || "?"} size={36} />
          <Text className="font-display text-lg text-ink" numberOfLines={1}>
            {person === undefined ? "Loading…" : name || "Untitled"}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={8} className="rounded-md p-1">
          <Icon name="x" size={18} color={colors.muted} />
        </Pressable>
      </View>

      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 20 }}>
        {email || phone ? (
          <View className="mb-5 gap-2">
            {email ? (
              <ContactLink icon="mail" label={email} url={`mailto:${email}`} />
            ) : null}
            {phone ? (
              <ContactLink icon="phone" label={phone} url={`tel:${phone}`} />
            ) : null}
          </View>
        ) : null}

        <Text className="mb-2 text-2xs font-bold uppercase tracking-wider text-muted">
          Event history
        </Text>
        {history === undefined ? (
          <Text className="text-sm text-muted">Loading history…</Text>
        ) : history.count === 0 ? (
          <Text className="text-sm text-muted">No event history yet.</Text>
        ) : (
          <>
            <Text className="mb-2 text-sm font-semibold text-muted">
              {history.count} {history.count === 1 ? "event" : "events"} ·{" "}
              {history.volunteerCount} volunteer · {history.paidCount} paid · $
              {history.paidTotal} paid total
            </Text>
            <View className="gap-2">
              {history.history.map((h) => (
                <View
                  key={h.engagementId}
                  className="gap-1 rounded-lg border border-border p-3"
                >
                  <View className="flex-row items-center justify-between gap-2">
                    <Text
                      className="flex-1 text-sm font-bold text-ink"
                      numberOfLines={1}
                    >
                      {h.eventName}
                    </Text>
                    <Badge
                      label={h.type === "paid" ? "Paid" : "Volunteer"}
                      tone={h.type === "paid" ? "accent" : "neutral"}
                    />
                  </View>
                  <Text className="text-xs text-muted">
                    {formatDate(h.eventDate)}
                    {h.service ? ` · ${h.service}` : ""}
                    {h.type === "paid"
                      ? ` · $${h.amountUsd}${h.paymentStatus ? ` (${h.paymentStatus})` : ""}`
                      : ""}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>

      <View className="border-t border-border px-5 py-3">
        <Button
          title="View full profile"
          variant="secondary"
          icon="external-link"
          onPress={() => {
            onClose();
            router.push(personProfileRoute(personId) as any);
          }}
        />
      </View>
    </>
  );
}

function ContactLink({
  icon,
  label,
  url,
}: {
  icon: "mail" | "phone";
  label: string;
  url: string;
}) {
  return (
    <Pressable
      onPress={() => Linking.openURL(url)}
      className="flex-row items-center gap-2 active:opacity-70"
    >
      <Icon name={icon} size={15} color={colors.muted} />
      <Text className="text-sm text-info">{label}</Text>
    </Pressable>
  );
}
