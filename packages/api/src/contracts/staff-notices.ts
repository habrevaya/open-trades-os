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
 * What a new person starts with is the company's, below (`/v1/notice-defaults`).
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
    /** The hour it goes, 0 to 23 in the company's time zone: your own where you chose one, else the company's morning hour. */
    hour: z.number().int(),
    /** The company day it was last decided on. */
    lastOn: z.string().nullable(),
    /** What happened then, in words: how many it listed, nothing unread, or why it could not go. */
    lastOutcome: z.string().nullable(),
  }),
  /** Your own hour for the daily email. */
  digestHour: z.object({
    /** The hour you chose, or null for the company's morning hour. */
    own: z.number().int().nullable(),
    /** The company's morning hour: when its quiet hours end, or 8. */
    company: z.number().int(),
    /** The hours you may choose: from the company's morning hour, never inside its quiet hours. */
    choices: z.array(z.number().int()),
  }),
  /** Your own turns on the office's on call rota, from today on. */
  onCall: z.array(z.object({ startsOn: z.string(), endsOn: z.string(), today: z.boolean() })),
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
    "Off until you turn it on. Once a day, at the company's morning hour (when its quiet hours end, or 8) or at your own `hour`, an email to the address you sign in with lists the notices on your bell you have not read and can still open, up to twenty and a count of the rest. Nothing is sent on a day nothing is unread. "
    + "It goes through the company's own email, so with no email connected nothing goes and `digest.lastOutcome` says so. Only you can turn yours on. "
    + "`hour` is your own hour of the company's day (one of `digestHour.choices`: from its morning hour, never inside its quiet hours); null goes back to the morning hour, and left out keeps what you had.",
  module: "M34",
  permissions: ["profile:own"],
  /** Setting a state: on twice is on. */
  idempotent: true,
  input: z.object({ on: z.boolean(), hour: z.number().int().min(0).max(23).nullable().optional() }),
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

const DefaultKind = z.object({
  kind: Kind,
  label: z.string(),
  description: z.string(),
  inApp: z.boolean(),
  push: z.boolean(),
  /** Whether a new person starts on email. Null for a kind that is never emailed. */
  email: z.boolean().nullable(),
});

export const getNoticeDefaults = defineRoute({
  method: "get",
  path: "/v1/notice-defaults",
  summary: "What a new person's notices start as",
  description:
    "Per kind, whether a person added to the company starts with it in the app, on the phone app and, for a kind that is emailed, by email. "
    + "There is no text setting: texts go to a person's own mobile and only when they turn them on themselves. "
    + "Until the company changes one, a kind starts in the app and on the phone.",
  module: "M34",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ kinds: z.array(DefaultKind) }),
});

export const setNoticeDefaults = defineRoute({
  method: "patch",
  path: "/v1/notice-defaults",
  summary: "Set what a new person's notices start as",
  description:
    "Only the kinds sent change. These are copied onto each person as they are added and never applied to people already in the company, "
    + "and a person's own choice on their page is never replaced. `email` is for a kind that is emailed and is refused on the others. Audited.",
  module: "M34",
  permissions: ["settings:write"],
  /** Setting a state. */
  idempotent: true,
  input: z.object({
    kinds: z.array(z.object({
      kind: Kind,
      inApp: z.boolean(),
      push: z.boolean(),
      email: z.boolean().optional(),
    })).min(1).max(notices.NOTICE_KINDS.length),
  }),
  output: z.object({ kinds: z.array(DefaultKind) }),
});

/* --------------------------------------------- on call for the office */

const OnCallKind = z.enum(notices.ON_CALL_KINDS);
const CompanyDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

const OnCallTurn = z.object({
  id: Uuid,
  userId: Uuid,
  name: z.string(),
  /** The first and last company day of the turn, both included. */
  startsOn: z.string(),
  endsOn: z.string(),
  note: z.string().nullable(),
  /** Whether this turn covers the company's today. */
  today: z.boolean(),
});

const OfficeOnCall = z.object({
  today: z.string(),
  kinds: z.array(z.object({ kind: OnCallKind, label: z.string(), description: z.string(), on: z.boolean() })),
  /** Turns that cover today or a later day, soonest first. */
  turns: z.array(OnCallTurn),
  /** Who is on call today, by name. Empty means nobody, so everybody who handles a kind is told. */
  onCallToday: z.array(z.string()),
  /** Who can be put on the rota: working here and able to answer at least one of the three kinds. */
  people: z.array(z.object({ userId: Uuid, name: z.string(), answers: z.array(OnCallKind) })),
});

