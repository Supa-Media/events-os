/**
 * A live, guest's-eye preview of the public RSVP page, shown at the top of the
 * Design phase. It reframes the whole phase: you're shaping a page people will
 * see, not filling in a form. Cover, title, tagline and venue bind to the edit
 * buffers as you type, so every change lands somewhere visible.
 */
import { Image, Text, View } from "react-native";
import { Icon } from "../../ui";
import { colors } from "../../../lib/theme";

export function EventPagePreview({
  name,
  tagline,
  venue,
  dateLabel,
  coverUrl,
}: {
  name: string;
  tagline: string;
  venue: string;
  dateLabel: string | null;
  coverUrl: string | null;
}) {
  const hasVenue = venue.trim().length > 0;
  const hasTagline = tagline.trim().length > 0;

  return (
    <View className="mb-4 overflow-hidden rounded-2xl border border-border bg-raised shadow-card">
      {/* Cover — banner ratio, capped so it stays a glance (not a hero) on
          wide desktop widths. */}
      <View
        className="relative bg-sunken"
        style={{ aspectRatio: 16 / 9, maxHeight: 190 }}
      >
        {coverUrl ? (
          <Image
            source={{ uri: coverUrl }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="cover"
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-1.5">
            <Icon name="image" size={20} color={colors.faint} />
            <Text className="text-xs font-semibold text-faint">
              No cover yet
            </Text>
          </View>
        )}
        <View
          className="absolute right-2.5 top-2.5 rounded-pill px-2.5 py-1"
          style={{ backgroundColor: "rgba(33,9,9,0.45)" }}
        >
          <Text className="text-2xs font-bold uppercase tracking-wider text-white">
            Guest preview
          </Text>
        </View>
      </View>

      {/* Copy */}
      <View className="px-4 py-3.5">
        <Text
          className="font-display text-2xl text-ink"
          numberOfLines={1}
          style={{ letterSpacing: -0.3 }}
        >
          {name}
        </Text>
        <Text
          className={`mt-1 text-sm italic ${hasTagline ? "text-ink" : "text-faint"}`}
          numberOfLines={2}
        >
          {hasTagline ? tagline : "One line that sells the night"}
        </Text>

        <View className="mt-2.5 flex-row flex-wrap items-center gap-x-4 gap-y-1.5">
          <View className="flex-row items-center gap-1.5">
            <Icon name="map-pin" size={13} color={colors.muted} />
            <Text
              className={`text-xs font-semibold ${hasVenue ? "text-muted" : "text-faint"}`}
            >
              {hasVenue ? venue : "Add a venue"}
            </Text>
          </View>
          {dateLabel ? (
            <View className="flex-row items-center gap-1.5">
              <Icon name="calendar" size={13} color={colors.muted} />
              <Text className="text-xs font-semibold text-muted">
                {dateLabel}
              </Text>
            </View>
          ) : null}
        </View>

        <View className="mt-3.5 flex-row items-center gap-2.5">
          <View className="rounded-pill bg-accent px-4 py-1.5">
            <Text className="text-xs font-bold text-white">RSVP</Text>
          </View>
          <Text className="text-xs font-semibold text-faint">
            Be the first to RSVP
          </Text>
        </View>
      </View>
    </View>
  );
}
