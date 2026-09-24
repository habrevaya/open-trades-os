import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, Address, PageRequest, pageOf, Timestamps } from "./common";

/**
 * Properties are a first class resource, not a field on a customer.
 *
 * A property changes owners. A customer owns many. A landlord has forty. The
 * link between them carries a role and a validity window so ownership history
 * survives a sale, which is what makes a ten year service record worth
 * anything.
 */
export const PropertyRole = z.enum(["owner", "tenant", "manager", "billing"]);

export const Property = z.object({
  id: Uuid,
  nickname: z.string().nullable(),
  address: Address,
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  territoryId: Uuid.nullable(),
  squareFeet: z.string().nullable(),
  yearBuilt: z.string().nullable(),
  gateCode: z.string().nullable(),
  accessNotes: z.string().nullable(),
  /** Shown to a technician before they get out of the truck. */
  hazardNotes: z.string().nullable(),
  hasDog: z.boolean(),
  customFields: z.record(z.unknown()),
}).merge(Timestamps);

export const PropertyCreate = z.object({
  nickname: z.string().max(100).optional(),
  address: Address,
  squareFeet: z.string().optional(),
  yearBuilt: z.string().optional(),
  gateCode: z.string().max(50).optional(),
  accessNotes: z.string().max(2000).optional(),
  hazardNotes: z.string().max(2000).optional(),
  hasDog: z.boolean().default(false),
  customFields: z.record(z.unknown()).default({}),
  /** Link to a customer on create, with the role they hold. */
  customerId: Uuid.optional(),
  customerRole: PropertyRole.default("owner"),
});

/**
 * A PROPERTY COULD BE CREATED AND NEVER EDITED.
 *
 * There was no update route at all, which made several published fields
 * unreachable rather than merely awkward. `territoryId` could be FILTERED on
 * and never set, so the filter's only possible answer was none. A gate code
 * that changed, a dog that arrived, a hazard a technician found on the third
 * visit: all of it had to be typed into a new property or left wrong.
 *
 * The address is deliberately absent. A property IS its address, the service
 * record is what makes it worth anything, and letting somebody retype it
 * turns one house into another with ten years of history attached. A
 * genuinely wrong address is a correction somebody should have to think
 * about, not a field on a form.
 */
export const updateProperty = defineRoute({
  method: "patch",
  path: "/v1/properties/{id}",
  summary: "Update a property",
  module: "M03",
  permissions: ["property:write"],
  input: z.object({
    id: Uuid,
    nickname: z.string().max(100).nullable().optional(),
    /** Which route this falls in. Filtered on everywhere and settable nowhere until now. */
    territoryId: Uuid.nullable().optional(),
    squareFeet: z.string().max(20).nullable().optional(),
    yearBuilt: z.string().max(10).nullable().optional(),
    gateCode: z.string().max(50).nullable().optional(),
    accessNotes: z.string().max(2000).nullable().optional(),
    /** Shown to a technician before they get out of the truck. */
    hazardNotes: z.string().max(2000).nullable().optional(),
    hasDog: z.boolean().optional(),
    customFields: z.record(z.unknown()).optional(),
  }),
  output: Property,
});

export const listProperties = defineRoute({
  method: "get",
  path: "/v1/properties",
  summary: "List properties",
  module: "M03",
  permissions: ["property:read"],
  input: PageRequest.extend({
    q: z.string().max(200).optional(),
    customerId: Uuid.optional(),
    territoryId: Uuid.optional(),
  }),
  output: pageOf(Property.extend({
    customers: z.array(z.object({ id: Uuid, name: z.string(), role: PropertyRole })),
  })),
});

export const getProperty = defineRoute({
  method: "get",
  path: "/v1/properties/{id}",
  summary: "Get a property",
  module: "M03",
  permissions: ["property:read"],
  input: z.object({ id: Uuid }),
  output: Property.extend({
    customers: z.array(z.object({ id: Uuid, name: z.string(), role: PropertyRole })),
    equipmentCount: z.number().int(),
  }),
});

export const createProperty = defineRoute({
  method: "post",
  path: "/v1/properties",
  summary: "Create a property",
  module: "M03",
  permissions: ["property:write"],
  idempotent: true,
  input: PropertyCreate,
  output: Property,
});

export const linkCustomerToProperty = defineRoute({
  method: "post",
  path: "/v1/properties/{id}/customers",
  summary: "Link a customer to a property",
  description:
    "A property can have several customers in different roles, and ownership can end. Setting endedOn closes a link without deleting the history.",
  module: "M03",
  permissions: ["property:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    customerId: Uuid,
    role: PropertyRole.default("owner"),
    isPrimary: z.boolean().default(true),
    startedOn: z.string().date().optional(),
    endedOn: z.string().date().optional(),
  }),
  output: z.object({ ok: z.literal(true) }),
});

export const propertyRoutes = {
  updateProperty,
  listProperties, getProperty, createProperty, linkCustomerToProperty,
} as const;
