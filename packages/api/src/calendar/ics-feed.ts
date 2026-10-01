import { registerCalendarProvider, type CalendarProvider } from "./provider";
import { renderCalendar, type CalendarDocument } from "./ics";

/**
 * A PUBLISHED ICS FEED
 *
 * The whole provider, because an ICS feed has no vendor, no credential to
 * fetch and no failure mode on the far side: Google Calendar, Apple
 * Calendar, Outlook and every phone subscribe to a URL natively. Everything
 * that is hard about it is in `ics.ts` and is about the file format.
 *
 * Nothing else in the codebase imports this file. It registers itself under
 * its catalogue key, and a deployment that renders its calendars some other
 * way never loads it.
 */
export function icsFeedProvider(): CalendarProvider {
  return {
    name: "ics_feed",
    /**
     * A subscription is a download. A technician who drags an event to a
     * different hour in their phone's calendar has changed their own copy
     * and nothing else, and the next refresh puts it back.
     */
    writable: false,
    contentType: "text/calendar; charset=utf-8",
    render: (document: CalendarDocument) => renderCalendar(document),
  };
}

registerCalendarProvider("ics_feed", icsFeedProvider);
