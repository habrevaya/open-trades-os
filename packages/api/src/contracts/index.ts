import { customerRoutes } from "./customers";
import { propertyRoutes } from "./properties";
import { jobRoutes } from "./jobs";
import { priceBookRoutes } from "./pricebook";
import { billingRoutes } from "./billing";
import { estimateRoutes } from "./estimates";
import { portalRoutes } from "./portal";
import { bookingRoutes } from "./booking";
import { fieldRoutes } from "./field";
import { telephonyRoutes } from "./telephony";

export * from "./common";
export * from "./customers";
export * from "./properties";
export * from "./jobs";
export * from "./pricebook";
export * from "./billing";
export * from "./estimates";
export * from "./portal";
export * from "./booking";
export * from "./field";
export * from "./telephony";

/**
 * Every route in the product, and the only description of them.
 *
 * Consumers, stated as what they are rather than as an ambition:
 *
 *   BUILT   The web app, which imports this directly.
 *   BUILT   The HTTP dispatcher in src/http, which serves every route here
 *           and nothing else.
 *   BUILT   The MCP server in src/mcp, which turns each session route into a
 *           tool and hands every call back to that same dispatcher.
 *   NOT YET A generated client library.
 *
 * This comment previously said "one definition, four consumers, no drift",
 * and one of the four existed. It is the shape of claim this codebase treats
 * as a defect: a statement about the system that the system does not support,
 * sitting in the file somebody reads to find out what is true. If a consumer
 * is added or removed, this list changes with it.
 */
export const routes = {
  ...customerRoutes,
  ...propertyRoutes,
  ...jobRoutes,
  ...priceBookRoutes,
  ...billingRoutes,
  ...estimateRoutes,
  ...portalRoutes,
  ...bookingRoutes,
  ...fieldRoutes,
  ...telephonyRoutes,
} as const;

export type RouteName = keyof typeof routes;
export const routeList = Object.values(routes);
