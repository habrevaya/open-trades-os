import { customerRoutes } from "./customers";
import { propertyRoutes } from "./properties";
import { jobRoutes } from "./jobs";
import { priceBookRoutes } from "./pricebook";
import { billingRoutes } from "./billing";
import { estimateRoutes } from "./estimates";
import { portalRoutes } from "./portal";
import { bookingRoutes } from "./booking";
import { fieldRoutes } from "./field";
import { fieldSalesRoutes } from "./field-sales";
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
import { commercialBillingRoutes } from "./commercial-billing";
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
import { financeRoutes } from "./finance";
import { crewRoutes } from "./crews";
import { payrollRoutes } from "./payroll";
import { payRuleRoutes } from "./pay-rules";
import { aiRoutes } from "./ai";
import { agentRoutes } from "./agents";
import { assetRoutes } from "./assets";
import { complianceRoutes } from "./compliance";
import { projectRoutes } from "./projects";
import { projectDocumentRoutes } from "./project-documents";
import { calendarRoutes } from "./calendar";
import { callTrackingRoutes } from "./call-tracking";
import { trackingRoutes } from "./tracking";
import { adsRoutes } from "./ads";
import { companyRoutes } from "./company";
import { readbackRoutes } from "./readbacks";
import { serviceReportRoutes } from "./service-reports";
import { reportRoutes } from "./reports";
import { appRoutes } from "./apps";
import { equipmentRoutes } from "./equipment";
import { taskRoutes } from "./tasks";
import { workflowRoutes } from "./workflows";
import { agreementRoutes } from "./agreements";
import { visitChangeRoutes } from "./visit-changes";
import { inspectionRoutes } from "./inspections";
import { creditNoteRoutes } from "./credit-notes";
import { statementRoutes } from "./statements";
import { pricingAuthorityRoutes } from "./pricing-authority";
import { fieldAssetRoutes } from "./field-assets";
import { campaignRoutes } from "./campaigns";
import { rentalRoutes } from "./rentals";
import { networkRoutes } from "./network";
import { exportRoutes } from "./export";
import { externalWorkRoutes } from "./external-work";
import { kpiRoutes } from "./kpis";
import { visitRoutes } from "./visits";
import { dispatchMapRoutes } from "./dispatch-map";
import { locationRoutes } from "./location";
import { acquisitionRoutes } from "./acquisition";
import { customerTagRoutes } from "./customer-tags";
import { priceBookBulkRoutes } from "./pricebook-bulk";
import { taskRuleRoutes } from "./task-rules";
import { customerPortalRoutes } from "./customer-portal";
import { portalAccessRoutes } from "./portal-access";
import { setupRoutes } from "./setup";
import { branchRoutes } from "./branches";
import { phoneMenuRoutes } from "./phone-menus";
import { safetyRoutes } from "./safety";
import { retentionRoutes } from "./retention";
import { stockTrackingRoutes } from "./stock-tracking";
import { purchasingRoutes } from "./purchasing";
import { rentalBillingRoutes } from "./rental-billing";
import { peopleRecordRoutes } from "./people-records";

export * from "./common";
export * from "./visits";
export * from "./customers";
export * from "./properties";
export * from "./jobs";
export * from "./pricebook";
export * from "./billing";
export * from "./estimates";
export * from "./portal";
export * from "./booking";
export * from "./field";
export * from "./field-sales";
export * from "./telephony";
export * from "./inventory";
export * from "./labor";
export * from "./obligations";
export * from "./files";
export * from "./marketing";
export * from "./acquisition";
export * from "./connectors";
export * from "./reviews";
export * from "./recurring";
export * from "./people";
export * from "./contracts";
export * from "./commercial-billing";
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
export * from "./finance";
export * from "./crews";
export * from "./payroll";
export * from "./pay-rules";
export * from "./ai";
export * from "./agents";
export * from "./assets";
export * from "./compliance";
export * from "./projects";
export * from "./project-documents";
export * from "./calendar";
export * from "./call-tracking";
export * from "./tracking";
export * from "./company";
export * from "./readbacks";
export * from "./service-reports";
export * from "./reports";
export * from "./safety";
export * from "./retention";
export * from "./apps";
export * from "./pricing-authority";
export * from "./field-assets";
export * from "./credit-notes";
export * from "./statements";
export * from "./dispatch-map";
export * from "./location";
export * from "./agreements";
export * from "./visit-changes";
export * from "./customer-tags";
export * from "./pricebook-bulk";
export * from "./task-rules";
export * from "./customer-portal";
export * from "./portal-access";
export * from "./setup";
export * from "./branches";
export * from "./phone-menus";
export * from "./tasks";
export * from "./ads";
export * from "./stock-tracking";
export * from "./purchasing";
export * from "./rental-billing";
export * from "./people-records";

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
  ...creditNoteRoutes,
  ...statementRoutes,
  ...estimateRoutes,
  ...portalRoutes,
  ...bookingRoutes,
  ...fieldRoutes,
  ...fieldSalesRoutes,
  ...telephonyRoutes,
  ...inventoryRoutes,
  ...laborRoutes,
  ...obligationRoutes,
  ...fileRoutes,
  ...marketingRoutes,
  ...acquisitionRoutes,
  ...connectorRoutes,
  ...reviewRoutes,
  ...recurringRoutes,
  ...peopleRoutes,
  ...contractRoutes,
  ...commercialBillingRoutes,
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
  ...financeRoutes,
  ...crewRoutes,
  ...payrollRoutes,
  ...payRuleRoutes,
  ...aiRoutes,
  ...agentRoutes,
  ...assetRoutes,
  ...complianceRoutes,
  ...projectRoutes,
  ...projectDocumentRoutes,
  ...calendarRoutes,
  ...callTrackingRoutes,
  ...trackingRoutes,
  ...phoneMenuRoutes,
  ...companyRoutes,
  ...readbackRoutes,
  ...serviceReportRoutes,
  ...appRoutes,
  ...equipmentRoutes,
  ...taskRoutes,
  ...workflowRoutes,
  ...agreementRoutes,
  ...visitChangeRoutes,
  ...inspectionRoutes,
  ...pricingAuthorityRoutes,
  ...fieldAssetRoutes,
  ...campaignRoutes,
  ...rentalRoutes,
  ...networkRoutes,
  ...exportRoutes,
  ...externalWorkRoutes,
  ...kpiRoutes,
  ...visitRoutes,
  ...dispatchMapRoutes,
  ...locationRoutes,
  ...reportRoutes,
  ...customerTagRoutes,
  ...priceBookBulkRoutes,
  ...taskRuleRoutes,
  ...customerPortalRoutes,
  ...portalAccessRoutes,
  ...setupRoutes,
  ...branchRoutes,
  ...adsRoutes,
  ...safetyRoutes,
  ...retentionRoutes,
  ...stockTrackingRoutes,
  ...purchasingRoutes,
  ...rentalBillingRoutes,
  ...peopleRecordRoutes,
} as const;

export type RouteName = keyof typeof routes;
export const routeList = Object.values(routes);
