import { customerRoutes } from "./customers";
import { propertyRoutes } from "./properties";
import { jobRoutes } from "./jobs";
import { priceBookRoutes } from "./pricebook";
import { billingRoutes } from "./billing";
import { estimateRoutes } from "./estimates";
import { portalRoutes } from "./portal";
import { bookingRoutes } from "./booking";

export * from "./common";
export * from "./customers";
export * from "./properties";
export * from "./jobs";
export * from "./pricebook";
export * from "./billing";
export * from "./estimates";
export * from "./portal";
export * from "./booking";

/**
 * Every route in the product. The web app consumes this, the OpenAPI document
 * is generated from it, the SDK is generated from that, and the MCP server
 * exposes it as tools. One definition, four consumers, no drift.
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
} as const;

export type RouteName = keyof typeof routes;
export const routeList = Object.values(routes);
