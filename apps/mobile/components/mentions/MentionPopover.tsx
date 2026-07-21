/**
 * MentionPopover — the anchored suggestion panel for MentionTextInput.
 *
 * NATIVE: delegates to the shared `Popover` (a transparent Modal), which is
 * fine on iOS/Android where opening a Modal does not steal focus from the
 * TextInput being typed in.
 *
 * WEB (`MentionPopover.web.tsx`): must NOT use Modal. react-native-web's
 * Modal installs a focus trap that yanks focus out of the textarea the moment
 * the panel mounts — the input blurs, blur commits + closes the trigger, and
 * the picker unmounts within a frame (i.e. the `@` picker can never appear).
 * The web variant renders a plain DOM portal with no focus management instead.
 */
import type { ReactNode } from "react";
import { Popover } from "../ui/Popover";
import type { AnchorRect } from "../ui/useAnchor";

export function MentionPopover({
  visible,
  onClose,
  anchor,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  anchor: AnchorRect | undefined;
  children: ReactNode;
}) {
  return (
    <Popover visible={visible} onClose={onClose} anchor={anchor}>
      {children}
    </Popover>
  );
}
