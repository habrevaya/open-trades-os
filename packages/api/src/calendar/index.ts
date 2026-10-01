export * from "./provider";
export {
  renderCalendar, escapeText, foldLine, utcStamp, sequenceFor, MAX_OCTETS,
  type CalendarDocument, type CalendarEvent,
} from "./ics";
export { icsFeedProvider } from "./ics-feed";

/**
 * Imported for the side effect of registering itself, the same way the
 * messaging, payment and email barrels work. The feed path resolves a
 * provider by name and never mentions ICS.
 */
import "./ics-feed";
