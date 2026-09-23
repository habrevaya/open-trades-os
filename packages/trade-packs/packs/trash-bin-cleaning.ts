import type { TradePackInput } from "../src/schema";

/**
 * TRASH BIN CLEANING
 *
 * Route, and an unusually strict one. Two things about this trade break
 * generic field service software outright.
 *
 * FIRST, THE CUSTOMER DOES NOT CHOOSE THE APPOINTMENT. The municipal
 * collection calendar does. A bin can only be cleaned in the window after the
 * truck has emptied it and before the household wheels it back in, which is
 * usually the same afternoon. Every stop on a street shares that window
 * because they share a collection day, and collection day is a property of the
 * street rather than of the customer. Software that models this as "the
 * customer picks a slot" produces a schedule that cannot be driven.
 *
 * SECOND, DENSITY IS NOT AN OPTIMISATION, IT IS THE BUSINESS. One customer on
 * a street barely covers the drive. Twelve on the same street on the same
 * afternoon is a good business. That is why this trade sells to whole
 * neighbourhoods and why the referral mechanics matter more here than
 * anywhere else in the catalogue: a new signup on an existing street is worth
 * several times a signup on a new one, and the price book below reflects that
 * with a neighbour rate rather than a discount code.
 *
 * Both of those are route model concerns the platform already has. What this
 * pack adds is the vocabulary.
 */
