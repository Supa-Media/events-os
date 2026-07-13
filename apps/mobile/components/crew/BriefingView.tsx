import { ReactNode } from "react";
import { View, Text, Pressable, Linking, Platform } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@events-os/convex/_generated/api";
import { Card, Icon, OptionTag } from "../ui";
import { MarkdownView } from "../markdown";
import { colors } from "../../lib/theme";
import { formatDateTime } from "../../lib/format";
import { videoEmbedUrl } from "../../lib/videoEmbed";
import type { FunctionReturnType } from "convex/server";

/**
 * The shared, read-only volunteer-briefing presentation: the event header, the
 * team cards with their expectations (and inlined How-To docs), and who's on
 * each team. Extracted from the public `share/[id]` route so the authenticated
 * `/briefing` screen renders the SAME thing with no visual drift. No edit
 * controls, no pickers, no money — read-only by design.
 *
 * The row shapes are PROJECTIONS from the crew query (`status`/`callTime` come
 * off the volunteer engagement, not the people row), so they're derived from
 * the query's own return type — `events.publicCrew` and `events.myBriefing`
 * share one validator, so this type covers both.
 */
export type CrewBriefing = NonNullable<
  FunctionReturnType<typeof api.events.publicCrew>
>;
export type CrewPerson = CrewBriefing["teams"][number]["people"][number];
export type CrewExpectation =
  CrewBriefing["teams"][number]["expectations"][number];
type HowToDoc = NonNullable<CrewExpectation["doc"]>;

/** A pill button linking out to a doc URL or the public doc route. */
function DocLinkButton({
  icon,
  label,
  onPress,
}: {
  icon: "external-link" | "video" | "file-text";
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={label}
      className="flex-row items-center gap-2 self-start rounded-lg border border-border bg-surface px-3 py-2 active:opacity-80"
    >
      <Icon name={icon} size={14} color={colors.accent} />
      <Text className="text-sm font-semibold text-accent">{label}</Text>
    </Pressable>
  );
}

/**
 * Renders an expectation's attached How-To doc to actually EQUIP the team:
 *  - note  → the note's Markdown, rendered inline.
 *  - video → an inline player when the URL is embeddable (web); otherwise a
 *            "Watch video" link.
 *  - markdown → a link out to the full public doc page (`/d/<shareId>`).
 *  - link  → a link out to the external URL.
 */
function HowToDocView({ doc }: { doc: HowToDoc }) {
  const router = useRouter();

  if (doc.kind === "note") {
    return doc.body ? (
      <View className="mt-2 rounded-lg border border-border bg-surface px-3 py-2">
        <MarkdownView value={doc.body} />
      </View>
    ) : null;
  }

  if (doc.kind === "video") {
    const embed = videoEmbedUrl(doc.url);
    if (embed && Platform.OS === "web") {
      return (
        <View
          className="mt-2 w-full overflow-hidden rounded-lg border border-border bg-ink"
          style={{ aspectRatio: 16 / 9 }}
        >
          {/* RN-web renders this iframe directly in the DOM. */}
          <iframe
            src={embed}
            title={doc.title || "Video"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ width: "100%", height: "100%", border: "0" }}
          />
        </View>
      );
    }
    return (
      <View className="mt-2">
        <DocLinkButton
          icon="video"
          label="Watch video"
          onPress={() => doc.url && Linking.openURL(doc.url)}
        />
      </View>
    );
  }

  // markdown → open the full public doc page; link → open the external URL.
  return (
    <View className="mt-2">
      {doc.kind === "markdown" ? (
        <DocLinkButton
          icon="file-text"
          label={doc.title ? `Open: ${doc.title}` : "Open guide"}
          onPress={() => router.push(`/d/${doc.shareId}` as any)}
        />
      ) : (
        <DocLinkButton
          icon="external-link"
          label={doc.title || "Open link"}
          onPress={() => doc.url && Linking.openURL(doc.url)}
        />
      )}
    </View>
  );
}

/** A single bulleted expectation: check glyph + title + optional details + doc. */
function ExpectationRow({ item }: { item: CrewExpectation }) {
  return (
    <View className="flex-row gap-2">
      <View className="pt-0.5">
        <Icon name="check" size={15} color={colors.success} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-ink">{item.title}</Text>
        {item.details ? (
          <Text className="mt-0.5 text-sm text-muted">{item.details}</Text>
        ) : null}
        {item.doc ? <HowToDocView doc={item.doc} /> : null}
      </View>
    </View>
  );
}

