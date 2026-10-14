import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * EACH TRUCK ITS OWN KIND: how many containers it carries, which sizes it
 * lifts and how long the yard takes it, so a driver's day is planned on the
 * truck the driver has.
 */

/** "Two 10 yard": how many of one size the truck carries at once. */
const SizeCapacity = z.object({ size: z.number().int().min(1).max(100), carried: z.number().int().min(1).max(4) });

const TruckKind = z.object({
  id: Uuid,
  name: z.string(),
  /** Containers carried at once. */
  containersCarried: z.number().int().min(1).max(4),
  /** Cubic yards the truck can lift. Empty means any size. */
  containerSizes: z.array(z.number().int()),
  /** How many of each size it carries at once ("two 10 yard or one 30 yard"). Empty when the one figure counts every size. */
  capacityBySize: z.array(SizeCapacity),
  /** Minutes at the yard to tip what is full and load what is needed. */
  yardMinutes: z.number().int().min(0).max(120),
  notes: z.string().nullable(),
  /** Trucks on the register with this kind that have not been retired. */
  trucks: z.array(z.object({ id: Uuid, label: z.string() })),
});

const KindFigures = {
  name: z.string().min(1).max(100),
  containersCarried: z.number().int().min(1).max(4),
  containerSizes: z.array(z.number().int().min(1).max(100)).max(12).optional(),
  /**
   * How many of each size it carries at once, when that differs by size: each can takes its share of the truck, and a
   * load fits while the shares make the whole truck or less. A size listed here is one it lifts. A can of a size not
   * listed, or of no known size, counts against `containersCarried`.
   */
  capacityBySize: z.array(SizeCapacity).max(12).optional(),
  yardMinutes: z.number().int().min(0).max(120),
  notes: z.string().max(1000).nullable().optional(),
};

export const listTruckKinds = defineRoute({
  method: "get",
  path: "/v1/truck-kinds",
  summary: "The kinds of truck the company runs",
  description:
    "How many containers each kind of truck carries, which sizes it lifts and how long the yard takes it, with how many trucks on the register have it. The company's own figures (`GET /v1/rental-dispatch`) are the default for a truck with no kind.",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({}),
  output: z.object({ kinds: z.array(TruckKind) }),
});

export const createTruckKind = defineRoute({
  method: "post",
  path: "/v1/truck-kinds",
  summary: "Add a kind of truck",
  description:
    "A name, how many containers it carries at once (one to four), the sizes in cubic yards it can lift (none listed means any), how many of each size it carries when that differs by size (`capacityBySize`: two 10 yard or one 30 yard, so a 10 beside a 30 does not fit) and the minutes the yard takes it. Two kinds with one name are refused.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object(KindFigures),
  output: TruckKind,
});

export const updateTruckKind = defineRoute({
  method: "patch",
  path: "/v1/truck-kinds/{id}",
  summary: "Change a kind of truck",
  description:
    "Any field left out keeps its value. Every truck of this kind is planned on the new figures the next time a day is optimised; a day already ordered is not reordered.",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({ id: Uuid, ...KindFigures }).partial({ name: true, containersCarried: true, yardMinutes: true }),
  output: TruckKind,
});

export const retireTruckKind = defineRoute({
  method: "delete",
  path: "/v1/truck-kinds/{id}",
  summary: "Take a kind of truck off the list",
  description: "Refused while a truck on the register still has the kind, naming the trucks.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, retired: z.boolean() }),
});

export const setAssetTruckKind = defineRoute({
  method: "put",
  path: "/v1/assets/{assetId}/truck-kind",
  summary: "Say what kind of truck a vehicle is",
  description:
    "`truckKindId: null` says it has none, and a driver holding it is planned on the company's figures. Only a vehicle that has not been retired can have a kind. The driver's truck on a day is the vehicle with a kind that is in their custody that day (`POST /v1/assets/{assetId}/check-out`), and `GET /v1/dispatch/optimise` says which truck and which figures it used.",
  module: "M22",
  permissions: ["asset:write"],
  input: z.object({ assetId: Uuid, truckKindId: Uuid.nullable() }),
  output: z.object({ id: Uuid, label: z.string(), truckKindId: Uuid.nullable() }),
});

export const truckRoutes = {
  listTruckKinds, createTruckKind, updateTruckKind, retireTruckKind, setAssetTruckKind,
} as const;
