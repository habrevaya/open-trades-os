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

export const staffNoticeRoutes = {
  listMyNotices, readMyNotices, getMyNoticeSettings, setMyNoticeSettings, setMyNoticeTexts,
} as const;
