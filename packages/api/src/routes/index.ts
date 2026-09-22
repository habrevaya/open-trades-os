import type { z } from "zod";
import { routes, type RouteName } from "../contracts/index";
import type { RouteDefinition, AuthOf } from "../lib/define";
import type { ServiceContext } from "../services/context";
import type { Database } from "@opentradesos/db";
import {
  customers, jobs, billing, estimates, deposits, portal, booking,
  fieldOps, dispatch,
} from "../services/index";

/**
 * WHERE A ROUTE MEETS ITS IMPLEMENTATION
 *
 * One table, so a declared route with nothing behind it is a compile error
 * rather than a 404 somebody finds in production. The contract layer is the
 * public promise of this product; a promise with no implementation is worse
 * than no promise, because an SDK and an MCP tool list are generated from it
 * and both will offer the endpoint.
 *
 * Three handler shapes, matching the three ways a caller can be authorized:
 *
 *   session   takes a ServiceContext. The service checks the permission.
 *   grant     takes a Database and the request, and resolves the token itself.
 *   public    takes a Database. No caller identity exists at all.
 *
 * The shapes are kept apart deliberately. A session handler and a grant
 * handler have different first arguments, so wiring one where the other
 * belongs does not compile, and the common way to turn an authenticated
 * endpoint into an open one is exactly that mistake.
 */

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type SessionHandler<R> = R extends RouteDefinition<infer I, infer O>
  ? (ctx: ServiceContext, input: z.infer<I>) => Promise<z.infer<O>>
  : never;

export type OpenHandler<R> = R extends RouteDefinition<infer I, infer O>
  ? (db: Database, input: z.infer<I>, meta?: RequestMeta) => Promise<z.infer<O>>
  : never;

/**
 * What a handler for a given route must look like.
 *
 * The ARGUMENTS are checked and the return type is not. A service returning a
 * redacted view of its own contract is correct rather than a mismatch to paper
 * over: what a technician gets back from getEstimate genuinely is not what the
 * contract's full shape says, and that is the redaction layer working.
 *
 * The arguments are where the dangerous mistakes live. A grant handler wired
 * to a session route, or a handler accepting an input the contract never
 * validates, both stop compiling here.
 */
type HandlerFor<N extends RouteName> =
  (typeof routes)[N] extends RouteDefinition<infer I, z.ZodTypeAny, infer _A>
    ? AuthOf<(typeof routes)[N]> extends "session"
      ? (ctx: ServiceContext, input: z.infer<I>) => Promise<unknown>
      : (db: Database, input: z.infer<I>, meta?: RequestMeta) => Promise<unknown>
    : never;

/**
 * Every route, with what serves it.
 */
export const handlers = {
  // Customers
  createCustomer: customers.create,
  getCustomer: customers.get,
  listCustomers: customers.list,
  updateCustomer: customers.update,

  // Work
  createJob: jobs.create,
  getJob: jobs.get,
  listJobs: jobs.list,
  scheduleVisit: jobs.addVisit,
  completeVisit: jobs.complete,

  // Money
  createInvoice: billing.create,
  getInvoice: billing.get,
  listInvoices: billing.list,
  recordPayment: billing.pay,
  getArAging: billing.arAging,

  // Sell
  createEstimate: estimates.create,
  getEstimate: estimates.get,
  listEstimates: estimates.list,
  sendEstimate: estimates.send,
  approveEstimate: estimates.approve,
  declineEstimate: estimates.decline,
  convertEstimate: estimates.convert,
  requestDeposit: deposits.request,
  applyDeposit: deposits.apply,
  refundDeposit: deposits.refund,

  // The customer side. Database first, never a ServiceContext.
  openPortalLink: portal.openLink,
  viewPortalEstimate: portal.viewEstimate,
  approvePortalEstimate: portal.approveEstimate,
  declinePortalEstimate: portal.declineEstimate,
  viewPortalJob: portal.viewJob,
  issuePortalGrant: portal.issueGrant,
  revokePortalGrant: portal.revokeGrant,

  // The field. The phone carries field:sync; the board is office side.
  registerDevice: fieldOps.register,
  syncOperations: fieldOps.sync,
  getFieldSnapshot: dispatch.snapshot,
  listConflicts: fieldOps.conflicts,
  resolveConflict: fieldOps.resolve,

  // Dispatch
  getDispatchBoard: dispatch.board,
  assignVisit: dispatch.assign,
  reorderRoute: dispatch.reorder,
  sendArrivalNotice: dispatch.onMyWay,

  // Public
  listBookableServices: booking.listServices,
  getAvailability: booking.availability,
  createBookingRequest: booking.createRequest,
  listBookingRequests: booking.listRequests,
  confirmBookingRequest: booking.confirm,
  declineBookingRequest: booking.decline,
  configureBookableService: booking.configureService,
} as const satisfies { [N in RouteName]?: HandlerFor<N> };

export type ImplementedRoute = keyof typeof handlers;

/**
 * Routes that are declared and deliberately not yet served.
 *
 * Every name here is a promise the contract makes and the code does not keep,
 * so the list is not a backlog: it is the thing the test below prints when it
 * fails, and it should only ever shrink. Adding a route to the contracts
 * without adding it here or to `handlers` turns the suite red.
 */
export const PENDING_ROUTES: readonly RouteName[] = [
  // Properties. The tables and the row level security exist; the service does
  // not, so the contract currently promises four endpoints that answer
  // nothing. Phase 3, with the dispatch board that needs them.
  "createProperty", "getProperty", "listProperties", "linkCustomerToProperty",
  // Editing a job after it is booked. Phase 3.
  "updateJob",
  // Authoring the price book by hand, rather than applying a trade pack.
  // Phase 4, when the first design partners need prices we did not ship.
  "createPriceBookItem", "revisePriceBookItem",
  // Reading the price book. The trade-pack service writes one and nothing
  // reads it back yet; mapping this to applyTradePack, which is what the first
  // draft of this file did, is a different endpoint wearing the right name.
  "listPriceBook",
] as const;

export const routeNames = Object.keys(routes) as RouteName[];
