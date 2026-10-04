import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * A CUSTOMER'S PEOPLE (M03)
 *
 * Who authorises the work, who is on site, who gets the "on the way" text.
 * These were added, removed and made primary on the customer's page and
 * nowhere else, so an integration bringing a property manager's tenants
 * across had nowhere to put them. The routes run the same service functions
 * the page does, so the rules are the page's: a contact belongs to the
 * customer in the path, is at an address only when the address is one of
 * that customer's, needs a phone or an email and a preferred channel it can
 * actually be reached on, is removed softly so old messages still name them,
 * and one primary per customer and per address, the old one demoted when a
 * new one is made.
 */

const Channel = z.enum(["sms", "email", "voice"]);

export const Contact = z.object({
  id: Uuid,
  customerId: Uuid.nullable(),
  propertyId: Uuid.nullable(),
  name: z.string(),
  title: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  preferredChannel: z.string(),
  isPrimary: z.boolean(),
  /** Whether the office lets them sign in to the customer's portal (M05). */
  portalAccess: z.boolean(),
});

export const listCustomerContacts = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/contacts",
  summary: "The people at a customer",
  description:
    "Ordered the way the \"on the way\" text picks its recipient, primary first and texts before email, so the first one listed is the person who would be told. `noticeRank` is that order as a number.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ contacts: z.array(Contact.extend({ noticeRank: z.number().int() })) }),
});

const ContactFields = {
  name: z.string().min(1).max(200),
  title: z.string().max(100).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  preferredChannel: Channel.optional(),
  /** One of this customer's addresses, when the person is at one place rather than the whole account. */
  propertyId: Uuid.nullable().optional(),
};

export const addCustomerContact = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/contacts",
  summary: "Add a person to a customer",
  description:
    "A phone or an email is required, and the preferred channel has to be one they can be reached on: preferring texts with no phone number is refused rather than guessed at. An address has to be one of this customer's. `isPrimary` makes them the first person told, and whoever was primary before stops being. A retry with the same idempotency key returns the first answer.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ id: Uuid, ...ContactFields, isPrimary: z.boolean().optional() }),
  output: Contact,
});

export const updateContact = defineRoute({
  method: "patch",
  path: "/v1/contacts/{id}",
  summary: "Change a person's details",
  description:
    "Only what is sent changes, and the result is checked as a whole: clearing the phone of somebody who prefers texts is refused. Who they belong to is not changed here, and neither is whether they are primary, which has its own route because it changes somebody else too.",
  module: "M03",
  permissions: ["customer:write"],
  input: z.object({
    id: Uuid,
    name: ContactFields.name.optional(),
    title: ContactFields.title,
    email: ContactFields.email,
    phone: ContactFields.phone,
    preferredChannel: ContactFields.preferredChannel,
    propertyId: ContactFields.propertyId,
  }),
  output: Contact,
});

export const removeContact = defineRoute({
  method: "post",
  path: "/v1/contacts/{id}/remove",
  summary: "Take a person off a customer",
  description:
    "Kept rather than deleted, so a text sent to them last spring still names who it went to, and they stop being anybody's primary. A retry with the same idempotency key returns the first answer.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const makeContactPrimary = defineRoute({
  method: "post",
  path: "/v1/contacts/{id}/primary",
  summary: "Make a person the one told first",
  description:
    "Primary for their customer, and for their address when they are tied to one; whoever was primary for either stops being. Sending it again changes nothing.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Contact,
});

export const contactRoutes = {
  listCustomerContacts, addCustomerContact, updateContact, removeContact, makeContactPrimary,
} as const;