/** First letters of the first two words of a name, uppercase. */
function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** A single person on a team, as a clean card: avatar + name + call time + status. */
function PersonCard({ person }: { person: CrewPerson }) {
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <View
        className="h-9 w-9 items-center justify-center rounded-pill"
        style={{ backgroundColor: colors.sunken }}
      >
        <Text className="text-xs font-bold text-muted">
          {initials(person.name)}
        </Text>
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-ink" numberOfLines={1}>
          {person.name}
        </Text>
        {person.callTime ? (
          <View className="mt-0.5 flex-row items-center gap-1">
            <Icon name="clock" size={12} color={colors.faint} />
            <Text className="text-sm text-muted">Call time {person.callTime}</Text>
          </View>
        ) : null}
      </View>
      {person.status ? (
        <View
          className="flex-row items-center gap-1 rounded-pill border border-border bg-sunken px-2 py-0.5"
          accessibilityLabel={`Status: ${person.status}`}
        >
          <View
            className="h-1.5 w-1.5 rounded-pill"
            style={{ backgroundColor: colors.muted }}
          />
          <Text className="text-xs font-semibold capitalize text-muted">
            {person.status}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** One team's card: label tag + people count, expectations, then people. */
function TeamCard({
  label,
  color,
  expectations,
  people,
}: {
  label: string;
  color?: string | null;
  expectations: CrewExpectation[];
  people: CrewPerson[];
}) {
  return (
    <Card padding="lg">
      <View className="mb-3 flex-row items-center justify-between gap-2">
        <OptionTag label={label} color={color} />
        <View className="flex-row items-center gap-1.5">
          <Icon name="users" size={14} color={colors.muted} />
          <Text className="text-sm font-bold text-muted">{people.length}</Text>
        </View>
      </View>

      {expectations.length > 0 ? (
        <View className="gap-2.5">
          {expectations.map((e, i) => (
            <ExpectationRow key={i} item={e} />
          ))}
        </View>
      ) : (
        <Text className="text-sm italic text-faint">
          No expectations listed yet.
        </Text>
      )}

      {people.length > 0 ? (
        <View className="mt-4 border-t border-border pt-3">
          <Text className="mb-2 text-xs font-bold uppercase tracking-wide text-faint">
            On this team
          </Text>
          <View className="gap-2">
            {people.map((p, i) => (
              <PersonCard key={i} person={p} />
            ))}
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * The full briefing body for one event — header, an optional site-map slot, and
 * every team's card. The caller owns the surrounding scroll container (so
 * `/briefing` can stack several of these). `subtitle` is the line under the
 * header; `myTeams` floats the viewer's own teams to the top.
 */
export function BriefingView({
  crew,
  subtitle,
  myTeams,
  siteMap,
}: {
  crew: CrewBriefing;
  subtitle?: string | null;
  myTeams?: string[];
  siteMap?: ReactNode;
}) {
  const hasUnassigned =
    crew.unassigned.expectations.length > 0 ||
    crew.unassigned.people.length > 0;

  // Viewer's teams first, otherwise the server order is preserved.
  const mine = new Set(myTeams ?? []);
  const teams =
    mine.size > 0
      ? [...crew.teams].sort(
          (a, b) => (mine.has(b.value) ? 1 : 0) - (mine.has(a.value) ? 1 : 0),
        )
      : crew.teams;

  return (
    <View style={{ width: "100%", maxWidth: 720 }} className="gap-6">
      {/* Header */}
      <View className="gap-1">
        <Text className="font-display text-3xl text-ink">{crew.name}</Text>
        <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
          <View className="flex-row items-center gap-1.5">
            <Icon name="calendar" size={14} color={colors.muted} />
            <Text className="text-sm text-muted">
              {formatDateTime(crew.eventDate)}
            </Text>
          </View>
          {crew.location ? (
            <View className="flex-row items-center gap-1.5">
              <Icon name="map-pin" size={14} color={colors.muted} />
              <Text className="text-sm text-muted">{crew.location}</Text>
            </View>
          ) : null}
        </View>
        {subtitle ? (
          <Text className="mt-1 text-sm text-faint">{subtitle}</Text>
        ) : null}
      </View>

      {/* Optional site map — where everyone & everything is placed. */}
      {siteMap}

      {/* Teams */}
      <View className="gap-4">
        {teams.map((team) => (
          <TeamCard
            key={team.value}
            label={team.label}
            color={team.color}
            expectations={team.expectations}
            people={team.people}
          />
        ))}

        {hasUnassigned ? (
          <TeamCard
            label="Unassigned"
            color="gray"
            expectations={crew.unassigned.expectations}
            people={crew.unassigned.people}
          />
        ) : null}
      </View>
    </View>
  );
}
