/**
 * Edits the RSVP page's extra links (a questionnaire, a sign-up form): a list
 * of label + URL rows. Like the other Design-phase text fields it only edits a
 * local buffer; the parent commits it with "Save page", where the server
 * normalizes URLs and rejects anything that isn't an http(s) link.
 */
import { Pressable, Text, View } from "react-native";
import { RSVP_PAGE_LINKS_MAX, type RsvpPageLink } from "@events-os/shared";
import { Button, Icon, TextField } from "../../ui";
import { colors } from "../../../lib/theme";

export function PageLinksEditor({
  links,
  onChange,
}: {
  links: RsvpPageLink[];
  onChange: (next: RsvpPageLink[]) => void;
}) {
  function update(i: number, patch: Partial<RsvpPageLink>) {
    onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  return (
    <View>
      <Text className="mb-2 text-xs text-muted">
        Each link shows as a card under the date and location, e.g. a talent
        questionnaire or a volunteer sign-up form.
      </Text>
      {links.map((link, i) => (
        <View key={i} className="mb-3 rounded-xl border border-border p-3">
          <View className="mb-1 flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-ink">Link {i + 1}</Text>
            <Pressable
              onPress={() => onChange(links.filter((_, j) => j !== i))}
              hitSlop={6}
              accessibilityLabel={`Remove link ${i + 1}`}
              className="active:opacity-70"
            >
              <Icon name="x" size={15} color={colors.muted} />
            </Pressable>
          </View>
          <TextField
            label="Label"
            value={link.label}
            onChangeText={(label) => update(i, { label })}
            placeholder="Fill out the talent questionnaire"
          />
          <TextField
            label="URL"
            value={link.url}
            onChangeText={(url) => update(i, { url })}
            placeholder="https://forms.gle/…"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
      ))}
      {links.length < RSVP_PAGE_LINKS_MAX ? (
        <Button
          title="Add a link"
          icon="plus"
          variant="secondary"
          size="sm"
          onPress={() => onChange([...links, { label: "", url: "" }])}
        />
      ) : null}
    </View>
  );
}
