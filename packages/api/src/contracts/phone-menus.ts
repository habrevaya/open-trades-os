import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * PHONE MENUS, RING GROUPS AND WHO ANSWERS
 *
 * How a company's own number answers: "press 1 for service, 2 for billing",
 * several phones ringing at once or in turn, the on call technician after
 * hours. The carrier's calls themselves arrive at `/api/webhooks/voice/{token}`
 * beside the messaging webhook, because the caller there is a carrier
 * holding a secret in a URL rather than a user holding a session; these are
 * the settings those calls are answered by.
 *
 * Reading is `settings:read` and changing is `settings:write`, the same as
 * how a number rings: where the company's calls go is a standing decision
 * about the company.
 */

const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "A number in full international form: +15125550123");

/**
 * Where a call goes, as core's router names it: a person, a ring group,
 * another menu, the on call rota, voicemail, a number outside the company, a
 * waiting line (`queue`, by its id) or the phone assistant (`agent`), which is
 * refused on save while it is switched off.
 */
export const Destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), userId: Uuid }),
  z.object({ kind: z.literal("ring_group"), id: Uuid }),
  z.object({ kind: z.literal("ivr"), menu: Uuid }),
  /** `company` for the company wide rota, or a branch's id. */
  z.object({ kind: z.literal("on_call_rota"), id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("voicemail"), box: z.string().max(40).default("main") }),
  z.object({ kind: z.literal("forward"), e164: E164 }),
  z.object({ kind: z.literal("queue"), id: z.string().max(64) }),
  z.object({ kind: z.literal("agent") }),
]);

const MenuOption = z.object({
  /** A key on the phone: 0 to 9, `*` or `#`. */
  key: z.string().min(1).max(1),
  label: z.string().min(1).max(60),
  to: Destination,
});

const MenuInput = {
  name: z.string().min(1).max(80),
  greeting: z.string().min(1).max(600),
  options: z.array(MenuOption).min(1).max(12),
  noInputTo: Destination,
  afterHoursTo: Destination.nullable().optional(),
  timeoutSeconds: z.number().int().min(3).max(15).optional(),
};

const Menu = z.object({
  id: Uuid,
  name: z.string(),
  greeting: z.string(),
  options: z.array(MenuOption),
  noInputTo: Destination,
  afterHoursTo: Destination.nullable(),
  timeoutSeconds: z.number().int(),
  /** Exactly what the caller hears: the greeting, then every option. */
  prompt: z.string(),
  numbers: z.array(z.object({ id: Uuid, e164: z.string(), label: z.string().nullable() })),
});

export const listPhoneMenus = defineRoute({
  method: "get",
  path: "/v1/phone-menus",
  summary: "The company's phone menus",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ menus: z.array(Menu) }),
});

export const getPhoneMenu = defineRoute({
  method: "get",
  path: "/v1/phone-menus/{id}",
  summary: "A phone menu, with what a caller hears",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({ id: Uuid }),
  output: Menu,
});

export const createPhoneMenu = defineRoute({
  method: "post",
  path: "/v1/phone-menus",
  summary: "Build a phone menu",
  description:
    "Every option is checked against what exists: a person with no number to ring, a deleted ring group or a forward nobody can dial is refused with the option named. A caller who presses nothing is sent where noInputTo says after hearing the menu three times; sending them back to the same menu is refused, because it would never end. afterHoursTo is where calls go outside the business hours online booking keeps; absent, the menu answers at every hour.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object(MenuInput),
  output: Menu,
});

export const updatePhoneMenu = defineRoute({
  method: "put",
  path: "/v1/phone-menus/{id}",
  summary: "Change a phone menu",
  description: "Replaces the whole menu, checked the same way as a new one. A call already in the menu hears the new one at its next key press.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, ...MenuInput }),
  output: Menu,
});

export const deletePhoneMenu = defineRoute({
  method: "delete",
  path: "/v1/phone-menus/{id}",
  summary: "Delete a phone menu",
  description: "Refused while a number, another menu or a ring group still sends calls to it, naming what does, because the alternative is a number that answers with silence.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.literal(true) }),
});

