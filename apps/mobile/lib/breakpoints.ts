import { useWindowDimensions } from "react-native";

/**
 * Viewport breakpoints — the ONE place the app decides "is this a phone?".
 *
 * Before this file, `760` was retyped as a local `DESKTOP` / `WIDE` constant in
 * the shell and in a dozen screens, which meant the shell could switch to its
 * phone chrome at a width where a screen was still rendering its desktop table.
 * Everything that branches on viewport size should import from here.
 */

/** At/above this width the app is a desktop: persistent sidebar, hover, tables. */
export const DESKTOP_WIDTH = 760;

/** True below {@link DESKTOP_WIDTH} — phone-shaped: floating chrome, sheets. */
export function useIsPhone(): boolean {
  const { width } = useWindowDimensions();
  return width < DESKTOP_WIDTH;
}