export const trashBinCleaning: TradePackInput = {
  id: "trash-bin-cleaning",
  name: "Trash bin cleaning",
  version: 1,
  summary:
    "Curbside bin and cart cleaning. Routes keyed to the municipal collection calendar rather than to customer preference, priced per bin, and sold street by street because density is the entire margin.",
  status:
    "Price book, job types, readings, checklists and KPIs are complete, and the route model handles collection-day scheduling through completion-anchored recurrence. What is NOT built yet: importing a municipal collection calendar, which today means entering the collection day per street by hand. Water reclaim volumes are captured as readings but there is no disposal manifest formatter. Commercial compactor and dumpster washing is out of scope: that is a different truck and a different trade.",

  jobTypes: [
    { code: "route-stop", name: "Route stop", capacityModel: "route", defaultDurationMinutes: 8, color: "#0B57D0" },
    { code: "first-clean", name: "First clean", capacityModel: "route", defaultDurationMinutes: 15, requiredSkills: ["bin-cleaning"] },
    { code: "deep-clean", name: "Deep clean and deodorise", capacityModel: "route", defaultDurationMinutes: 20 },
    { code: "hoa-sweep", name: "Neighbourhood sweep", capacityModel: "route", defaultDurationMinutes: 240, color: "#6B3FA0" },
    { code: "commercial", name: "Commercial cart run", capacityModel: "route", defaultDurationMinutes: 45 },
    { code: "missed", name: "Missed bin return visit", capacityModel: "technician_dispatch", defaultDurationMinutes: 15 },
  ],

  priceBook: [
    { code: "SUB-MO-1", name: "Monthly plan, one bin", category: "Plans", price: "24.00", cost: "6.40", laborMinutes: 8, taxClass: "service", description: "Cleaned, sanitised and deodorised every month on your collection day, right after the truck." },
    { code: "SUB-MO-2", name: "Monthly plan, two bins", category: "Plans", price: "34.00", cost: "9.20", laborMinutes: 12, taxClass: "service" },
    { code: "SUB-MO-3", name: "Monthly plan, three bins", category: "Plans", price: "42.00", cost: "11.80", laborMinutes: 16, taxClass: "service" },
    { code: "SUB-QTR-1", name: "Quarterly plan, one bin", category: "Plans", price: "39.00", cost: "6.40", laborMinutes: 10, taxClass: "service" },
    { code: "SUB-QTR-2", name: "Quarterly plan, two bins", category: "Plans", price: "54.00", cost: "9.20", laborMinutes: 14, taxClass: "service" },
    { code: "SUB-BIMO-1", name: "Every other month, one bin", category: "Plans", price: "29.00", cost: "6.40", laborMinutes: 8, taxClass: "service" },
    { code: "SUB-ANN-1", name: "Annual prepaid, one bin", category: "Plans", price: "259.00", cost: "76.80", taxClass: "service", description: "Twelve cleans paid up front. Works out cheaper than monthly and locks your spot on the route." },
    /**
     * The neighbour rate is a real price, not a promotion. A stop on a street
     * already on the route costs a fraction of one that needs its own drive,
     * and pricing that honestly is what makes a street fill up.
     */
    { code: "SUB-MO-NBR", name: "Monthly plan, neighbour rate", category: "Plans", price: "19.00", cost: "4.10", laborMinutes: 8, taxClass: "service", description: "For an address on a street we already serve. The drive is already paid for, so you pay less." },
    { code: "HOA-MO", name: "Neighbourhood plan, per home per month", category: "Plans", price: "16.00", cost: "3.60", taxClass: "service", description: "Whole street or association billed together. The lowest rate we do, because the route is full." },

    { code: "FIRST-1", name: "First clean, one bin", category: "One time", price: "45.00", cost: "9.00", laborMinutes: 15, taxClass: "service", description: "A bin that has never been cleaned takes longer and uses more water. Charged once." },
    { code: "ONE-1", name: "One time clean, one bin", category: "One time", price: "39.00", cost: "7.20", laborMinutes: 12, taxClass: "service" },
    { code: "ONE-2", name: "One time clean, two bins", category: "One time", price: "55.00", cost: "10.40", laborMinutes: 18, taxClass: "service" },
    { code: "DEEP-1", name: "Deep clean and deodorise, one bin", category: "One time", price: "69.00", cost: "14.00", laborMinutes: 20, taxClass: "service" },
    { code: "MOVE-OUT", name: "Move out clean", category: "One time", price: "59.00", cost: "11.00", laborMinutes: 18, taxClass: "service" },

    { code: "BIN-EXTRA", name: "Additional bin, same stop", category: "Add ons", price: "10.00", cost: "2.80", laborMinutes: 5, taxClass: "service" },
    { code: "CART-96", name: "96 gallon cart surcharge", category: "Add ons", price: "5.00", cost: "1.40", taxClass: "service" },
    { code: "DEODOR", name: "Extra deodoriser treatment", category: "Add ons", price: "8.00", cost: "1.10", taxClass: "material" },
    { code: "SANITISE", name: "Sanitising treatment", category: "Add ons", price: "12.00", cost: "1.90", taxClass: "material" },
    { code: "MAGGOT", name: "Heavy infestation treatment", category: "Add ons", price: "25.00", cost: "3.40", laborMinutes: 10, taxClass: "service", description: "For a bin with active larvae. Extra hot water, extra time, extra product." },
    { code: "LID-SCRUB", name: "Lid and handle detail", category: "Add ons", price: "6.00", cost: "0.90", taxClass: "service" },
    { code: "PRESSURE-CAN-PAD", name: "Bin pad or corral wash", category: "Add ons", price: "35.00", cost: "5.20", laborMinutes: 15, taxClass: "service" },

    { code: "COMM-CART", name: "Commercial cart, per cart", category: "Commercial", price: "18.00", cost: "4.20", laborMinutes: 8, taxClass: "service" },
    { code: "COMM-CORRAL", name: "Commercial corral wash", category: "Commercial", price: "95.00", cost: "22.00", laborMinutes: 40, taxClass: "service" },
    { code: "COMM-MIN", name: "Commercial route minimum", kind: "fee", category: "Commercial", price: "85.00", taxClass: "service", description: "Minimum charge for a commercial stop, applied when the cart count falls below it." },

    /**
     * Free, and the cost is real. A bin the crew could not reach still cost a
     * drive and a slot on the route, and recording that cost is the only way
     * the access problem ever shows up in a report rather than as a vague
     * sense that a street is not worth it.
     */
    { code: "MISSED-NOFAULT", name: "Bin not out, no charge", kind: "fee", category: "Exceptions", price: "0", cost: "3.90", taxClass: "exempt", description: "The bin was not at the curb. No charge, and we will get it next cycle." },
    { code: "MISSED-RETURN", name: "Return visit for a missed bin", kind: "fee", category: "Exceptions", price: "15.00", cost: "8.50", laborMinutes: 15, taxClass: "service" },
    { code: "BLOCKED", name: "Blocked access trip fee", kind: "fee", category: "Exceptions", price: "12.00", cost: "3.90", taxClass: "service" },
    { code: "CANCEL-LATE", name: "Late cancellation", kind: "fee", category: "Exceptions", price: "12.00", taxClass: "service" },
    { code: "REDO", name: "Re-clean, our fault", kind: "fee", category: "Exceptions", price: "0", cost: "6.40", taxClass: "exempt", description: "If it was not right, we come back. Free to you and recorded as a cost to us." },

    { code: "TRIP-OUTZONE", name: "Out of area trip fee", kind: "fee", category: "Fees", price: "15.00", taxClass: "service" },
    { code: "REFERRAL-CREDIT", name: "Neighbour referral credit", kind: "discount", category: "Fees", price: "0", taxClass: "exempt", description: "A month free when a neighbour on your street signs up. Density is worth more to us than the month." },
  ],

  equipmentCategories: [
    {
      code: "bin", name: "Bin or cart", tracksSerial: false, tracksWarranty: false,
      attributes: [
        { key: "stream", label: "Stream", kind: "select", options: ["Refuse", "Recycling", "Green waste", "Organics"] },
        { key: "size", label: "Size", kind: "select", options: ["35 gallon", "64 gallon", "96 gallon", "Other"] },
        { key: "hauler_id", label: "Hauler bin number", kind: "text" },
        { key: "colour", label: "Lid colour", kind: "text" },
      ],
    },
    {
      code: "bin-pad", name: "Bin pad or corral", tracksSerial: false, tracksWarranty: false,
      attributes: [{ key: "surface", label: "Surface", kind: "select", options: ["Concrete", "Asphalt", "Gravel", "Grass"] }],
    },
  ],

  readings: [
    { key: "bins_cleaned", label: "Bins cleaned", kind: "numeric", trend: true, min: 0, max: 20 },
    { key: "condition_before", label: "Condition on arrival", kind: "select", options: ["Light", "Normal", "Heavy", "Severe"], customerVisible: true },
    { key: "infestation", label: "Active infestation found", kind: "boolean", customerVisible: true },
    { key: "odour_before", label: "Odour before", kind: "select", options: ["None", "Mild", "Strong", "Severe"], customerVisible: false },
    { key: "photo_before", label: "Photo before", kind: "photo" },
    { key: "photo_after", label: "Photo after", kind: "photo", customerVisible: true },
    { key: "water_used", label: "Water used", kind: "numeric", unit: "gal", trend: true, customerVisible: false, min: 0, max: 40 },
    /**
     * Recovered water is the compliance-relevant number: the wash water is
     * captured rather than allowed to run into a storm drain, and the volume
     * is what a municipality asks about if anyone ever does.
     */
    { key: "water_recovered", label: "Water recovered", kind: "numeric", unit: "gal", trend: true, customerVisible: false, regulated: true },
    { key: "disposal_site", label: "Reclaim disposal point", kind: "text", customerVisible: false, regulated: true },
    { key: "deodoriser_applied", label: "Deodoriser applied", kind: "boolean", customerVisible: true },
    { key: "sanitiser_applied", label: "Sanitiser applied", kind: "chemical", customerVisible: true, regulated: true },
    { key: "bin_damage", label: "Damage noted on the bin", kind: "text", customerVisible: true },
    { key: "bin_returned_to", label: "Bin returned to", kind: "select", options: ["Curb", "Side of house", "Garage", "Corral", "As found"], customerVisible: true },
  ],

  checklists: [
    {
      code: "route-stop", name: "Route stop", jobTypeCodes: ["route-stop", "first-clean", "deep-clean"],
      items: [
        { label: "Confirm the bin is empty before starting", required: true },
        { label: "Photograph the bin before cleaning", required: true },
        { label: "Check for and record active infestation" },
        { label: "Wash interior, exterior, lid and handle" },
        { label: "Confirm all wash water is captured, none entering the storm drain", required: true, safety: true },
        { label: "Apply deodoriser" },
        { label: "Photograph the bin after cleaning", required: true },
        { label: "Return the bin to where the customer keeps it", required: true },
        { label: "Record any pre-existing damage rather than cleaning around it" },
      ],
    },
    {
      code: "truck-start", name: "Truck start of day", jobTypeCodes: ["route-stop", "hoa-sweep", "commercial"],
      items: [
        { label: "Fresh water tank filled and level recorded", required: true },
        { label: "Reclaim tank empty and below the fill line", required: true },
        { label: "Burner and pump tested at temperature", required: true, safety: true },
        { label: "Hose, wand and lance inspected for damage", required: true, safety: true },
        { label: "Chemical levels checked and secured", safety: true },
        { label: "Confirm today's collection calendar matches the route", required: true },
      ],
    },
    {
      code: "truck-end", name: "Truck end of day",
      items: [
        { label: "Reclaim tank emptied at an approved disposal point and the point recorded", required: true, safety: true },
        { label: "Reclaim volume recorded", required: true },
        { label: "Tanks and lines flushed" },
        { label: "Record any stop that could not be completed and why", required: true },
      ],
    },
  ],

  inspectionPrograms: [],

  submissions: [
    {
      kind: "wash_water.disposal_record",
      label: "Wash water reclaim and disposal record",
      authorityName: "Local sewer or wastewater authority, where one requires it",
      cadence: "per_event",
      notes:
        "Captured per truck day from the recovered volume and disposal point readings. Whether a record is required, what it must contain and where it goes varies by municipality, so the software produces the record and leaves the destination to the operator. No format is encoded.",
    },
  ],

  retention: [
    { entityType: "service_report", entityKind: "route-stop", clockStart: "record_created", retainMonths: 24, basis: "Before and after photographs, which are what settle a damage dispute" },
    { entityType: "service_report", entityKind: "truck-end", clockStart: "record_created", retainMonths: 36, basis: "Wash water disposal records" },
  ],

  kpis: [
    {
      key: "stops_per_day",
      label: "Stops per truck day",
      definition: "Completed stops divided by truck days worked, taken from the timeclock rather than the roster. Counts a multi-bin stop as ONE stop, because the drive is the cost and the second bin is nearly free.",
      format: "number", target: "70",
    },
    {
      key: "street_density",
      label: "Homes per served street",
      definition: "Active subscriptions divided by the number of distinct streets on the route. The single most important number in this business: one home on a street loses money and twelve makes it. Excludes commercial stops, which have their own economics.",
      format: "number", target: "8",
    },
    {
      key: "revenue_per_stop",
      label: "Revenue per stop",
      definition: "Recognised subscription revenue plus one-off charges divided by completed stops. Excludes stops where the bin was not out, since those earn nothing and would otherwise make a bad access problem look like a pricing problem.",
      format: "money", target: "22",
    },
    {
      key: "not_out_rate",
      label: "Bin not out rate",
      definition: "Stops where the bin was not at the curb divided by attempted stops. Every one is a paid drive with no revenue. Above five percent the fix is reminder timing, not route planning.",
      format: "percent", target: "3",
    },
    {
      key: "churn",
      label: "Monthly subscription churn",
      definition: "Subscriptions cancelled in the month divided by active subscriptions at the start of it. Excludes cancellations from a house sale or a move, which are not a service failure and should be tracked separately.",
      format: "percent", target: "3",
    },
    {
      key: "referral_share",
      label: "Share of signups from referral",
      definition: "New subscriptions attributed to a neighbour referral divided by all new subscriptions. The cheapest growth in this trade, because a referral is almost always on a street already served.",
      format: "percent", target: "35",
    },
    {
      key: "water_per_stop",
      label: "Fresh water per stop",
      definition: "Fresh water used divided by completed stops, per truck. A truck drifting upward is usually a nozzle or a burner problem, and it shows here before it shows in a complaint.",
      format: "number", target: "5",
    },
    {
      key: "redo_rate",
      label: "Re-clean rate",
      definition: "Free re-cleans divided by completed stops. Counts only our-fault returns, not bins that were not out.",
      format: "percent", target: "1",
    },
  ],

  portalBlocks: [
    { kind: "next_visit", title: "Your next clean" },
    { kind: "photo_gallery", title: "Before and after" },
    { kind: "visit_timeline", title: "Service history" },
    { kind: "plan_status", title: "Your plan" },
    { kind: "referral", title: "Get a month free" },
    { kind: "invoices" },
    { kind: "contact_card" },
  ],
};
