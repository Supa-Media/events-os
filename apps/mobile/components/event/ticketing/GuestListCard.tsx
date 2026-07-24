/**
 * Guest list — everyone who RSVP'd or bought tickets, with client-side
 * search plus a status/ticket-holder filter chip row. Ticket buyers get a
 * small 🎟 marker next to their name, with a "×N" suffix when a single guest
 * holds multiple admissions (e.g. a multi-ticket Givebutter buyer).
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@events-os/convex/_generated/api";
import type { Doc, Id } from "@events-os/convex/_generated/dataModel";
import { Badge, Card, Pill, TextField, type BadgeTone } from "../../ui";

const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  going: { label: "Going", tone: "success" },
  maybe: { label: "Maybe", tone: "warn" },
  not_going: { label: "Can't go", tone: "neutral" },
};

export type GuestFilter = "all" | "going" | "maybe" | "not_going" | "ticket";

const FILTERS: Array<{ value: GuestFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "not_going", label: "Can't go" },
  { value: "ticket", label: "🎟 Ticket holders" },
];

export function GuestListCard({
  eventId,
  page,
  initialFilter,
}: {
  eventId: Id<"events">;
  /** The page row, when available — used only to pick the DEFAULT filter:
   *  a tickets-only event (`rsvpEnabled === false`) opens on "Ticket
   *  holders" since that's the only guest source that mode's public page
   *  shows, mirroring `getPublicPage`'s own ticket-only guest filtering. */
  page?: Doc<"eventPages"> | null;
  /** Deep-link request from a parent (e.g. tapping a pulse-strip stat). A
   *  wrapper object, not a bare string: the parent mints a fresh object per
   *  tap, so re-tapping the SAME stat still re-applies the filter after the
   *  user has tapped other chips (an equal string would bail out of setState
   *  and the effect below would never re-fire). */
  initialFilter?: { value: GuestFilter };
}) {
  const rsvps = useQuery(api.ticketing.listRsvpsAdmin, { eventId });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<GuestFilter>(
    initialFilter?.value ?? (page?.rsvpEnabled === false ? "ticket" : "all"),
  );

  // Re-apply the deep-linked filter on every new request object, leaving the
  // user free to tap other chips in between.
  useEffect(() => {
    if (initialFilter !== undefined) setFilter(initialFilter.value);
  }, [initialFilter]);

  const filtered = useMemo(() => {
    const rows = rsvps ?? [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (
        filter === "ticket"
          ? !(r.source === "ticket" || r.ticketCount > 0)
          : filter !== "all" && r.status !== filter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        // Imported guests may have no email/phone — search only what exists.
        (r.email?.toLowerCase().includes(q) ?? false) ||
        (r.phone?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rsvps, search, filter]);

  if (rsvps === undefined) {
    return (
      <Card>
        <Text className="text-base text-muted">Loading guests…</Text>
      </Card>
    );
  }

  const filterActive = filter !== "all";

  return (
    <Card>
      <Text className="mb-3 text-sm font-semibold text-ink">
        {filterActive
          ? `${filtered.length} of ${rsvps.length} guest${rsvps.length === 1 ? "" : "s"}`
          : `${rsvps.length} guest${rsvps.length === 1 ? "" : "s"}`}
      </Text>
      {rsvps.length > 0 ? (
        <>
          <TextField
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name or email…"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View className="mb-3 mt-2 flex-row flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Pill
                key={f.value}
                label={f.label}
                selected={filter === f.value}
                onPress={() => setFilter(f.value)}
              />
            ))}
          </View>
        </>
      ) : null}

      {rsvps.length === 0 ? (
        <Text className="py-2 text-base text-muted">
          No RSVPs yet — share the page link to start filling the room.
        </Text>
      ) : filtered.length === 0 ? (
        <Text className="py-2 text-base text-muted">
          {/* Keep the typed query visible even when a chip is active, so the
              admin can tell a search typo from a filter miss. */}
          {filterActive
            ? search.trim()
              ? `No guests match "${search.trim()}" with this filter.`
              : "No guests match this filter."
            : `No guests match "${search.trim()}".`}
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
                  {r.source === "ticket" || r.ticketCount > 0
                    ? r.ticketCount > 1
                      ? `🎟 ×${r.ticketCount} `
                      : "🎟 "
                    : ""}
                  {r.name}
                </Text>
                {/* Email if we have one, else phone, else nothing — an
                    imported name-only guest shows just their name. */}
                {r.email || r.phone ? (
                  <Text className="text-sm text-muted" numberOfLines={1}>
                    {r.email ?? r.phone}
                  </Text>
                ) : null}
              </View>
              <Badge label={meta.label} tone={meta.tone} />
            </View>
          );
        })
      )}
    </Card>
  );
}
