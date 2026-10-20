import { z } from "zod";
import { notices } from "@opentradesos/core";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M34. NOTICES TO THE COMPANY'S OWN PEOPLE
 *
 * The bell in the app, and the switches behind it on `/me`. Every route here
 * is the signed in person's own and takes no person: their notices, their
 * switches, their own mobile. `profile:own`, which every preset holds, the
 * same class of act as reading and keeping their own record. A connected app
 * has no notices and is refused.
 *
 * What raises a notice is not here: it is the escalation, the order waiting,
 * the expense decided, each in its own module, through `staff-notices.ts`.
 */

const DateTime = z.string().datetime();
const Kind = z.enum(notices.NOTICE_KINDS);

const Notice = z.object({
  id: Uuid,
  kind: z.string(),
  kindLabel: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  /** The page it is about, for this person, asked again when it was listed. */
  href: z.string(),
  createdAt: DateTime,
  readAt: DateTime.nullable(),
});

const Switches = z.object({ inApp: z.boolean(), push: z.boolean(), text: z.boolean() });

const Settings = z.object({
  kinds: z.array(Switches.extend({
    kind: Kind, label: z.string(), description: z.string(),
    /** Whether it also comes by email. Null for a kind that is never emailed, which has no such choice. */
    email: z.boolean().nullable(),
  })),
  texts: z.object({
    on: z.boolean(),
    mobile: z.string().nullable(),
    since: DateTime.nullable(),
    /** The words beside the box. Kept on the consent, word for word. */
    agreement: z.string(),
  }),
  phones: z.number().int(),
  companyCanText: z.boolean(),
  digest: z.object({
    on: z.boolean(),
    /** The company's morning hour, 0 to 23, when the digest goes: when its quiet hours end, or 8. */
    hour: z.number().int(),
    /** The company day it was last decided on. */
    lastOn: z.string().nullable(),
    /** What happened then, in words: how many it listed, nothing unread, or why it could not go. */
    lastOutcome: z.string().nullable(),
  }),
});

export const listMyNotices = defineRoute({
  method: "get",
  path: "/v1/me/notices",
  summary: "Your notices, newest first, and how many you have not read",
  description:
    "The bell: what you were told, about which record, when, and whether you have read it. Only the kinds you show in the app. "
    + "Each is checked again when listed: a notice about something you can no longer open is left out. `unread` counts up to 100.",
  module: "M34",
  permissions: ["profile:own"],
  input: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** Only the ones you have not read. */
    unread: z.coerce.boolean().optional(),
  }),
  output: z.object({ notices: z.array(Notice), unread: z.number().int() }),
});

export const readMyNotices = defineRoute({
  method: "post",
  path: "/v1/me/notices/read",
  summary: "Mark your notices read",
  description:
    "Some by id, or `all`. Ids that are not yours are ignored. Marking a read one read again changes nothing, so a retry is the same answer.",
  module: "M34",
  permissions: ["profile:own"],
  /** Setting a state. */
  idempotent: true,
  input: z.object({ ids: z.array(Uuid).max(200).optional(), all: z.boolean().optional() }),
  output: z.object({ marked: z.number().int() }),
});

export const getMyNoticeSettings = defineRoute({
  method: "get",
  path: "/v1/me/notice-settings",
  summary: "Where each kind of notice reaches you",
  description:
    "Per kind, in the app, on the phone app and by text. Until you change one, a kind comes in the app and on the phone and never by text. "
    + "A licence or skill running out also comes by email to your address, unless you switch that off (`email`; null on a kind that is never emailed). "
    + "`phones` is how many phones you have the app signed in on; `companyCanText` is whether the company has a number that can send texts.",
  module: "M34",
  permissions: ["profile:own"],
  input: z.object({}),
  output: Settings,
});