export const getOfficeOnCall = defineRoute({
  method: "get",
  path: "/v1/office-on-call",
  summary: "The office's on call rota, and which notices go to it",
  description:
    "A deadline about to be missed, a customer asking to change a visit and an automatic payment that failed tell everybody who handles them, "
    + "unless the company sends that kind to whoever is on call. Off for each kind until switched on. "
    + "Not the technicians' rota for customers' calls after hours (`/v1/on-call`).",
  module: "M34",
  permissions: ["settings:read"],
  input: z.object({}),
  output: OfficeOnCall,
});

export const setOfficeOnCallKinds = defineRoute({
  method: "patch",
  path: "/v1/office-on-call",
  summary: "Choose which notices go to whoever is on call",
  description:
    "The kinds listed go to the people on call that day who can answer them and open the record; the rest go to everybody who handles them. "
    + "When nobody on call today can be told, everybody who handles it is told instead. An empty list is everybody for every kind, where every company starts. Audited.",
  module: "M34",
  permissions: ["settings:write"],
  /** Setting a state. */
  idempotent: true,
  input: z.object({ kinds: z.array(OnCallKind).max(notices.ON_CALL_KINDS.length) }),
  output: OfficeOnCall,
});

export const addOfficeOnCallTurn = defineRoute({
  method: "post",
  path: "/v1/office-on-call/turns",
  summary: "Put somebody on call for the office",
  description:
    "A person who works here and can answer at least one of the three kinds, from a first to a last company day, both included, at most "
    + `${notices.ON_CALL_MOST_DAYS} days, not over already. Two people on one day are both told. The same person for the same days again is the first answer. Audited.`,
  module: "M34",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    userId: Uuid,
    startsOn: CompanyDay,
    endsOn: CompanyDay,
    note: z.string().max(300).nullable().optional(),
  }),
  output: OnCallTurn,
});

export const removeOfficeOnCallTurn = defineRoute({
  method: "delete",
  path: "/v1/office-on-call/turns/{id}",
  summary: "Take a turn off the office's on call rota",
  description: "The audit log keeps what it was. Removing one already gone answers `removed: false`.",
  module: "M34",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

const Applied = z.object({
  /** People who work here now. */
  people: z.number().int(),
  /** People at least one of whose kinds changes. */
  changed: z.number().int(),
  /** Kinds changed across everybody. */
  kinds: z.number().int(),
  /** People who keep at least one kind they chose themselves. */
  keptOwn: z.number().int(),
});

export const previewNoticeDefaultsApplied = defineRoute({
  method: "get",
  path: "/v1/notice-defaults/apply",
  summary: "What giving everybody the company's notice defaults would change",
  description:
    "Counts only, for the question asked before `POST /v1/notice-defaults/apply`: how many people would change, how many kinds, and how many keep a choice of their own.",
  module: "M34",
  permissions: ["settings:read"],
  input: z.object({}),
  output: Applied,
});

export const applyNoticeDefaults = defineRoute({
  method: "post",
  path: "/v1/notice-defaults/apply",
  summary: "Give everybody already here the company's notice defaults",
  description:
    "For every kind a person never chose on their own page, they get the company's defaults now: a kind copied onto them when they joined, or one they never had a row for. "
    + "A kind they chose themselves is kept, and texts are never touched. `confirmed` must be true: ask first. Running it again changes nothing more. Audited.",
  module: "M34",
  permissions: ["settings:write"],
  /** Applying twice is the same state. */
  idempotent: true,
  input: z.object({ confirmed: z.literal(true) }),
  output: Applied,
});

export const staffNoticeRoutes = {
  previewNoticeDefaultsApplied, applyNoticeDefaults,
  getOfficeOnCall, setOfficeOnCallKinds, addOfficeOnCallTurn, removeOfficeOnCallTurn,
  getNoticeDefaults, setNoticeDefaults,
  listMyNotices, readMyNotices, getMyNoticeSettings, setMyNoticeSettings, setMyNoticeTexts, setMyNoticeDigest,
  getReadNoticeKeeping, setReadNoticeKeeping,
} as const;
