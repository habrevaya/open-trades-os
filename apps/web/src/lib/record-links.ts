/**
 * WHERE A RECORD OPENS, by the entity type a task, a deadline or an audit
 * line names it with. One map, so the queue, a task's own page and anything
 * else that links to "the thing this is about" cannot disagree about where a
 * visit or a unit lives.
 */
export const LINKS: Record<string, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  customer: (id) => `/customers/${id}`,
  invoice: (id) => `/invoices/${id}`,
  conversation: (id) => `/inbox/${id}`,
  /** Raised by the estimate follow up, and by a renewal notice that could not go. */
  estimate: (id) => `/estimates/${id}`,
  agreement: (id) => `/agreements/${id}`,
  /** An escalation's notice is about the late task, and opens it. */
  task: (id) => `/tasks/${id}`,
  /** A deadline about one visit (work finished on a visit the office had cancelled) opens that visit. */
  visit: (id) => `/visits/${id}`,
  /** A warranty follow up opens the unit, with its history and its cover. */
  equipment: (id) => `/equipment/${id}`,
  /** Raised when somebody reports an incident, and by every follow up added to one. */
  incident_report: (id) => `/compliance/incidents/${id}`,
  /**
   * One of the company's own records, raised about by an automation on
   * `record.created`. Its address carries its kind, which the task does not
   * know, so it opens through `any` and the page sends it on.
   */
  custom_object_record: (id) => `/records/any/${id}`,
};

/** The words for a link to one, said the way the queue says them. */
export const RECORD_NOUN: Record<string, string> = {
  job: "job", customer: "customer", invoice: "invoice", conversation: "conversation",
  estimate: "estimate", agreement: "agreement", task: "late task", incident_report: "incident report",
  visit: "visit", equipment: "unit", custom_object_record: "record",
};
