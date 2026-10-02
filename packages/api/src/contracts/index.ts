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
import { inventoryRoutes } from "./inventory";
import { laborRoutes } from "./labor";
import { obligationRoutes } from "./obligations";
import { fileRoutes } from "./files";
import { marketingRoutes } from "./marketing";
import { connectorRoutes } from "./connectors";
import { reviewRoutes } from "./reviews";
import { recurringRoutes } from "./recurring";
import { peopleRoutes } from "./people";
import { contractRoutes } from "./contracts";
import { webhookRoutes } from "./webhooks";
import { customFieldRoutes } from "./custom-fields";
import { paymentRoutes } from "./payments";
import { emailRoutes } from "./email";
import { accountingRoutes } from "./accounting";
import { messagingRoutes } from "./messaging";
import { conversationRoutes } from "./conversations";
import { leadConnectorRoutes } from "./lead-connectors";
import { invoiceDeliveryRoutes } from "./invoice-delivery";
import { profitabilityRoutes } from "./profitability";
import { crewRoutes } from "./crews";
import { payrollRoutes } from "./payroll";
import { aiRoutes } from "./ai";
import { assetRoutes } from "./assets";
import { complianceRoutes } from "./compliance";
import { projectRoutes } from "./projects";
import { calendarRoutes } from "./calendar";
import { callTrackingRoutes } from "./call-tracking";
import { companyRoutes } from "./company";
import { readbackRoutes } from "./readbacks";
import { serviceReportRoutes } from "./service-reports";
import { appRoutes } from "./apps";
import { pricingAuthorityRoutes } from "./pricing-authority";
import { fieldAssetRoutes } from "./field-assets";
import { campaignRoutes } from "./campaigns";
import { rentalRoutes } from "./rentals";
import { networkRoutes } from "./network";
import { exportRoutes } from "./export";
import { externalWorkRoutes } from "./external-work";

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
export * from "./inventory";
export * from "./labor";
export * from "./obligations";
export * from "./files";
export * from "./marketing";
export * from "./connectors";
export * from "./reviews";
export * from "./recurring";
export * from "./people";
export * from "./contracts";
export * from "./webhooks";
export * from "./custom-fields";
export * from "./payments";
export * from "./email";
export * from "./accounting";
export * from "./messaging";
export * from "./conversations";
export * from "./lead-connectors";
export * from "./invoice-delivery";
export * from "./profitability";
export * from "./crews";
export * from "./payroll";
export * from "./ai";
export * from "./assets";
export * from "./compliance";
export * from "./projects";
export * from "./calendar";
export * from "./call-tracking";
export * from "./company";
export * from "./readbacks";
export * from "./service-reports";
export * from "./apps";
export * from "./pricing-authority";
export * from "./field-assets";

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
  ...inventoryRoutes,
  ...laborRoutes,
  ...obligationRoutes,
  ...fileRoutes,
  ...marketingRoutes,
  ...connectorRoutes,
  ...reviewRoutes,
  ...recurringRoutes,
  ...peopleRoutes,
  ...contractRoutes,
  ...webhookRoutes,
  ...customFieldRoutes,
  ...paymentRoutes,
  ...emailRoutes,
  ...accountingRoutes,
  ...messagingRoutes,
  ...conversationRoutes,
  ...leadConnectorRoutes,
  ...invoiceDeliveryRoutes,
  ...profitabilityRoutes,
  ...crewRoutes,
  ...payrollRoutes,
  ...aiRoutes,
  ...assetRoutes,
  ...complianceRoutes,
  ...projectRoutes,
  ...calendarRoutes,
  ...callTrackingRoutes,
  ...companyRoutes,
  ...readbackRoutes,
  ...serviceReportRoutes,
  ...appRoutes,
  ...pricingAuthorityRoutes,
  ...fieldAssetRoutes,
  ...campaignRoutes,
  ...rentalRoutes,
  ...networkRoutes,
  ...exportRoutes,
  ...externalWorkRoutes,
} as const;

export type RouteName = keyof typeof routes;
export const routeList = Object.values(routes);
