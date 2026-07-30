/**
 * COMPOSER FORMAT SWITCH LINK — the quiet, shared rendering of
 * `ComposerFormatSwitch` (`MailyDocumentHost.types.ts`'s own doc), used by
 * BOTH `MailyDocumentHost.web.tsx` ("Paste HTML instead") and
 * `HtmlPasteComposer.web.tsx` ("Use the editor instead") so the two
 * directions of the founder's primary fix (2026-07-30) look and behave like
 * ONE affordance, not two independently-styled buttons that happen to do
 * similar things.
 *
 * Cross-platform (plain RN primitives, same as `MailyMetaFields`) even
 * though only the `.web.tsx` hosts ever import it — native stays
 * permanently read-only and never builds a `formatSwitch` prop to pass, per
 * `MailyDocumentHost.native.tsx`'s/`HtmlPasteComposer.native.tsx`'s own
 * module docs.
 */
import { Pressable, Text, View } from "react-native";
import { InfoTooltip } from "../../ui";
import type { ComposerFormatSwitch } from "./MailyDocumentHost.types";

export function ComposerFormatSwitchLink({ formatSwitch }: { formatSwitch: ComposerFormatSwitch }) {
  const disabled = !!formatSwitch.disabledReason || formatSwitch.switching;
  return (
    <View className="mb-3 flex-row items-center gap-1.5">
      <Pressable
        onPress={disabled ? undefined : () => void formatSwitch.onSwitch()}
        disabled={disabled}
        accessibilityRole="button"
        hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      >
        <Text
          className={`text-xs font-medium ${
            disabled ? "text-faint" : "text-accent underline"
          }`}
        >
          {formatSwitch.switching ? "Switching…" : formatSwitch.label}
        </Text>
      </Pressable>
      {formatSwitch.disabledReason ? <InfoTooltip text={formatSwitch.disabledReason} /> : null}
    </View>
  );
}

export default ComposerFormatSwitchLink;