export const setMyNoticeSettings = defineRoute({
  method: "post",
  path: "/v1/me/notice-settings",
  summary: "Choose where each kind of notice reaches you",
  description:
    "Only the kinds sent change. A text switch cannot be turned on before texts are, with your own number, on `POST /v1/me/notice-texts`. `email` is for the kinds that are emailed and is refused on the others.",
  module: "M34",
  permissions: ["profile:own"],
  /** Setting a state. */
  idempotent: true,
  input: z.object({
    kinds: z.array(Switches.extend({
      kind: Kind,
      /** Only for a kind that is emailed (a licence or skill running out). Left out keeps what you chose; `true` on any other kind is refused. */
      email: z.boolean().optional(),
    })).min(1).max(notices.NOTICE_KINDS.length),
  }),
  output: Settings,
});

export const setMyNoticeTexts = defineRoute({
  method: "post",
  path: "/v1/me/notice-texts",
  summary: "Turn texts to your own mobile on or off",
  description:
    "On needs your mobile number and `agreed`, which is you ticking the box beside the words in `texts.agreement`. Only you can do this for yourself; "
    + "it is your own consent, kept apart from customers' consent. The same number again changes nothing. Off stops every text still waiting to go. "
    + "Texts come from the company's registered number, never in its quiet hours (they wait until morning), and never after you reply STOP.",
  module: "M34",
  permissions: ["profile:own"],
  /** Setting a state: the same number again is the first answer. */
  idempotent: true,
  input: z.object({
    on: z.boolean(),
    mobilePhone: z.string().max(40).nullable().optional(),
    agreed: z.boolean().optional(),
  }),
  output: Settings,
});

export const setMyNoticeDigest = defineRoute({
  method: "post",
  path: "/v1/me/notice-digest",
  summary: "Turn your daily email of unread notices on or off",
  description:
    "Off until you turn it on. Once a day, at the company's morning hour (when its quiet hours end, or 8), an email to the address you sign in with lists the notices on your bell you have not read and can still open, up to twenty and a count of the rest. Nothing is sent on a day nothing is unread. "
    + "It goes through the company's own email, so with no email connected nothing goes and `digest.lastOutcome` says so. Only you can turn yours on.",
  module: "M34",
  permissions: ["profile:own"],
  /** Setting a state: on twice is on. */
  idempotent: true,
  input: z.object({ on: z.boolean() }),
  output: Settings,
});

const Keeping = z.object({
  /** Days a read notice is kept before the worker removes it. Null keeps them for good, the default. */
  keepDays: z.number().int().min(notices.KEEP_READ_MIN_DAYS).max(notices.KEEP_READ_MAX_DAYS).nullable(),
});

export const getReadNoticeKeeping = defineRoute({
  method: "get",
  path: "/v1/notice-keeping",
  summary: "How long the company keeps notices people have read",
  module: "M34",
  permissions: ["settings:read"],
  input: z.object({}),
  output: Keeping,
});

export const setReadNoticeKeeping = defineRoute({
  method: "patch",
  path: "/v1/notice-keeping",
  summary: "Set how long the company keeps notices people have read",
  description:
    `Whole days from ${notices.KEEP_READ_MIN_DAYS} to ${notices.KEEP_READ_MAX_DAYS}, or null to keep them for good, which is where every company starts. `
    + "The worker then removes notices read longer ago than that, and ones a person keeps off their bell raised longer ago, with their sends. Never an unread one. "
    + "A licence or skill notice stays for a year and eight days after it was raised, and a toolbox talk nudge for nine days, whatever this says, because the worker would otherwise raise it again. "
    + "Removed notices do not come back if the number is made longer. Audited.",
  module: "M34",
  permissions: ["settings:write"],
  /** Setting a state. */
  idempotent: true,
  input: Keeping,
  output: Keeping,
});

export const staffNoticeRoutes = {
  listMyNotices, readMyNotices, getMyNoticeSettings, setMyNoticeSettings, setMyNoticeTexts, setMyNoticeDigest,
  getReadNoticeKeeping, setReadNoticeKeeping,
} as const;
