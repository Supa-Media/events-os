import { ReactNode } from "react";
import { View, Text } from "react-native";
import { useIsPhone } from "../../lib/breakpoints";

type Props = {
  title: string;
  subtitle?: string;
  /** Optional eyebrow shown above the title (e.g. breadcrumb / type). */
  eyebrow?: string;
  /** Right-aligned actions (buttons). */
  actions?: ReactNode;
};

/**
 * The page top bar: a serif display title with optional eyebrow + subtitle on
 * the left and actions on the right. Sits inside the content column so it lines
 * up with the page body.
 *
 * On a phone this is the page's ONLY title — the shell's chrome is a pair of
 * floating buttons with no title of its own, so the heading here is what names
 * the screen (the same way a note's own H1 names it in a reading app). The
 * actions drop to their own row underneath rather than competing with the
 * title for a phone's width: a title and two buttons sharing 360px wraps the
 * title to three lines and squeezes the buttons to their ellipsis.
 */
export function PageHeader({ title, subtitle, eyebrow, actions }: Props) {
  const phone = useIsPhone();

  const heading = (
    <View className="flex-1">
      {eyebrow ? (
        <Text className="mb-1 text-xs font-bold uppercase tracking-wider text-accent">
          {eyebrow}
        </Text>
      ) : null}
      <Text className={`font-display text-ink ${phone ? "text-2xl" : "text-3xl"}`}>
        {title}
      </Text>
      {subtitle ? (
        <Text className={`text-muted ${phone ? "mt-1 text-sm" : "mt-1.5 text-base"}`}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  if (phone) {
    return (
      <View className="mb-5">
        {heading}
        {actions ? (
          <View className="mt-3 flex-row flex-wrap items-center gap-2">{actions}</View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="mb-6 flex-row items-start justify-between gap-4">
      {heading}
      {actions ? <View className="flex-row items-center gap-2 pt-1">{actions}</View> : null}
    </View>
  );
}
