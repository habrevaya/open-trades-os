/**
 * THE MODULE REGISTRY
 *
 * Every route carries a module code, and until this file existed that code
 * was a free string. Nothing checked it. A route could say M12 and mean M31,
 * which is exactly what happened: the whole commercial contracts surface
 * shipped tagged as Projects and Multi-Phase Work, and the only way anybody
 * would have found out is by reading the generated API reference and
 * wondering why rate cards were filed under construction phasing.
 *
 * That matters more than a filing error. The module code is how a reader
 * answers "does this product do X": they open the parity map, find the
 * module, and go to its page. A route filed under the wrong module is
 * missing from the page somebody reads and present on a page they are not
 * looking at, which is worse than being absent, because absence prompts a
 * question.
 *
 * WHY THE CODES LIVE IN CODE AND THE TITLES ARE CHECKED AGAINST THE DOCS.
 * A typo is a compile error because `ModuleCode` is a union rather than a
 * string. A code that is real but WRONG for the route is not something a
 * type can catch, so the defence there is that the docs and this list have
 * to agree, and disagreeing makes a test fail rather than a page go stale.
 *
 * The order is the build order from docs/modules/README.md, kept so the two
 * can be read side by side.
 */
export const MODULES = {
  M01: "Core, Tenancy and Access",
  M02: "Setup, Configuration and Trade Packs",
  M03: "CRM",
  M04: "Customer Equipment and Service History",
  M05: "Customer Portal and Online Booking",
  M06: "Price Book",
  M07: "Estimates and Proposals",
  M08: "Memberships and Service Agreements",
  M09: "Scheduling and Dispatch",
  M10: "Jobs and Work Orders",
  M11: "Mobile Field App",
  M12: "Projects and Multi-Phase Work",
  M13: "Invoicing and Payments",
  M14: "Accounting and General Ledger",
  M15: "Job Costing and Profitability",
  M16: "Purchasing, Vendors and Inventory",
  M17: "Payroll, Time and Commissions",
  M18: "Communications Infrastructure",
  M19: "Marketing Operations and Attribution",
  M20: "Reviews and Reputation",
  M21: "Reporting and Business Intelligence",
  M22: "Fleet, Tools and Company Assets",
  M23: "Documents, Compliance and Safety",
  M24: "People and Certifications",
  M25: "Integrations and Provider Framework",
  M26: "Public API, Webhooks and SDKs",
  M27: "AI Agents",
  M28: "Developer and Agent Platform",
  M29: "Custom Fields, Objects and Workflow Builder",
  M30: "Migration and Data Portability",
  M31: "Commercial Parties, Contracts and Third-Party Billing",
  M32: "Coverage, Warranty and Who Is Actually Paying",
  M33: "Inspections and the Deficiency Backlog",
  M34: "Tasks and the Office Work Queue",
} as const;

export type ModuleCode = keyof typeof MODULES;

export const CODES = Object.keys(MODULES) as ModuleCode[];

export const titleOf = (code: ModuleCode): string => MODULES[code];

export const isModuleCode = (value: string): value is ModuleCode =>
  Object.prototype.hasOwnProperty.call(MODULES, value);
