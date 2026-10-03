import type { z } from "zod";
import { routes, type RouteName } from "../contracts/index";
import type { RouteDefinition, AuthOf } from "../lib/define";
import type { ServiceContext } from "../services/context";
import type { Database } from "@opentradesos/db";
import {
  customers, jobs, billing, estimates, deposits, portal, booking,
  fieldOps, fieldDevices, fieldPayments, dispatch, properties, priceBook, telephony, inventory, labor,
  obligations, files, marketing, leadIntake, forms, reviews, recurring,
  roles as roleService, contracts as contractService, customFields, webhooks, payments, email, accounting,
  messageTemplates, messagingRegistration, leadConnectors,
  invoiceDelivery, profitability, crews, serviceRoutes, onCall, commissions, payroll, ai, assets, compliance,
  people, projects, calendar, callTracking, company, timeOff, auditLog, ledgerReports, serviceReports,
  apps, comms, consent, equipment, customerLifecycle, tasks, workflows, inspections, creditNotes, statements, visitAssets, deliveries, campaigns, unsubscribe, rentals, network, dataExport, externalWork, kpis,
  dispatchMap, geocoding,
  reports, deliverySchedules, statementDelivery,
  agreements, visitChanges, vendorCatalogue, proposals,
  acquisition, marketingReport, phoneNumbers,
  customerTags, customerDuplicates, priceCategories, repricing, taskRules, taskChecklist,
  laborSettings,
  voice, websiteTracking, referrals,
  portalSignIn, portalSettings, savedCards, tips, portalAccount,
  setup, team, branches, tradePacks,
  phoneMenus, transcription,
  ads,
  agents, agentIntake, agentChat, agentEstimates, agentCollections, agentDispatch,
  projectChangeOrders, projectApplications, projectLiens, projectSchedule,
  rateCards, jobBilling, claims, payerDelivery,
  safety, retention,
  stockUnits, purchaseApprovals, purchaseOrderEmail, rentalBilling, peopleRecords,
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

import type { RequestMeta } from "../services/context";
export type { RequestMeta };

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

  // Properties
  createProperty: properties.create,
  getProperty: properties.get,
  listProperties: properties.list,
  linkCustomerToProperty: properties.link,

  // Price book
  listPriceBook: priceBook.list,
  createPriceBookItem: priceBook.create,
  revisePriceBookItem: priceBook.revise,
  getPriceBookItem: (ctx, input) => priceBook.detail(ctx, input),
  updatePriceBookItem: priceBook.updateItem,

  // Work
  createJob: jobs.create,
  getJob: jobs.get,
  listJobs: jobs.list,
  updateJob: jobs.update,
  scheduleVisit: jobs.addVisit,
  completeVisit: jobs.complete,
  listJobLines: jobs.lines,
  listJobTypes: jobs.listTypes,

  // Money
  createInvoice: billing.create,
  getInvoice: billing.get,
  listInvoices: billing.list,
  recordPayment: billing.pay,
  applyPayment: billing.applyPayment,
  recordRefund: billing.recordRefund,
  voidInvoice: billing.voidInvoice,
  updateInvoice: billing.updateDraft,
  issueInvoice: billing.issue,
  deleteInvoice: billing.deleteDraft,
  writeOffInvoice: billing.writeOff,
  getArAging: billing.arAging,

  // Sell
  createEstimate: estimates.create,
  getEstimate: estimates.get,
  listEstimates: estimates.list,
  sendEstimate: estimates.send,
  approveEstimate: estimates.approve,
  declineEstimate: estimates.decline,
  convertEstimate: estimates.convert,
  listUnsoldEstimates: estimates.unsoldHandler,
  listEstimateDeliveries: async (ctx, input) => ({ deliveries: await estimates.deliveries(ctx, input) }),
  getProposalTerms: (ctx) => estimates.proposalTerms(ctx),
  getEstimateProposal: (ctx, input) => proposals.proposal(ctx, input),
  setProposalTerms: (ctx, input) => estimates.setProposalTerms(ctx, input),
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
  signInDevice: fieldDevices.signIn,
  listDevices: fieldDevices.list,
  signOutDevice: fieldDevices.signOut,
  revokeDevice: fieldDevices.revoke,
  requestSignInCode: fieldDevices.requestCode,
  signInWithCode: fieldDevices.signInWithCodeFor,
  setTechnicianMobile: fieldDevices.setMobile,
  listFieldPeople: fieldDevices.people,
  visitPaymentLink: fieldPayments.paymentLink,
  syncOperations: fieldOps.sync,
  getFieldSnapshot: dispatch.snapshot,
  listConflicts: fieldOps.conflicts,
  resolveConflict: fieldOps.resolve,

  // Commercial contracts. Whose price governs, when it is not ours.
  listContracts: contractService.handlers.listContracts,
  createContract: contractService.handlers.createContract,
  addContractSite: contractService.handlers.addContractSite,
  createRateCard: contractService.handlers.createRateCard,
  setRateCardLines: contractService.handlers.setRateCardLines,
  listRateCardLines: contractService.handlers.listRateCardLines,
  resolveContractPrice: contractService.handlers.resolveContractPrice,
  getPropertyCeiling: contractService.handlers.getPropertyCeiling,
  updateContract: contractService.handlers.updateContract,

  // Commercial and warranty billing
  getRateCardTerms: rateCards.handlers.getRateCardTerms,
  setRateCardTerms: rateCards.handlers.setRateCardTerms,
  previewJobBilling: jobBilling.handlers.previewJobBilling,
  billJob: jobBilling.handlers.billJob,
  setJobContract: jobBilling.handlers.setJobContract,
  listJobClocks: jobBilling.handlers.listJobClocks,
  setJobParties: jobBilling.handlers.setJobParties,
  setJobCoverage: jobBilling.handlers.setJobCoverage,
  resolveCoverageFromEquipment: jobBilling.handlers.resolveCoverageFromEquipment,
  listClaims: claims.handlers.listClaims,
  getClaim: claims.handlers.getClaim,
  fileClaim: claims.handlers.fileClaim,
  decideClaim: claims.handlers.decideClaim,
  recordClaimPayment: claims.handlers.recordClaimPayment,
  exportPayerInvoices: payerDelivery.handlers.exportPayerInvoices,
  issuePayerPortalLink: payerDelivery.handlers.issuePayerPortalLink,
  viewPayerPortal: payerDelivery.handlers.viewPayerPortal,

  // Things a published field needed before it could ever be written.
  updateProperty: properties.update,
  setPriceBookItemActive: priceBook.setActive,
  setMembershipActive: roleService.setMembershipActive,

  // Recurring work. Four models because reconstructing the wrong one
  // silently drifts every future date, and only one future occurrence is
  // knowable for the model measured from completion.
  listRecurringSchedules: recurring.handlers.listRecurringSchedules,
  createRecurringSchedule: recurring.handlers.createRecurringSchedule,
  previewRecurringSchedule: recurring.handlers.previewRecurringSchedule,
  materialiseRecurringSchedule: recurring.handlers.materialiseRecurringSchedule,
  recordRecurringCompletion: recurring.handlers.recordRecurringCompletion,
  exceptRecurringOccurrence: recurring.handlers.exceptRecurringOccurrence,
  setRecurringScheduleActive: recurring.handlers.setRecurringScheduleActive,
  listRecurringDue: recurring.handlers.listRecurringDue,

  // Reviews. No endpoint here can carry a predicted rating, because asking
  // only the customers who will say something nice is what gets a listing
  // wiped, and an absent field is a better defence than a policy.
  setReviewPolicy: reviews.handlers.setReviewPolicy,
  listReviewPlatforms: reviews.handlers.listReviewPlatforms,
  setReviewPlatform: reviews.handlers.setReviewPlatform,
  requestReview: reviews.handlers.requestReview,
  listDueRequests: reviews.handlers.listDueRequests,
  markRequestSent: reviews.handlers.markRequestSent,
  listWithheld: reviews.handlers.listWithheld,
  recordReview: reviews.handlers.recordReview,
  getReviewWorkList: reviews.handlers.getReviewWorkList,
  respondToReview: reviews.handlers.respondToReview,
  markReviewRecovered: reviews.handlers.markReviewRecovered,
  getRating: reviews.handlers.getRating,
  getRatingByTechnician: reviews.handlers.getRatingByTechnician,

  // Forms. A refused submission is a row, because a form that drops what
  // it cannot parse is a form whose losses are invisible.
  listForms: forms.handlers.listForms,
  saveForm: forms.handlers.saveForm,
  submitForm: forms.handlers.submitForm,
  listSubmissions: forms.handlers.listSubmissions,
  getFormRefusals: forms.handlers.getFormRefusals,

  // The loop closed: booked jobs reported back to the account that bought them.
  getConversions: marketing.conversionHandlers.getConversions,

  // Connectors. State and connected are two fields, so neither can lie.
  listConnectors: leadIntake.handlers.listConnectors,
  connectConnector: leadIntake.handlers.connectConnector,
  disconnectConnector: leadIntake.handlers.disconnectConnector,
  importSpendFile: leadIntake.handlers.importSpendFile,
  listLeadOffers: leadIntake.handlers.listLeadOffers,
  acceptLeadOffer: leadIntake.handlers.acceptLeadOffer,
  declineLeadOffer: leadIntake.handlers.declineLeadOffer,

  // Marketing. The touch is kept whole, and no model is the house model.
  listTouches: marketing.handlers.listTouches,
  getJobAttribution: marketing.handlers.getJobAttribution,
  recordSpend: marketing.handlers.recordSpend,
  importSpend: marketing.handlers.importSpend,
  getPerformance: marketing.handlers.getPerformance,
  listUnplacedSources: marketing.handlers.listUnplacedSources,
  listSpend: marketing.handlers.listSpend,
  removeSpend: marketing.handlers.removeSpend,

  // Channel > tracking campaign > tracking number, and the funnel across them.
  listChannels: (ctx: ServiceContext, input: { include?: "live" | "all" | undefined }) =>
    acquisition.handlers.listChannels(ctx, { includeArchived: input.include === "all" }),
  listChannelOptions: acquisition.handlers.listChannelOptions,
  createChannel: acquisition.handlers.createChannel,
  updateChannel: acquisition.handlers.updateChannel,
  listTrackingCampaigns: (ctx: ServiceContext, input: {
    channelId?: string | undefined; include?: "live" | "all" | undefined;
  }) => acquisition.handlers.listTrackingCampaigns(ctx, {
    ...(input.channelId ? { channelId: input.channelId } : {}),
    includeArchived: input.include === "all",
  }),
  getTrackingCampaign: acquisition.handlers.getTrackingCampaign,
  createTrackingCampaign: acquisition.handlers.createTrackingCampaign,
  updateTrackingCampaign: acquisition.handlers.updateTrackingCampaign,
  getMarketingSettings: acquisition.handlers.getMarketingSettings,
  setMarketingSettings: acquisition.handlers.setMarketingSettings,
  getMarketingFunnel: marketingReport.handlers.getMarketingFunnel,
  drillMarketingFunnel: marketingReport.handlers.drillMarketingFunnel,
  listMarketingCalls: marketingReport.handlers.listMarketingCalls,
  getMarketingCall: marketingReport.handlers.getMarketingCall,
  listTrackingNumbers: async (ctx: ServiceContext) => ({ numbers: await phoneNumbers.trackingUsage(ctx) }),
  assignTrackingNumber: phoneNumbers.handlers.assignTrackingNumber,

  // Files. Content addressed, so a phone retrying over a metered connection
  // lands on the key it already occupies.
  listAttachments: files.handlers.listAttachments,
  uploadAttachment: files.handlers.uploadAttachment,
  listPendingUploads: files.handlers.listPendingUploads,
  storeUpload: files.handlers.storeUpload,
  failUpload: files.handlers.failUpload,
  getUploadStatus: files.handlers.getUploadStatus,

  // Deadlines. Overdue is computed on read, never taken from the stored
  // state, so the sweep going quiet delays a stamp and never hides work.
  listObligations: obligations.handlers.listObligations,
  satisfyObligation: obligations.handlers.satisfyObligation,
  waiveObligation: obligations.handlers.waiveObligation,
  sweepObligations: obligations.handlers.sweepObligations,

  // Stock. Every write appends a movement; no route sets a level, because
  // levels are a fold over the movements and a setter destroys the evidence.
  listStockLevels: inventory.handlers.listStockLevels,
  listCommitments: inventory.handlers.listCommitments,
  reserveStock: inventory.handlers.reserveStock,
  releaseStock: inventory.handlers.releaseStock,
  issueStock: inventory.handlers.issueStock,
  receiveStock: inventory.handlers.receiveStock,
  countStock: inventory.handlers.countStock,
  transferStock: inventory.handlers.transferStock,
  listReorderSuggestions: inventory.handlers.listReorderSuggestions,
  getJobMaterialCost: inventory.handlers.getJobMaterialCost,
  listVendors: inventory.handlers.listVendors,
  createVendor: inventory.handlers.createVendor,
  listPurchaseOrders: inventory.handlers.listPurchaseOrders,
  createPurchaseOrder: inventory.handlers.createPurchaseOrder,
  getPurchaseOrder: inventory.handlers.getPurchaseOrder,
  listVendorItems: vendorCatalogue.handlers.listVendorItems,
  setVendorItem: vendorCatalogue.handlers.setVendorItem,
  removeVendorItem: vendorCatalogue.handlers.removeVendorItem,
  previewVendorCatalogue: vendorCatalogue.handlers.previewVendorCatalogue,
  applyVendorCatalogue: vendorCatalogue.handlers.applyVendorCatalogue,
  setPurchaseOrderStatus: inventory.handlers.setPurchaseOrderStatus,
  receivePurchaseOrder: inventory.handlers.receivePurchaseOrder,

  // Time. The week is derived on every read; the rate is frozen once.
  getTimesheetWeek: labor.handlers.getTimesheetWeek,
  listTimeEntries: labor.handlers.listTimeEntries,
  approveTimeEntries: labor.handlers.approveTimeEntries,

  // Voice. Both gates run before the thing they gate, never after.
  listRecordingPolicies: telephony.handlers.listRecordingPolicies,
  setRecordingPolicy: telephony.handlers.setRecordingPolicy,
  removeRecordingPolicy: telephony.handlers.removeRecordingPolicy,
  logCall: telephony.handlers.logCall,
  listCalls: telephony.handlers.listCalls,
  getCall: telephony.handlers.getCall,
  decideRecording: telephony.handlers.decideRecording,
  attachRecording: telephony.handlers.attachRecording,
  deleteRecording: telephony.handlers.deleteRecording,
  attachTranscript: telephony.handlers.attachTranscript,
  transcribeCall: transcription.handlers.transcribeCall,

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
  createBookableService: booking.createService,
  setArrivalWindows: booking.setWindows,
  setBusinessHours: booking.setHours,

  defineCustomField: customFields.handlers.defineCustomField,
  listCustomFields: customFields.handlers.listCustomFields,
  updateCustomField: customFields.handlers.updateCustomField,
  deleteCustomField: customFields.handlers.deleteCustomField,
  getCustomFieldUsage: customFields.handlers.getCustomFieldUsage,
  validateCustomFields: customFields.handlers.validateCustomFields,

  registerWebhookEndpoint: webhooks.handlers.registerWebhookEndpoint,
  listWebhookEndpoints: webhooks.handlers.listWebhookEndpoints,
  rotateWebhookSecret: webhooks.handlers.rotateWebhookSecret,
  updateWebhookEndpoint: webhooks.handlers.updateWebhookEndpoint,
  deleteWebhookEndpoint: webhooks.handlers.deleteWebhookEndpoint,
  getWebhookPosition: webhooks.handlers.getWebhookPosition,
  listWebhookEvents: webhooks.handlers.listWebhookEvents,

  // What people are paid, declared
  listWageScales: laborSettings.handlers.listWageScales,
  loadWageScale: laborSettings.handlers.loadWageScale,
  reviseWageScale: laborSettings.handlers.reviseWageScale,
  retireWageScale: laborSettings.handlers.retireWageScale,
  listOvertimePolicies: laborSettings.handlers.listOvertimePolicies,
  declareOvertimePolicy: laborSettings.handlers.declareOvertimePolicy,
  listCrewRates: laborSettings.handlers.listCrewRates,
  setWageClassification: laborSettings.handlers.setWageClassification,
  listWebhookDeliveries: webhooks.handlers.listWebhookDeliveries,
  listWebhookEventDeliveries: webhooks.handlers.listWebhookEventDeliveries,
  replayWebhookDeliveries: webhooks.handlers.replayWebhookDeliveries,
  listWebhookReplays: webhooks.handlers.listWebhookReplays,

  getPaymentsStatus: payments.handlers.getPaymentsStatus,
  createPaymentIntent: payments.handlers.createPaymentIntent,
  refundPayment: payments.handlers.refundPayment,

  queueEmail: email.handlers.queueEmail,
  listEmailMessages: email.handlers.listEmailMessages,
  sendQueuedEmail: email.handlers.sendQueuedEmail,
  listEmailSuppressions: email.handlers.listEmailSuppressions,
  suppressEmailAddress: email.handlers.suppressEmailAddress,
  liftEmailSuppression: email.handlers.liftEmailSuppression,

  getAccountingStatus: accounting.handlers.getAccountingStatus,
  listAccountingAccounts: accounting.handlers.listAccountingAccounts,
  listAccountMappings: accounting.handlers.listAccountMappings,
  setAccountMapping: accounting.handlers.setAccountMapping,
  runAccountingSync: accounting.handlers.runAccountingSync,
  listAccountingRuns: accounting.handlers.listAccountingRuns,
  listAccountingProblems: accounting.handlers.listAccountingProblems,
  retryAccountingDocument: accounting.handlers.retryAccountingDocument,
  listAccountingPeriods: accounting.handlers.listAccountingPeriods,
  closeAccountingPeriod: accounting.handlers.closeAccountingPeriod,
  reopenAccountingPeriod: accounting.handlers.reopenAccountingPeriod,

  listConversations: comms.handlers.listConversations,
  getConversation: comms.handlers.getConversation,
  markConversationRead: comms.handlers.markConversationRead,
  replyToConversation: comms.handlers.replyToConversation,
  startConversation: comms.handlers.startConversation,
  getConsent: consent.handlers.getConsent,
  grantConsent: consent.handlers.grantConsent,
  revokeConsent: consent.handlers.revokeConsent,
  defineMessageTemplate: messageTemplates.handlers.defineMessageTemplate,
  listMessageTemplates: messageTemplates.handlers.listMessageTemplates,
  updateMessageTemplate: messageTemplates.handlers.updateMessageTemplate,
  deleteMessageTemplate: messageTemplates.handlers.deleteMessageTemplate,
  previewMessageTemplate: messageTemplates.handlers.previewMessageTemplate,

  recordMessagingBrand: messagingRegistration.handlers.recordMessagingBrand,
  setMessagingBrandStatus: messagingRegistration.handlers.setMessagingBrandStatus,
  recordMessagingCampaign: messagingRegistration.handlers.recordMessagingCampaign,
  setMessagingCampaignStatus: messagingRegistration.handlers.setMessagingCampaignStatus,
  listMessagingRegistrations: messagingRegistration.handlers.listMessagingRegistrations,

  listLeadFieldTargets: leadConnectors.handlers.listLeadFieldTargets,
  createLeadConnector: leadConnectors.handlers.createLeadConnector,
  listLeadConnectors: leadConnectors.handlers.listLeadConnectors,
  updateLeadConnector: leadConnectors.handlers.updateLeadConnector,
  testLeadMapping: leadConnectors.handlers.testLeadMapping,
  rotateLeadConnectorSecret: leadConnectors.handlers.rotateLeadConnectorSecret,
  deleteLeadConnector: leadConnectors.handlers.deleteLeadConnector,

  sendInvoice: invoiceDelivery.handlers.sendInvoice,
  listInvoiceDeliveries: invoiceDelivery.handlers.listInvoiceDeliveries,
  listUndeliveredInvoices: invoiceDelivery.handlers.listUndeliveredInvoices,
  viewPortalInvoice: invoiceDelivery.handlers.viewPortalInvoice,
  payPortalInvoice: invoiceDelivery.handlers.payPortalInvoice,

  getJobProfitability: profitability.handlers.getJobProfitability,
  getProfitabilitySummary: profitability.handlers.getProfitabilitySummary,

  listCrews: crews.handlers.listCrews,
  createCrew: crews.handlers.createCrew,
  updateCrew: crews.handlers.updateCrew,
  setCrewMembers: crews.handlers.setCrewMembers,
  getCrewAvailability: crews.handlers.getCrewAvailability,
  listCrewsForJob: crews.handlers.listCrewsForJob,
  assignCrewToVisit: crews.handlers.assignCrewToVisit,

  listServiceRoutes: serviceRoutes.handlers.listServiceRoutes,
  createServiceRoute: serviceRoutes.handlers.createServiceRoute,
  listServiceRouteStops: serviceRoutes.handlers.listServiceRouteStops,
  addServiceRouteStop: serviceRoutes.handlers.addServiceRouteStop,
  reorderServiceRouteStops: serviceRoutes.handlers.reorderServiceRouteStops,
  setServiceRouteStopActive: serviceRoutes.handlers.setServiceRouteStopActive,
  recordServiceRouteStopServiced: serviceRoutes.handlers.recordServiceRouteStopServiced,
  materialiseServiceRoute: serviceRoutes.handlers.materialiseServiceRoute,
  getServiceRouteDensity: serviceRoutes.handlers.getServiceRouteDensity,

  getOnCallNow: onCall.handlers.getOnCallNow,
  listOnCallRotations: onCall.handlers.listOnCallRotations,
  scheduleOnCall: onCall.handlers.scheduleOnCall,
  fillOnCallWeeks: onCall.handlers.fillOnCallWeeks,
  handOverOnCall: onCall.handlers.handOverOnCall,

  listCommissionBases: commissions.handlers.listCommissionBases,
  listCommissionPlans: commissions.handlers.listCommissionPlans,
  declareCommissionPlan: commissions.handlers.declareCommissionPlan,
  deactivateCommissionPlan: commissions.handlers.deactivateCommissionPlan,
  settleCommission: commissions.handlers.settleCommission,
  reverseCommission: commissions.handlers.reverseCommission,
  listCommissionEarnings: commissions.handlers.listCommissionEarnings,

  declarePayPeriod: payroll.handlers.declarePayPeriod,
  listPayPeriods: payroll.handlers.listPayPeriods,
  closePayPeriod: payroll.handlers.closePayPeriod,
  reopenPayPeriod: payroll.handlers.reopenPayPeriod,
  getPayrollRegister: payroll.handlers.getPayrollRegister,
  exportPayPeriod: payroll.handlers.exportPayPeriod,
  listPayrollExports: payroll.handlers.listPayrollExports,
  payCommissions: payroll.handlers.payCommissions,
  getMyTimeclock: labor.handlers.getMyTimeclock,

  getAiStatus: ai.handlers.getAiStatus,
  getAiUsage: ai.handlers.getAiUsage,
  listAgentTools: ai.handlers.listAgentTools,
  connectAiProvider: ai.handlers.connectAiProvider,
  disconnectAiProvider: ai.handlers.disconnectAiProvider,
  testAiConnection: ai.handlers.testAiConnection,
  setAiSpendLimit: ai.handlers.setAiSpendLimit,
  runAiCompletion: ai.handlers.runAiCompletion,
  ...agents.handlers,
  ...agentIntake.handlers,
  ...agentEstimates.handlers,
  ...agentCollections.handlers,
  ...agentDispatch.handlers,
  ...agentChat.handlers,

  listAssets: assets.handlers.listAssets,
  registerAsset: assets.handlers.registerAsset,
  updateAsset: assets.handlers.updateAsset,
  retireAsset: assets.handlers.retireAsset,
  checkOutAsset: assets.handlers.checkOutAsset,
  checkInAsset: assets.handlers.checkInAsset,
  handOverAsset: assets.handlers.handOverAsset,
  getAssetCustody: assets.handlers.getAssetCustody,
  listAssetsHeldBy: assets.handlers.listAssetsHeldBy,
  recordAssetReading: assets.handlers.recordAssetReading,
  listAssetReadings: assets.handlers.listAssetReadings,
  setAssetMaintenancePlan: assets.handlers.setAssetMaintenancePlan,
  recordAssetService: assets.handlers.recordAssetService,
  getAssetMaintenanceDue: assets.handlers.getAssetMaintenanceDue,
  setAssetObligation: assets.handlers.setAssetObligation,
  getAssetComplianceOutlook: assets.handlers.getAssetComplianceOutlook,
  recordAssetCost: assets.handlers.recordAssetCost,
  getAssetCost: assets.handlers.getAssetCost,

  listComplianceDocuments: compliance.handlers.listComplianceDocuments,
  getComplianceSummary: compliance.handlers.getComplianceSummary,
  listWorkBlockingDocuments: compliance.handlers.listWorkBlockingDocuments,
  registerComplianceDocument: compliance.handlers.registerComplianceDocument,
  renewComplianceDocument: compliance.handlers.renewComplianceDocument,
  withdrawComplianceDocument: compliance.handlers.withdrawComplianceDocument,
  listDeclaredSubmissions: compliance.handlers.listDeclaredSubmissions,
  listRegulatorySubmissions: compliance.handlers.listRegulatorySubmissions,
  openRegulatorySubmission: compliance.handlers.openRegulatorySubmission,
  advanceRegulatorySubmission: compliance.handlers.advanceRegulatorySubmission,
  resubmitRegulatorySubmission: compliance.handlers.resubmitRegulatorySubmission,
  publishRegulatoryConstant: compliance.handlers.publishRegulatoryConstant,
  getRegulatoryConstant: compliance.handlers.getRegulatoryConstant,
  listStaleRegulatoryConstants: compliance.handlers.listStaleRegulatoryConstants,
  listPeople: people.handlers.listPeople,
  listCertificationTypes: people.handlers.listCertificationTypes,
  defineCertificationType: people.handlers.defineCertificationType,
  updateCertificationType: people.handlers.updateCertificationType,
  listCertifications: people.handlers.listCertifications,
  recordCertification: people.handlers.recordCertification,
  verifyCertification: people.handlers.verifyCertification,
  setCertificationStatus: people.handlers.setCertificationStatus,
  listExpiringCertifications: people.handlers.listExpiringCertifications,
  getSkillStanding: people.handlers.getSkillStanding,
  listProjects: projects.handlers.listProjects,
  getProject: projects.handlers.getProject,
  createProject: projects.handlers.createProject,
  updateProject: projects.handlers.updateProject,
  addProjectPhase: projects.handlers.addProjectPhase,
  setProjectPhaseDependency: projects.handlers.setProjectPhaseDependency,
  setProjectPhaseStatus: projects.handlers.setProjectPhaseStatus,
  materialiseProject: projects.handlers.materialiseProject,
  attachJobToProject: projects.handlers.attachJobToProject,
  planProjectDraw: projects.handlers.planProjectDraw,
  raiseProjectDraw: projects.handlers.raiseProjectDraw,
  getProjectProfitability: projects.handlers.getProjectProfitability,
  listChangeOrders: projectChangeOrders.handlers.listChangeOrders,
  requestChangeOrder: projectChangeOrders.handlers.requestChangeOrder,
  getChangeOrder: projectChangeOrders.handlers.getChangeOrder,
  updateChangeOrder: projectChangeOrders.handlers.updateChangeOrder,
  addChangeOrderLine: projectChangeOrders.handlers.addChangeOrderLine,
  removeChangeOrderLine: projectChangeOrders.handlers.removeChangeOrderLine,
  sendChangeOrder: projectChangeOrders.handlers.sendChangeOrder,
  decideChangeOrder: projectChangeOrders.handlers.decideChangeOrder,
  withdrawChangeOrder: projectChangeOrders.handlers.withdrawChangeOrder,
  viewPortalChangeOrder: projectChangeOrders.viewForCustomer,
  approvePortalChangeOrder: projectChangeOrders.approveForCustomer,
  declinePortalChangeOrder: projectChangeOrders.declineForCustomer,
  getProjectSchedule: projectSchedule.handlers.getProjectSchedule,
  moveProjectPhase: projectSchedule.handlers.moveProjectPhase,
  setProjectPhaseDates: projectSchedule.handlers.setProjectPhaseDates,
  listProjectApplications: projectApplications.handlers.listProjectApplications,
  createProjectApplication: projectApplications.handlers.createProjectApplication,
  getProjectApplication: projectApplications.handlers.getProjectApplication,
  updateProjectApplication: projectApplications.handlers.updateProjectApplication,
  deleteProjectApplication: projectApplications.handlers.deleteProjectApplication,
  raiseProjectApplication: projectApplications.handlers.raiseProjectApplication,
  listProjectLienRecords: projectLiens.handlers.listProjectLienRecords,
  recordProjectLienRecord: projectLiens.handlers.recordProjectLienRecord,
  deleteProjectLienRecord: projectLiens.handlers.deleteProjectLienRecord,
  createCalendarFeed: calendar.handlers.createCalendarFeed,
  listCalendarFeeds: calendar.handlers.listCalendarFeeds,
  revokeCalendarFeed: calendar.handlers.revokeCalendarFeed,
  rotateCalendarFeed: calendar.handlers.rotateCalendarFeed,
  connectCallTracking: callTracking.handlers.connectCallTracking,
  getCallTrackingConnection: callTracking.handlers.getCallTrackingConnection,
  checkCallTracking: callTracking.handlers.checkCallTracking,
  backfillCallTracking: callTracking.handlers.backfillCallTracking,
  listBusinessUnits: company.handlers.listBusinessUnits,
  createBusinessUnit: company.handlers.createBusinessUnit,
  updateBusinessUnit: company.handlers.updateBusinessUnit,
  listLocations: company.handlers.listLocations,
  createLocation: company.handlers.createLocation,
  updateLocation: company.handlers.updateLocation,
  listTerritories: company.handlers.listTerritories,
  createTerritory: company.handlers.createTerritory,
  updateTerritory: company.handlers.updateTerritory,
  requestTimeOff: timeOff.handlers.requestTimeOff,
  listTimeOff: timeOff.handlers.listTimeOff,
  pendingTimeOff: timeOff.handlers.pendingTimeOff,
  approveTimeOff: timeOff.handlers.approveTimeOff,
  declineTimeOff: timeOff.handlers.declineTimeOff,
  withdrawTimeOff: timeOff.handlers.withdrawTimeOff,
  listReorderPolicies: inventory.handlers.listReorderPolicies,
  setReorderPolicy: inventory.handlers.setReorderPolicy,
  clearReorderPolicy: inventory.handlers.clearReorderPolicy,
  readAuditLog: auditLog.handlers.readAuditLog,
  getRecordHistory: auditLog.handlers.getRecordHistory,
  getTrialBalance: ledgerReports.handlers.getTrialBalance,
  listJournal: ledgerReports.handlers.listJournal,
  listPayments: billing.paymentReadHandlers.listPayments,
  listDeposits: deposits.handlers.listDeposits,
  listServiceReportTemplates: serviceReports.handlers.listServiceReportTemplates,
  defineServiceReportTemplate: serviceReports.handlers.defineServiceReportTemplate,
  updateServiceReportTemplate: serviceReports.handlers.updateServiceReportTemplate,
  listServiceReports: serviceReports.handlers.listServiceReports,
  getServiceReport: serviceReports.handlers.getServiceReport,
  annotateServiceReport: serviceReports.handlers.annotateServiceReport,
  publishServiceReport: serviceReports.handlers.publishServiceReport,
  unpublishServiceReport: serviceReports.handlers.unpublishServiceReport,
  getCustomerDeletability: customerLifecycle.handlers.getCustomerDeletability,
  getCustomerDuplicates: customerLifecycle.handlers.getCustomerDuplicates,
  removeCustomer: customerLifecycle.handlers.removeCustomer,
  mergeCustomers: customerLifecycle.handlers.mergeCustomers,
  getCustomerMergedInto: customerLifecycle.handlers.getCustomerMergedInto,

  getCustomerStatement: statements.handlers.getCustomerStatement,
  emailCustomerStatement: statementDelivery.handlers.emailCustomerStatement,
  listStatementDeliveries: statementDelivery.handlers.listStatementDeliveries,
  sendReportScheduleNow: deliverySchedules.handlers.sendReportScheduleNow,
  getStatementSchedule: deliverySchedules.handlers.getStatementSchedule,
  setStatementSchedule: deliverySchedules.handlers.setStatementSchedule,
  createCreditNote: creditNotes.handlers.createCreditNote,
  issueCreditNote: creditNotes.handlers.issueCreditNote,
  applyCreditNote: creditNotes.handlers.applyCreditNote,
  voidCreditNote: creditNotes.handlers.voidCreditNote,
  deleteCreditNote: creditNotes.handlers.deleteCreditNote,
  getCreditNote: creditNotes.handlers.getCreditNote,
  listCreditNotes: creditNotes.handlers.listCreditNotes,
  listInspectionPrograms: inspections.handlers.listInspectionPrograms,
  recordInspection: inspections.handlers.recordInspection,
  listDeficiencies: inspections.handlers.listDeficiencies,
  setDeficiencyStatus: inspections.handlers.setDeficiencyStatus,
  listInspections: inspections.handlers.listInspections,
  getInspectionReport: inspections.handlers.getInspectionReport,
  quoteDeficiency: inspections.handlers.quoteDeficiency,

  listWorkflows: workflows.handlers.listWorkflows,
  getWorkflowRuns: workflows.handlers.getWorkflowRuns,
  setWorkflowEnabled: workflows.handlers.setWorkflowEnabled,
  listWorkflowEvents: workflows.handlers.listWorkflowEvents,
  listWorkflowSteps: workflows.handlers.listWorkflowSteps,
  listWorkflowTemplates: workflows.handlers.listWorkflowTemplates,
  // Agreements
  createAgreementPlan: agreements.handlers.createAgreementPlan,
  sellAgreement: agreements.handlers.sellAgreement,
  renewAgreement: agreements.handlers.renewAgreement,
  listAgreementRenewals: agreements.handlers.listAgreementRenewals,
  getMemberPricing: agreements.handlers.getMemberPricing,
  listAgreementPlans: agreements.handlers.listAgreementPlans,
  getAgreementPlan: agreements.handlers.getAgreementPlan,
  updateAgreementPlan: agreements.handlers.updateAgreementPlan,
  retireAgreementPlan: agreements.handlers.retireAgreementPlan,
  listAgreements: agreements.handlers.listAgreements,
  getAgreement: agreements.handlers.getAgreement,
  listOwedAgreementVisits: agreements.handlers.listOwedAgreementVisits,
  bookAgreementVisit: agreements.handlers.bookAgreementVisit,
  deliverAgreementVisit: agreements.handlers.deliverAgreementVisit,
  skipAgreementVisit: agreements.handlers.skipAgreementVisit,
  unskipAgreementVisit: agreements.handlers.unskipAgreementVisit,
  invoiceAgreementInstalment: agreements.handlers.invoiceAgreementInstalment,
  cancelAgreement: agreements.handlers.cancelAgreement,
  // A customer asking to move or cancel a visit, and the office answering
  getPortalVisitChange: visitChanges.handlers.getPortalVisitChange,
  requestPortalVisitChange: visitChanges.handlers.requestPortalVisitChange,
  listVisitChangeRequests: visitChanges.handlers.listVisitChangeRequests,
  approveVisitChangeRequest: visitChanges.handlers.approveVisitChangeRequest,
  declineVisitChangeRequest: visitChanges.handlers.declineVisitChangeRequest,
  installWorkflowTemplate: workflows.handlers.installWorkflowTemplate,

  listTasks: tasks.handlers.listTasks,
  getTaskCounts: tasks.handlers.getTaskCounts,
  createTask: tasks.handlers.createTask,
  updateTask: tasks.handlers.updateTask,
  claimTask: tasks.handlers.claimTask,
  closeTask: tasks.handlers.closeTask,

  listEquipment: equipment.handlers.listEquipment,
  getEquipment: equipment.handlers.getEquipment,
  getEquipmentHistory: equipment.handlers.getEquipmentHistory,
  getWarrantyWatch: equipment.handlers.getWarrantyWatch,
  registerEquipment: equipment.handlers.registerEquipment,
  updateEquipment: equipment.handlers.updateEquipment,
  moveEquipment: equipment.handlers.moveEquipment,
  retireEquipment: equipment.handlers.retireEquipment,

  getAppSelf: apps.handlers.getAppSelf,
  listApps: apps.handlers.listApps,
  installApp: apps.handlers.installApp,
  updateApp: apps.handlers.updateApp,
  revokeApp: apps.handlers.revokeApp,
  issueAppToken: apps.handlers.issueAppToken,
  revokeAppToken: apps.handlers.revokeAppToken,
  requestAppInstall: apps.handlers.requestAppInstall,
  claimAppCredential: apps.handlers.claimAppCredential,
  reviewAppRequest: apps.handlers.reviewAppRequest,
  approveAppRequest: apps.handlers.approveAppRequest,
  refuseAppRequest: apps.handlers.refuseAppRequest,

  listSafetyMeetings: safety.handlers.listSafetyMeetings,
  createSafetyMeeting: safety.handlers.createSafetyMeeting,
  getSafetyMeeting: safety.handlers.getSafetyMeeting,
  addSafetyMeetingAttendees: safety.handlers.addSafetyMeetingAttendees,
  markSafetyMeetingSigned: safety.handlers.markSafetyMeetingSigned,
  closeSafetyMeeting: safety.handlers.closeSafetyMeeting,
  addSafetyMeetingPhoto: safety.handlers.addSafetyMeetingPhoto,
  listMySafetyMeetings: safety.handlers.listMySafetyMeetings,
  signSafetyMeeting: safety.handlers.signSafetyMeeting,
  reportIncident: safety.handlers.reportIncident,
  listIncidents: safety.handlers.listIncidents,
  getIncident: safety.handlers.getIncident,
  addIncidentFollowUp: safety.handlers.addIncidentFollowUp,
  closeIncident: safety.handlers.closeIncident,
  addIncidentPhoto: safety.handlers.addIncidentPhoto,

  listRetentionPolicies: retention.handlers.listRetentionPolicies,
  updateRetentionPolicy: retention.handlers.updateRetentionPolicy,
  previewRetentionPurge: retention.handlers.previewRetentionPurge,
  listRetentionHolds: retention.handlers.listRetentionHolds,
  placeRetentionHold: retention.handlers.placeRetentionHold,
  releaseRetentionHold: retention.handlers.releaseRetentionHold,
  runRetentionPurge: retention.handlers.runRetentionPurge,
  listRetentionPurgeRuns: retention.handlers.listRetentionPurgeRuns,
  listScheduledRevisions: priceBook.revisionHandlers.listScheduledRevisions,
  publishRevision: priceBook.revisionHandlers.publishRevision,
  discardRevision: priceBook.revisionHandlers.discardRevision,
  getDiscountPolicy: estimates.discountHandlers.getDiscountPolicy,
  setDiscountPolicy: estimates.discountHandlers.setDiscountPolicy,
  clearDiscountPolicy: estimates.discountHandlers.clearDiscountPolicy,
  getVisitUnits: visitAssets.handlers.getVisitUnits,
  planVisitUnits: visitAssets.handlers.planVisitUnits,
  recordUnitOutcome: visitAssets.handlers.recordUnitOutcome,
  recordDelivery: deliveries.handlers.recordDelivery,
  listDeliveries: deliveries.handlers.listDeliveries,
  getConsumption: deliveries.handlers.getConsumption,

  // Campaigns (M19): the half of marketing that sends rather than measures
  createCampaign: campaigns.handlers.createCampaign,
  updateCampaign: campaigns.handlers.updateCampaign,
  cancelCampaign: campaigns.handlers.cancelCampaign,
  deleteCampaign: campaigns.handlers.deleteCampaign,
  getCampaign: campaigns.handlers.getCampaign,
  listCampaigns: campaigns.handlers.listCampaigns,
  previewCampaign: campaigns.handlers.previewCampaign,
  sendCampaign: campaigns.handlers.sendCampaign,
  campaignRecipients: campaigns.handlers.campaignRecipients,
  campaignResults: campaigns.handlers.campaignResults,
  describeUnsubscribe: unsubscribe.handlers.describeUnsubscribe,
  confirmUnsubscribe: unsubscribe.handlers.confirmUnsubscribe,

  // Rentals (M22): the asset_rental capacity model the dumpster pack declares
  addRentableAsset: rentals.handlers.addRentableAsset,
  listRentableAssets: rentals.handlers.listRentableAssets,
  tagAssetOutOfService: rentals.handlers.tagAssetOutOfService,
  returnAssetToService: rentals.handlers.returnAssetToService,
  retireRentableAsset: rentals.handlers.retireRentableAsset,
  deliverRental: rentals.handlers.deliverRental,
  pickUpRental: rentals.handlers.pickUpRental,
  swapRental: rentals.handlers.swapRental,
  getRental: rentals.handlers.getRental,
  listRentals: rentals.handlers.listRentals,
  getRentalOverage: rentals.handlers.getRentalOverage,
  getFleetReport: rentals.handlers.getFleetReport,

  // Networks (M01): the franchise roll up, and the consent that permits one
  getNetworkMembership: network.handlers.getNetworkMembership,
  shareWithNetwork: network.handlers.shareWithNetwork,
  stopSharingWithNetwork: network.handlers.stopSharingWithNetwork,
  listNetworkMembers: network.handlers.listNetworkMembers,
  getNetworkRollup: network.handlers.getNetworkRollup,

  // Export (M30): the portability the comparison pages promise
  getExportManifest: dataExport.handlers.getExportManifest,
  getExportPage: dataExport.handlers.getExportPage,

  // External work orders (M31): the last table nothing touched
  receiveExternalWorkOrder: externalWork.handlers.receiveExternalWorkOrder,
  moveExternalWorkOrder: externalWork.handlers.moveExternalWorkOrder,
  acceptExternalWorkOrderViaInvoice: externalWork.handlers.acceptExternalWorkOrderViaInvoice,
  applyExternalWorkOrderRemote: externalWork.handlers.applyExternalWorkOrderRemote,
  listPendingExternalPushes: externalWork.handlers.listPendingExternalPushes,
  markExternalWorkOrderPushed: externalWork.handlers.markExternalWorkOrderPushed,
  markExternalWorkOrderPushFailed: externalWork.handlers.markExternalWorkOrderPushFailed,
  getExternalWorkOrder: externalWork.handlers.getExternalWorkOrder,
  listExternalWorkOrders: externalWork.handlers.listExternalWorkOrders,
  listExternalWorkSources: externalWork.handlers.listExternalWorkSources,

  // KPIs (M21): the numbers the trade packs defined and nothing computed
  getKpiScorecard: kpis.handlers.getKpiScorecard,
  listKpiCatalogue: kpis.handlers.listKpiCatalogue,

  // The dispatch map, the route optimiser and the geocoder (M09, M24, M25)
  getDispatchMap: dispatchMap.handlers.getDispatchMap,
  getRouteProposal: dispatchMap.handlers.getRouteProposal,
  getAssignmentSuggestions: dispatchMap.handlers.getAssignmentSuggestions,
  getTravelSettings: dispatchMap.handlers.getTravelSettings,
  setTravelSettings: dispatchMap.handlers.setTravelSettings,
  listTechnicians: dispatchMap.handlers.listTechnicians,
  updateTechnician: dispatchMap.handlers.updateTechnician,
  pinProperty: geocoding.handlers.pinProperty,
  unpinProperty: geocoding.handlers.unpinProperty,
  pinLocation: geocoding.handlers.pinLocation,
  unpinLocation: geocoding.handlers.unpinLocation,
  getGeocodingStatus: geocoding.handlers.getGeocodingStatus,
  // Reports (M21): the records behind a number, and reports on a schedule
  drillReport: reports.handlers.drillReport,
  listReportSchedules: deliverySchedules.handlers.listReportSchedules,
  createReportSchedule: deliverySchedules.handlers.createReportSchedule,
  updateReportSchedule: deliverySchedules.handlers.updateReportSchedule,
  setReportSchedulePaused: deliverySchedules.handlers.setReportSchedulePaused,
  deleteReportSchedule: deliverySchedules.handlers.deleteReportSchedule,
  listReportDeliveries: deliverySchedules.handlers.listReportDeliveries,

  // CRM tags and the duplicate sweep (M03)
  listCustomerTags: customerTags.handlers.listCustomerTags,
  setCustomerTags: customerTags.handlers.setCustomerTags,
  renameCustomerTag: customerTags.handlers.renameCustomerTag,
  mergeCustomerTags: customerTags.handlers.mergeCustomerTags,
  listCustomerDuplicatePairs: customerDuplicates.handlers.listCustomerDuplicatePairs,
  dismissCustomerDuplicate: customerDuplicates.handlers.dismissCustomerDuplicate,

  // Price book categories and bulk changes (M06)
  listPriceBookCategories: priceCategories.handlers.listPriceBookCategories,
  createPriceBookCategory: priceCategories.handlers.createPriceBookCategory,
  updatePriceBookCategory: priceCategories.handlers.updatePriceBookCategory,
  placePriceBookCategory: priceCategories.handlers.placePriceBookCategory,
  removePriceBookCategory: priceCategories.handlers.removePriceBookCategory,
  filePriceBookItems: priceCategories.handlers.filePriceBookItems,
  previewPriceChange: repricing.handlers.previewPriceChange,
  applyPriceChange: repricing.handlers.applyPriceChange,
  listPriceChanges: repricing.handlers.listPriceChanges,
  getPriceChange: repricing.handlers.getPriceChange,
  reversePriceChange: repricing.handlers.reversePriceChange,

  // Recurring tasks, escalation and checklists (M34)
  listTaskTemplates: taskRules.handlers.listTaskTemplates,
  createTaskTemplate: taskRules.handlers.createTaskTemplate,
  updateTaskTemplate: taskRules.handlers.updateTaskTemplate,
  listTaskEscalationRules: taskRules.handlers.listTaskEscalationRules,
  createTaskEscalationRule: taskRules.handlers.createTaskEscalationRule,
  updateTaskEscalationRule: taskRules.handlers.updateTaskEscalationRule,
  listTaskEscalations: taskRules.handlers.listTaskEscalations,
  listReportingLines: taskRules.handlers.listReportingLines,
  setReportingLine: taskRules.handlers.setReportingLine,
  getTaskChecklist: taskChecklist.handlers.getTaskChecklist,
  addTaskChecklistItem: taskChecklist.handlers.addTaskChecklistItem,
  tickTaskChecklistItem: taskChecklist.handlers.tickTaskChecklistItem,
  removeTaskChecklistItem: taskChecklist.handlers.removeTaskChecklistItem,
  // Native call tracking, the website snippet and referrals (M19)
  searchAvailableNumbers: voice.handlers.searchAvailableNumbers,
  buyTrackingNumber: voice.handlers.buyTrackingNumber,
  setNumberRouting: voice.handlers.setNumberRouting,
  releasePhoneNumber: voice.handlers.releasePhoneNumber,
  answerNumberHere: voice.handlers.answerNumberHere,
  stopAnsweringNumber: voice.handlers.stopAnsweringNumber,
  listPhoneMenus: phoneMenus.handlers.listPhoneMenus,
  getPhoneMenu: phoneMenus.handlers.getPhoneMenu,
  createPhoneMenu: phoneMenus.handlers.createPhoneMenu,
  updatePhoneMenu: phoneMenus.handlers.updatePhoneMenu,
  deletePhoneMenu: phoneMenus.handlers.deletePhoneMenu,
  listRingGroups: phoneMenus.handlers.listRingGroups,
  createRingGroup: phoneMenus.handlers.createRingGroup,
  updateRingGroup: phoneMenus.handlers.updateRingGroup,
  deleteRingGroup: phoneMenus.handlers.deleteRingGroup,
  listAnsweringPhones: phoneMenus.handlers.listAnsweringPhones,
  setAnsweringPhone: phoneMenus.handlers.setAnsweringPhone,
  recordPublicTouch: websiteTracking.handlers.recordPublicTouch,
  getVisitorNumber: websiteTracking.handlers.getVisitorNumber,
  getWebsiteTracking: websiteTracking.handlers.getWebsiteTracking,
  setWebsiteTracking: websiteTracking.handlers.setWebsiteTracking,
  getReferrals: referrals.handlers.getReferrals,
  setReferralSettings: referrals.handlers.setReferralSettings,
  settleReferralReward: referrals.handlers.settleReferralReward,
  getCustomerReferral: referrals.handlers.getCustomerReferral,
  setCustomerReferrer: referrals.handlers.setCustomerReferrer,
  viewPortalReferral: referrals.handlers.viewPortalReferral,
  getForm: forms.handlers.getForm,
  getHostedForm: forms.handlers.getHostedForm,
  // The customer signed in, saved cards, tips and job photographs (M05, M13)
  requestPortalCode: portalSignIn.handlers.requestPortalCode,
  verifyPortalCode: portalSignIn.handlers.verifyPortalCode,
  signOutOfPortal: portalSignIn.handlers.signOutOfPortal,
  openPortalRecord: portalSignIn.handlers.openPortalRecord,
  viewPortalAccount: (db: Database, input: { token: string }) => portalAccount.viewAccount(db, input),
  payPortalAccountInvoice: (
    db: Database, input: { token: string; invoiceId: string; tip?: string | undefined }, meta?: RequestMeta,
  ) => portalAccount.startInvoicePayment(db, input, meta),
  listPortalCards: savedCards.handlers.listPortalCards,
  startPortalCardSetup: savedCards.handlers.startPortalCardSetup,
  confirmPortalCardSetup: savedCards.handlers.confirmPortalCardSetup,
  removePortalCard: savedCards.handlers.removePortalCard,
  payPortalInvoiceWithCard: (
    db: Database,
    input: { token: string; cardId: string; invoiceId: string; tip?: string | undefined },
    meta?: RequestMeta,
  ) => savedCards.pay(db, input, meta),
  getPortalSettings: portalSettings.handlers.getPortalSettings,
  setPortalSettings: portalSettings.handlers.setPortalSettings,
  listInvoiceTips: (ctx: ServiceContext, input: { id: string }) => tips.forInvoice(ctx, { invoiceId: input.id }),
  shareAttachmentWithCustomer: files.handlers.shareAttachmentWithCustomer,
  payTips: payroll.handlers.payTips,

  // Setup, the team and branches (M02, M01)
  getSetup: setup.handlers.getSetup,
  markSetupStep: setup.handlers.markSetupStep,
  finishSetup: setup.handlers.finishSetup,
  getCompanyDetails: setup.handlers.getCompanyDetails,
  updateCompanyDetails: setup.handlers.updateCompanyDetails,
  listItemTax: setup.handlers.listItemTax,
  setItemTax: setup.handlers.setItemTax,
  listTradePacks: tradePacks.handlers.listTradePacks,
  applyTradePack: tradePacks.handlers.applyTradePack,
  previewTradePackUpgrade: tradePacks.handlers.previewTradePackUpgrade,
  upgradeTradePack: tradePacks.handlers.upgradeTradePack,
  listTeam: team.handlers.listTeam,
  inviteMember: team.handlers.inviteMember,
  resendInvite: team.handlers.resendInvite,
  setMemberRole: team.handlers.setMemberRole,
  listBranchOptions: branches.handlers.listBranchOptions,
  getBranchOverview: branches.handlers.getBranchOverview,
  assignJobsToBranch: branches.handlers.assignJobsToBranch,
  setMemberBranch: branches.handlers.setMemberBranch,

  startConnectorSignIn: ads.handlers.startConnectorSignIn,
  finishConnectorSignIn: ads.handlers.finishConnectorSignIn,
  listMarketingPlatforms: ads.handlers.listMarketingPlatforms,
  syncMarketingPlatform: ads.handlers.syncMarketingPlatform,
  listPlatformCampaigns: ads.handlers.listPlatformCampaigns,
  mapPlatformCampaign: ads.handlers.mapPlatformCampaign,
  listConversionSends: ads.handlers.listConversionSends,
  retryConversionSend: ads.handlers.retryConversionSend,
  getCustomerAdData: ads.handlers.getCustomerAdData,
  setCustomerAdData: ads.handlers.setCustomerAdData,
  confirmReviewMatch: ads.handlers.confirmReviewMatch,
  syncReviews: ads.handlers.syncReviews,

  // Serials, lots and truck stock (M16)
  ...stockUnits.handlers,
  // Approval steps and emailing an order to its vendor (M16)
  ...purchaseApprovals.handlers,
  ...purchaseOrderEmail.handlers,
  // Collections, charges on a haul, invoicing a hire and scale tickets (M22)
  ...rentalBilling.handlers,
  // Onboarding, emergency contacts, employment, skills, continuing education, a job's own skills (M24)
  ...peopleRecords.handlers,
} as const satisfies { [N in RouteName]?: HandlerFor<N> };

export type ImplementedRoute = keyof typeof handlers;

/**
 * Routes that are declared and deliberately not yet served.
 *
 * Every name here is a promise the contract makes and the code does not keep,
 * so the list is not a backlog: it is the thing the test below prints when it
 * fails, and it should only ever shrink. Adding a route to the contracts
 * without adding it here or to `handlers` turns the suite red.
 *
 * It is empty. Every declared route is served.
 */
export const PENDING_ROUTES: readonly RouteName[] = [] as const;

export const routeNames = Object.keys(routes) as RouteName[];
