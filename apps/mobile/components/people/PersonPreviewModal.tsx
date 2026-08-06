/**
 * PersonPreviewModal — a lightweight, read-only "who is this?" modal: name,
 * photo, role/company, contact links (mailto:/tel:), and event history.
 *
 * Shared by every "tap a name, see who they are" surface in the app instead
 * of navigating away: `CrewSections.tsx`'s crew-roster name tap and
 * `MentionText.tsx`'s `@mention` tap both open this. Extracted from
 * CrewSections' original `PersonDetail`/`PersonDetailBody`/`ContactLink`
 * (the two shared the exact same `api.people.get` +
 * `api.engagements.historyForPerson` queries) rather than writing a third
 * near-duplicate "read-only contact card" modal.
 *
 * Read-only by design — editing a person's info stays on the People tab's
 * own heavier, editable `PersonDetail`/`PersonDetailBody` sheet. This modal's
 * one escape hatch is "View full profile", which closes the modal and
 * navigates there.
 */
import { ScrollView, View, Text, Pressable, Modal, Linking } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Avatar, Icon, Badge } from "../ui";
import { colors } from "../../lib/theme";
import { formatDate } from "../../lib/format";

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

function PersonPreviewModalBody({
  personId,
  name,
  onClose,
}: {
  personId: string;
  name: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const person = useQuery(api.people.get, {
    personId: personId as Id<"people">,
  });
  const history = useQuery(api.engagements.historyForPerson, {
    personId: personId as Id<"people">,
  });
  const email = person?.email ?? null;
  const phone = person?.phone ?? null;
  const subtitle = [person?.role, person?.company].filter(Boolean).join(" · ");

  return (
    <>
      <View className="flex-row items-center justify-between border-b border-border px-5 py-4">
        <View className="flex-1 flex-row items-center gap-3">
          <Avatar name={name || "?"} size={36} uri={person?.imageUrl ?? null} />
          <View className="min-w-0 flex-1">
            <Text className="font-display text-lg text-ink" numberOfLines={1}>
              {name || "Untitled"}
            </Text>
            {subtitle ? (
              <Text className="text-xs text-muted" numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
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

      <Pressable
        onPress={() => {
          onClose();
          router.push(`/people?openId=${personId}` as never);
        }}
        accessibilityRole="button"
        className="flex-row items-center justify-center gap-1 border-t border-border px-5 py-3 active:opacity-70 web:hover:opacity-90"
      >
        <Text className="text-sm font-medium text-accent">View full profile</Text>
        <Icon name="chevron-right" size={13} color={colors.accent} />
      </Pressable>
    </>
  );
}

/** Read-only contact + engagement history preview, opened in place of
 *  navigating away when a person's name is tapped. */
export function PersonPreviewModal({
  personId,
  name,
  onClose,
}: {
  personId: string | null;
  name: string;
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
            <PersonPreviewModalBody
              personId={personId}
              name={name}
              onClose={onClose}
            />
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
