import { PUSH_CHANNELS } from "@opentradesos/field-client";

/**
 * NOTICES ABOUT THE DAY, WITHOUT THE PHONE
 *
 * The decisions the notification code makes, kept out of the module that
 * talks to the operating system so they are tested in Node: which channels
 * the app creates, which visit a tapped notice opens, where the push
 * project id comes from, and what the day screen says when notices are off.
 */

/**
 * The two Android channels, named as the server sends to them. Android lets
 * the person turn each off on its own, which is the right control: somebody
 * can silence the quiet one and still be woken for a job tonight.
 */
export const CHANNELS = [
  { id: PUSH_CHANNELS.normal, name: "Changes to your day", sound: true },
  { id: PUSH_CHANNELS.quiet, name: "Changes to your day, at night", sound: false },
] as const;

export type PushState = "on" | "off" | "denied" | "unavailable";

const UUID = /^[0-9a-f-]{36}$/i;

/** The visit a tapped notice is about, or null for anything that is not one of ours. */
export function visitFromNotice(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const visitId = (data as { visitId?: unknown }).visitId;
  return typeof visitId === "string" && UUID.test(visitId) ? visitId : null;
}

/**
 * Where a tapped notice goes.
 *
 * A visit or a task the phone holds, the toolbox talks or the person's
 * expenses, which the phone has a screen for, and anything else in the
 * browser at the page the bell would open. `browser` carries a path on the
 * company's own server, never an address, so a notice cannot send the phone
 * anywhere else.
 */
export type NoticeTarget =
  | { open: "visit"; visitId: string }
  | { open: "task"; taskId: string; href: string | null }
  | { open: "talks" }
  | { open: "expenses" }
  | { open: "browser"; href: string };

export interface TappedNotice {
  /** The notice itself, to mark read. Absent from a change to the day, which is not a notice. */
  noticeId: string | null;
  target: NoticeTarget;
}

/**
 * A path on our own server and nothing else: one slash, then not another
 * slash or a backslash (which a browser reads as a different host), and no
 * control characters. A notice that came with anything stranger opens nothing.
 */
function ownPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  if (!/^\/(?![/\\])/.test(value)) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

/**
 * What a tap on a notice means, from the data the server sent with it.
 *
 * Two senders, one shape each. A change to the day names its visit
 * (`visitId`), as it always has. A notice about a person's own work names the
 * notice, its kind of record and that record's id (`about`), and the page the
 * bell would open (`href`). Null for anything that is neither, which is the
 * phone opening and doing nothing else.
 */
export function tappedNotice(data: unknown): TappedNotice | null {
  if (typeof data !== "object" || data === null) return null;
  const sent = data as { noticeId?: unknown; href?: unknown; about?: unknown };
  const noticeId = typeof sent.noticeId === "string" && UUID.test(sent.noticeId) ? sent.noticeId : null;

  const visitId = visitFromNotice(data);
  if (visitId) return { noticeId, target: { open: "visit", visitId } };

  const about = typeof sent.about === "object" && sent.about !== null
    ? sent.about as { type?: unknown; id?: unknown } : null;
  const type = about && typeof about.type === "string" ? about.type : null;
  const id = about && typeof about.id === "string" && UUID.test(about.id) ? about.id : null;
  const href = ownPath(sent.href);

  if (type === "visit" && id) return { noticeId, target: { open: "visit", visitId: id } };
  if (type === "task" && id) return { noticeId, target: { open: "task", taskId: id, href } };
  if (type === "safety_meeting") return { noticeId, target: { open: "talks" } };
  if (type === "expense") return { noticeId, target: { open: "expenses" } };
  return href ? { noticeId, target: { open: "browser", href } } : null;
}

/** The address a path opens at on the company's server, which may sit under a path of its own. */
export function serverPage(serverUrl: string, href: string): string | null {
  const path = ownPath(href);
  return path ? `${serverUrl.replace(/\/+$/, "")}${path}` : null;
}

/**
 * The Expo project a push token is issued for. EAS writes it into the app's
 * config when a company runs `eas init`; a build that never did has none,
 * and Expo will not issue a token without one.
 */
export function projectIdFrom(constants: {
  expoConfig?: { extra?: { eas?: { projectId?: unknown } } } | null;
  easConfig?: { projectId?: unknown } | null;
}): string | null {
  const id = constants.expoConfig?.extra?.eas?.projectId ?? constants.easConfig?.projectId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/** What the day screen says about notices, or null when they are on and nothing needs saying. */
export function pushLine(state: PushState): string | null {
  switch (state) {
    case "denied":
      return "Notices are turned off for this app, so you will not hear when the office changes your day. Turn them on in the phone's settings.";
    case "unavailable":
      return "This copy of the app cannot get notices. Ask whoever built it to set up push notifications.";
    default:
      return null;
  }
}
