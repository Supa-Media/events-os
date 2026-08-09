/**
 * A radio group a keyboard user can actually operate.
 *
 * Every hand-rolled `accessibilityRole="radio"` in this app had three defects,
 * and the third is the reason this is a GROUP primitive rather than another
 * per-control patch like `Checkbox`:
 *
 * 1. **Space did nothing.** react-native-web only accepts Space for
 *    button-ish roles — see `spaceToggle.ts`.
 * 2. **The state never reached the DOM.** `accessibilityState` is not in
 *    RNW 0.21.2's forwarded-prop list, so `accessibilityState={{ selected }}`
 *    emitted no attribute at all. It was also the wrong attribute twice over:
 *    a radio's state is `aria-checked`, not `aria-selected` (that belongs to
 *    tabs, options and grid cells).
 * 3. **Every option was its own tab stop, and no option said what set it
 *    belonged to.** Tabbing through the payout modal meant nine stops through
 *    one question. ARIA's radio pattern is a single tab stop per GROUP, with
 *    the arrow keys moving — and selecting — within it. That can only be owned
 *    by something that can see all the options at once.
 *
 * The roving tab stop and arrow keys are driven off the DOM rather than a
 * registry of children: the group queries its own `[role="radio"]`
 * descendants, which gives visual/DOM order for free (and is therefore right
 * for wrapped rows, conditionally-rendered options, and children rendered
 * through a `map` that reorders). Selection follows focus by dispatching a
 * real `click` — RNW's `onPress` is wired to the native click event
 * (`PressResponder`'s `onClick`), so this is the same path a mouse takes.
 *
 * Native gets the roles and `aria-checked`; the keyboard plumbing is web-only
 * and inert there.
 */
import { createContext, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { spaceToggleProps, type WebKeyHandlers } from "./spaceToggle";

/** Present when a `Radio` sits inside a `RadioGroup`. Used only to warn in
 *  dev — a lone radio is an authoring mistake, not a runtime one. */
const InGroup = createContext(false);

const RADIO_SELECTOR = '[role="radio"]:not([aria-disabled="true"])';

function radiosIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(RADIO_SELECTOR));
}

export function RadioGroup({
  accessibilityLabel,
  children,
  className,
  horizontal = false,
}: {
  /** Names the QUESTION, not the answers — "Why is there no receipt?". A
   *  group with no name announces its options with nothing tying them
   *  together, which is most of what the role is for. Required for the same
   *  reason `Checkbox`'s label is. */
  accessibilityLabel: string;
  children: ReactNode;
  className?: string;
  /** Only changes what screen readers are told about arrow-key direction;
   *  both axes always work, as ARIA's radio pattern allows. */
  horizontal?: boolean;
}) {
  const ref = useRef<View>(null);

  // Exactly one tab stop, asserted over the WHOLE group after every commit.
  // Two things make this the group's job rather than each radio's: a group with
  // no answer yet still needs one reachable stop (the first option takes it),
  // and React won't rewrite an unchanged `tabIndex` prop, so a radio that was
  // imperatively given the stop keeps it after the options reorder (the quiz
  // shuffles them) or after a different option becomes the answer. Setting
  // every radio each time is what stops those two stops accumulating.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node?.querySelectorAll) return;
    const radios = radiosIn(node);
    if (radios.length === 0) return;
    const checked = radios.findIndex(
      (r) => r.getAttribute("aria-checked") === "true",
    );
    const stop = checked === -1 ? 0 : checked;
    radios.forEach((r, i) => {
      r.tabIndex = i === stop ? 0 : -1;
    });
  });

  const webKeys: WebKeyHandlers & {
    onKeyDown?: (event: {
      key?: string;
      preventDefault?: () => void;
      nativeEvent?: { key?: string };
    }) => void;
  } =
    Platform.OS === "web"
      ? {
          onKeyDown: (event) => {
            const key = event.key ?? event.nativeEvent?.key;
            if (key == null) return;
            const node = ref.current as unknown as HTMLElement | null;
            if (!node?.querySelectorAll) return;
            const radios = radiosIn(node);
            if (radios.length === 0) return;
            const active = document.activeElement as HTMLElement | null;
            const from = active ? radios.indexOf(active) : -1;
            if (from === -1) return; // focus isn't on one of ours

            let to: number;
            if (key === "ArrowRight" || key === "ArrowDown") {
              to = (from + 1) % radios.length;
            } else if (key === "ArrowLeft" || key === "ArrowUp") {
              to = (from - 1 + radios.length) % radios.length;
            } else if (key === "Home") {
              to = 0;
            } else if (key === "End") {
              to = radios.length - 1;
            } else {
              return;
            }
            // Arrows scroll the page by default, and a group that answers the
            // key AND scrolls is barely better than one that ignores it.
            event.preventDefault?.();
            radios[to].focus();
            // Selection follows focus (ARIA's radio pattern). `click()` is the
            // same route a mouse takes into `onPress`.
            radios[to].click();
          },
        }
      : {};

  return (
    <InGroup.Provider value={true}>
      <View
        ref={ref}
        {...webKeys}
        accessibilityRole="radiogroup"
        accessibilityLabel={accessibilityLabel}
        aria-orientation={horizontal ? "horizontal" : "vertical"}
        className={className}
      >
        {children}
      </View>
    </InGroup.Provider>
  );
}

export function Radio({
  checked,
  onSelect,
  accessibilityLabel,
  disabled = false,
  className,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  /** What this ANSWER is, in words — the visible label is often styled text
   *  or an icon, and an icon-only option otherwise announces as nothing. */
  accessibilityLabel: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const inGroup = useContext(InGroup);
  if (__DEV__ && !inGroup) {
    // eslint-disable-next-line no-console
    console.warn(
      `Radio "${accessibilityLabel}" is not inside a RadioGroup — it will be its own tab stop and announce with no group name.`,
    );
  }
  return (
    <Pressable
      {...spaceToggleProps(onSelect, disabled)}
      onPress={onSelect}
      disabled={disabled}
      accessibilityRole="radio"
      // `aria-checked`, not `aria-selected`: `selected` is for tabs and
      // listbox options. And it has to be the `aria-*` prop, because
      // `accessibilityState` never reaches the DOM (see `ui/Checkbox`).
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={accessibilityLabel}
      // The roving tab stop: the answer is the group's one stop. A group with
      // no answer yet is handled by `RadioGroup`'s effect.
      tabIndex={checked ? 0 : -1}
      className={className}
    >
      {children}
    </Pressable>
  );
}
