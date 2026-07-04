/**
 * Guest list — everyone who RSVP'd or bought tickets, with client-side
 * search. Ticket buyers get a small 🎟 marker next to their name.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Card, TextField, type BadgeTone } from "../../ui";

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  going: { label: "Going", tone: "success" },
  maybe: { label: "Maybe", tone: "warn" },
  not_going: { label: "Can't go", tone: "neutral" },
};

export function GuestListCard({ eventId }: { eventId: Id<"events"> }) {
  const rsvps = useQuery(api.ticketing.listRsvpsAdmin, { eventId });
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = rsvps ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q),
    );
  }, [rsvps, search]);

  if (rsvps === undefined) {
    return (
      <Card>
        <Text className="text-base text-muted">Loading guests…</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text className="mb-3 text-sm font-semibold text-ink">
        {rsvps.length} guest{rsvps.length === 1 ? "" : "s"}
      </Text>
      {rsvps.length > 0 ? (
        <TextField
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name or email…"
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      {rsvps.length === 0 ? (
        <Text className="py-2 text-base text-muted">
          No RSVPs yet — share the page link to start filling the room.
        </Text>
      ) : filtered.length === 0 ? (
        <Text className="py-2 text-base text-muted">
          No guests match "{search.trim()}".
        </Text>
      ) : (
        filtered.map((r, i) => {
          const meta = STATUS_META[r.status] ?? STATUS_META.maybe;
          return (
            <View
              key={r.id}
              className={`flex-row items-center gap-3 py-2.5 ${
                i === 0 ? "" : "border-t border-border"
              }`}
            >
              <View className="flex-1">
                <Text className="text-base font-medium text-ink" numberOfLines={1}>
                  {r.source === "ticket" ? "🎟 " : ""}
                  {r.name}
                </Text>
                <Text className="text-sm text-muted" numberOfLines={1}>
                  {r.email}
                </Text>
              </View>
              <Badge label={meta.label} tone={meta.tone} />
            </View>
          );
        })
      )}
    </Card>
  );
}
