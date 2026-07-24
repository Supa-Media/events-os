/**
 * CALENDAR — the month view of the chapter's event slate.
 *
 * Reached from the "Upcoming events" stat on the home screen (and now also
 * from the Events tab's `Calendar` toggle, which renders the same
 * `EventsCalendarView` inline). Thin `Screen`/`PageHeader` wrapper — the
 * month grid, day agenda, status legend, and month nav all live in
 * `EventsCalendarView`, shared by both surfaces so behavior never diverges.
 */
import { useRouter } from "expo-router";
import { Screen, PageHeader, Button } from "../../components/ui";
import { EventsCalendarView } from "../../components/event/EventsCalendarView";
import { useChapterContext } from "../../lib/ChapterContext";
import type { Id } from "@events-os/convex/_generated/dataModel";

export default function CalendarScreen() {
  const router = useRouter();
  const { context } = useChapterContext();
  const isPeeking = context?.kind === "peek";
  const chapterId: Id<"chapters"> | undefined =
    context?.kind === "peek" ? context.chapterId : undefined;

  return (
    <Screen maxWidth={1180}>
      <PageHeader
        eyebrow="Operations"
        title="Calendar"
        subtitle="Every gathering, mapped across the month."
        actions={
          isPeeking ? undefined : (
            <Button
              title="New event"
              icon="plus"
              onPress={() => router.push("/event/new")}
            />
          )
        }
      />
      <EventsCalendarView isPeeking={isPeeking} chapterId={chapterId} />
    </Screen>
  );
}
