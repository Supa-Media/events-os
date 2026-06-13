import { Redirect } from "expo-router";
import { useConvexAuth } from "convex/react";

/**
 * Entry route — sends the user to the app or the login screen based on auth.
 */
export default function Index() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) return null;

  return (
    <Redirect href={isAuthenticated ? "/(app)/(tabs)" : "/(auth)/login"} />
  );
}
