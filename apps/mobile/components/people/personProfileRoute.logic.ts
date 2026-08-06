/**
 * personProfileRoute — the expo-router path to a person's full profile on
 * the People tab. Centralizes the `?openId=` deep-link contract (consumed
 * by apps/mobile/app/(app)/(tabs)/people.tsx's `useLocalSearchParams`) so
 * the one remaining caller that navigates there — PersonDetailModal's
 * "View full profile" button — can't drift from it.
 */
export function personProfileRoute(personId: string): string {
  return `/people?openId=${personId}`;
}
