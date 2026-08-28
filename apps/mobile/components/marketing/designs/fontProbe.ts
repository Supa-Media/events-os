/**
 * Does this NATIVE device have a font family by this name? (Metro resolves
 * `fontProbe.web.ts` for the web bundle; this file is what iOS and Android get.)
 *
 * There is no measurement to make here. React Native hands an unknown
 * `fontFamily` to the platform's font manager, which silently substitutes the
 * system face and reports nothing back — the exact failure this whole module
 * exists to prevent — and there is no API that answers "is this installed?".
 * `expo-font` can only tell us about faces the APP loaded, which is a different
 * question: the kit names the org's faces, not the app's.
 *
 * So the honest native answer is a list of what the OS actually ships, and
 * "unavailable" for everything else. That is the conservative direction to be
 * wrong in: a face wrongly called unavailable shows an accurate "not on this
 * device — here's the download", while a face wrongly called available shows a
 * confident specimen of the wrong typeface.
 *
 * Names are matched case-insensitively and space-insensitively, so "SF Pro
 * Display", "sf pro display" and "SFProDisplay" all land on the same entry.
 */
import { Platform } from "react-native";

/** Lowercased, spaces and hyphens removed — the comparison key. */
function key(family: string): string {
  return family.toLowerCase().replace(/[\s_-]+/g, "");
}

function set(...families: string[]): Set<string> {
  return new Set(families.map(key));
}

/**
 * The faces iOS ships, filtered to the ones a brand kit plausibly names. The
 * full system list is several hundred entries long and mostly scripts and
 * novelty faces; every one omitted here simply shows the honest "not on this
 * device" card.
 *
 * `System`, `SF Pro`, `SF Pro Display`, `SF Pro Text` and `San Francisco` all
 * map to the system face, which iOS genuinely does have — a kit naming SF Pro
 * for captions is naming the face the phone is already set in.
 */
const IOS = set(
  "System",
  "SF Pro",
  "SF Pro Display",
  "SF Pro Text",
  "San Francisco",
  "Helvetica",
  "Helvetica Neue",
  "Arial",
  "Arial Rounded MT Bold",
  "Avenir",
  "Avenir Next",
  "Avenir Next Condensed",
  "Baskerville",
  "Bodoni 72",
  "Charter",
  "Cochin",
  "Copperplate",
  "Courier New",
  "Didot",
  "Futura",
  "Georgia",
  "Gill Sans",
  "Hoefler Text",
  "Iowan Old Style",
  "Menlo",
  "Optima",
  "Palatino",
  "Rockwell",
  "Superclarendon",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
);

/**
 * The faces Android ships. Deliberately short: AOSP guarantees the Roboto and
 * Noto families and the three generic aliases, and OEM skins vary too much for
 * anything else to be a claim worth making.
 */
const ANDROID = set(
  "System",
  "Roboto",
  "Roboto Condensed",
  "Noto Sans",
  "Noto Serif",
  "Droid Sans",
  "Droid Serif",
  "Droid Sans Mono",
  "sans-serif",
  "serif",
  "monospace",
);

/** Whether the device has a family by this name. See the module doc for why
 *  this is a list rather than a measurement. */
export function hasFontFamily(family: string): boolean {
  const table = Platform.OS === "ios" ? IOS : ANDROID;
  return table.has(key(family));
}