const RingMember = z.object({
  userId: Uuid.nullable().optional(),
  e164: z.string().max(32).nullable().optional(),
  label: z.string().max(80).optional(),
});

const RingGroupInput = {
  name: z.string().min(1).max(80),
  strategy: z.enum(["all_at_once", "in_order"]),
  ringSeconds: z.number().int().min(5).max(60).optional(),
  members: z.array(RingMember).min(1).max(10),
  noAnswerTo: Destination,
};

const RingGroup = z.object({
  id: Uuid,
  name: z.string(),
  strategy: z.enum(["all_at_once", "in_order"]),
  ringSeconds: z.number().int(),
  members: z.array(z.object({ userId: Uuid.nullable(), e164: z.string().nullable(), label: z.string() })),
  noAnswerTo: Destination,
});

export const listRingGroups = defineRoute({
  method: "get",
  path: "/v1/ring-groups",
  summary: "The company's ring groups",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ ringGroups: z.array(RingGroup) }),
});

export const createRingGroup = defineRoute({
  method: "post",
  path: "/v1/ring-groups",
  summary: "Make a ring group",
  description:
    "People at the company, rung on the number they answer the company's calls on, or numbers outside it such as an answering service. All at once rings every phone and the first to pick up gets the caller; in order rings each for ringSeconds in the order listed. Ten at most, which is the most a carrier rings in one go. Who is reachable is decided at the moment of each call, so somebody who has left is skipped, with the reason written on the call.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object(RingGroupInput),
  output: RingGroup,
});

export const updateRingGroup = defineRoute({
  method: "put",
  path: "/v1/ring-groups/{id}",
  summary: "Change a ring group",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid, ...RingGroupInput }),
  output: RingGroup,
});

export const deleteRingGroup = defineRoute({
  method: "delete",
  path: "/v1/ring-groups/{id}",
  summary: "Delete a ring group",
  description: "Refused while a menu, another group, a waiting line or the phone assistant still sends calls to it, naming which.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.literal(true) }),
});

const Person = z.object({
  userId: Uuid,
  name: z.string(),
  email: z.string(),
  /** The number the company rings them on, or null when it has none. */
  phone: z.string().nullable(),
});

export const listAnsweringPhones = defineRoute({
  method: "get",
  path: "/v1/answering-phones",
  summary: "The number each person answers the company's calls on",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ people: z.array(Person) }),
});

export const setAnsweringPhone = defineRoute({
  method: "put",
  path: "/v1/answering-phones/{userId}",
  summary: "Set the number a person answers the company's calls on",
  description:
    "What a menu option, a ring group or the on call rota rings when it rings this person. Kept by the company rather than on the person's own account. Clearing it is refused while a menu still rings only them.",
  module: "M18",
  permissions: ["settings:write"],
  input: z.object({ userId: Uuid, e164: z.string().max(32).nullable() }),
  output: Person,
});

const NumberAnswered = z.object({
  id: Uuid, e164: z.string(), label: z.string().nullable(), purpose: z.string(),
  routedHere: z.boolean(), adopted: z.boolean(), menuId: Uuid.nullable(),
});

export const answerNumberHere = defineRoute({
  method: "post",
  path: "/v1/phone-numbers/{id}/answer-here",
  summary: "Answer the calls to a number you already have on Twilio",
  description:
    "Finds the number on the company's own connected Twilio account and points its CALLS here, writing down where they went before; its texts are left where they are. A number Twilio does not hold is refused in words. Asking again for a number already answered here returns it.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: NumberAnswered,
});

export const stopAnsweringNumber = defineRoute({
  method: "post",
  path: "/v1/phone-numbers/{id}/stop-answering",
  summary: "Hand a number's calls back to where they went before",
  description:
    "Only for a number that was answered here rather than bought here. Puts back the call settings it had at Twilio before, and never releases the number at the carrier, which would give it away.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: NumberAnswered,
});

export const phoneMenuRoutes = {
  listPhoneMenus, getPhoneMenu, createPhoneMenu, updatePhoneMenu, deletePhoneMenu,
  listRingGroups, createRingGroup, updateRingGroup, deleteRingGroup,
  listAnsweringPhones, setAnsweringPhone,
  answerNumberHere, stopAnsweringNumber,
} as const;
