import type { TradePackInput } from "../src/schema";

/**
 * Cleaning, residential and commercial. The largest unit count in home
 * services, and the trade most often mis-modelled as an appointment book.
 *
 * Recurring cleaning is a route. A two person team leaves with six to nine
 * homes on a fixed weekday, or a night crew covers eleven offices between six
 * and midnight, and the economics are density economics: what a cleaner hour
 * earns depends far more on how close the stops are than on what any one clean
 * is priced at. Software that schedules a cleaner into a calendar slot the way
 * it would schedule a plumber into a two hour window gives the owner no way to
 * see a route falling apart, and no way to rebalance it when a customer moves
 * to every four weeks.
 *
 * The other thing this trade needs and rarely gets is custody. A cleaning
 * company holds keys, lockbox codes, alarm codes and building cards for
 * hundreds of properties, and the record of who held what and when it came
 * back is the record that matters when something goes missing. That is a
 * checklist and an equipment record here, not a sticky note in a van.
 *
 * Prices are US national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const cleaning: TradePackInput = {
  id: "cleaning",
  name: "Cleaning, residential and commercial",
  version: 1,
  capacityModel: "route",
  summary:
    "Recurring residential and commercial cleaning run as routes with density economics, plus deep cleans, move in and move out, post construction and periodic floor work priced by the square foot.",
  status:
    "Price book, job types, route capacity, key and access custody, quality inspection and KPIs are complete. Online instant booking with real time availability, cleaner pay as a percentage of job value, split pay across a two or three person team, and geofenced clock in for commercial night work are modelled here but not built in the product yet. Compliance content is deliberately thin: this trade's obligations are mostly employment and chemical hazard communication, which sit outside a trade pack.",

  /**
   * Route is the default because the recurring book is the business. Post
   * construction and floor care are crew production: they are measured and
   * costed by the square foot and a crew is on one site all day, so putting
   * them on the route would make the route's capacity numbers meaningless.
   */
  jobTypes: [
    { code: "recur-res", name: "Recurring residential clean", capacityModel: "route", defaultDurationMinutes: 150, requiredSkills: ["residential-clean"], color: "#00897B" },
    { code: "deep", name: "Deep clean", capacityModel: "route", defaultDurationMinutes: 300, requiredSkills: ["residential-clean"] },
    { code: "move", name: "Move in or move out clean", capacityModel: "route", defaultDurationMinutes: 300, requiredSkills: ["residential-clean"], color: "#EF6C00" },
    { code: "comm-night", name: "Commercial nightly clean", capacityModel: "route", defaultDurationMinutes: 90, requiredSkills: ["janitorial"], color: "#3949AB" },
    { code: "post-con", name: "Post construction clean", capacityModel: "crew_production", defaultDurationMinutes: 480, requiredSkills: ["post-construction"], productionUnit: "square feet" },
    { code: "floor-care", name: "Periodic floor and carpet care", capacityModel: "crew_production", defaultDurationMinutes: 300, requiredSkills: ["floor-care"], productionUnit: "square feet" },
    { code: "walkthrough", name: "Estimate walkthrough", capacityModel: "technician_dispatch", defaultDurationMinutes: 30 },
  ],

  /**
   * Residential is priced by frequency and size band because that is how the
   * customer shops it. The frequency discount is built into the price rather
   * than applied as a line item discount: a weekly home is cheaper per visit
   * because it is never actually dirty, not because the customer negotiated.
   */
  priceBook: [
    { code: "RES-W-S", name: "Weekly clean, up to 1,500 sq ft", category: "Recurring residential", price: "138.00", cost: "64.00", laborMinutes: 120, taxClass: "service", description: "Kitchen, bathrooms, all living areas and bedrooms, floors, surfaces and fixtures, every week by the same team wherever we can." },
    { code: "RES-W-M", name: "Weekly clean, 1,500 to 2,500 sq ft", category: "Recurring residential", price: "168.00", cost: "80.00", laborMinutes: 150, taxClass: "service" },
    { code: "RES-W-L", name: "Weekly clean, 2,500 to 3,500 sq ft", category: "Recurring residential", price: "208.00", cost: "98.00", laborMinutes: 190, taxClass: "service" },
    { code: "RES-BW-S", name: "Biweekly clean, up to 1,500 sq ft", category: "Recurring residential", price: "152.00", cost: "68.00", laborMinutes: 135, taxClass: "service" },
    { code: "RES-BW-M", name: "Biweekly clean, 1,500 to 2,500 sq ft", category: "Recurring residential", price: "182.00", cost: "84.00", laborMinutes: 165, taxClass: "service" },
    { code: "RES-BW-L", name: "Biweekly clean, 2,500 to 3,500 sq ft", category: "Recurring residential", price: "228.00", cost: "104.00", laborMinutes: 205, taxClass: "service" },
    { code: "RES-4W-M", name: "Every four weeks clean, 1,500 to 2,500 sq ft", category: "Recurring residential", price: "208.00", cost: "92.00", laborMinutes: 185, taxClass: "service" },
    { code: "RES-4W-L", name: "Every four weeks clean, 2,500 to 3,500 sq ft", category: "Recurring residential", price: "258.00", cost: "112.00", laborMinutes: 225, taxClass: "service" },
    { code: "RES-ONE-M", name: "One time clean, 1,500 to 2,500 sq ft", category: "Residential one time", price: "268.00", cost: "108.00", laborMinutes: 240, taxClass: "service", description: "A single visit with no commitment. Priced higher than a recurring visit because a home cleaned once has months of build up in it." },
    { code: "RES-SQFT-ADD", name: "Additional finished area, per 500 sq ft", category: "Recurring residential", price: "24.00", cost: "11.00", laborMinutes: 20, taxClass: "service" },
    { code: "RES-BATH-ADD", name: "Additional full bathroom", category: "Recurring residential", price: "26.00", cost: "12.00", laborMinutes: 20, taxClass: "service" },
    { code: "DEEP-S", name: "Deep clean, up to 1,500 sq ft", category: "Deep clean", price: "325.00", cost: "148.00", laborMinutes: 300, taxClass: "service", description: "Everything in a standard clean plus baseboards, door frames, vents, light fixtures, inside window sills, and hand detail on kitchen and bathroom build up." },
    { code: "DEEP-M", name: "Deep clean, 1,500 to 2,500 sq ft", category: "Deep clean", price: "435.00", cost: "195.00", laborMinutes: 390, taxClass: "service" },
    { code: "DEEP-L", name: "Deep clean, 2,500 to 3,500 sq ft", category: "Deep clean", price: "555.00", cost: "246.00", laborMinutes: 480, taxClass: "service" },
    { code: "MOVE-S", name: "Move in or move out clean, up to 1,500 sq ft", category: "Move in and move out", price: "385.00", cost: "168.00", laborMinutes: 330, taxClass: "service", description: "Empty home cleaned end to end: inside every cabinet and drawer, inside the oven and refrigerator, all appliances, all floors, ready for a walkthrough." },
    { code: "MOVE-M", name: "Move in or move out clean, 1,500 to 2,500 sq ft", category: "Move in and move out", price: "495.00", cost: "215.00", laborMinutes: 420, taxClass: "service" },
    { code: "MOVE-L", name: "Move in or move out clean, 2,500 to 3,500 sq ft", category: "Move in and move out", price: "635.00", cost: "278.00", laborMinutes: 540, taxClass: "service" },
    { code: "POST-CON-SF", name: "Post construction clean, per square foot", category: "Post construction", price: "0.46", cost: "0.22", taxClass: "service", description: "Rough and final clean after trades are out: dust from every surface including above eye line, sticker and adhesive removal, window and track detail." },
    { code: "COMM-OFF-SF", name: "Office nightly cleaning, per square foot per month", category: "Commercial recurring", price: "0.11", cost: "0.062", taxClass: "service", description: "Priced against a written scope of work. Frequency, restroom count and trash volume move this number more than square footage alone." },
    { code: "COMM-MED-SF", name: "Medical office cleaning, per square foot per month", category: "Commercial recurring", price: "0.17", cost: "0.098", taxClass: "service" },
    { code: "COMM-DAY-PORT", name: "Day porter, per hour", kind: "labor", category: "Commercial recurring", price: "39.00", cost: "25.00", laborMinutes: 60, taxClass: "labor" },
    { code: "COMM-RESTROOM", name: "Restroom deep sanitise, per fixture", category: "Commercial periodic", price: "15.00", cost: "6.00", laborMinutes: 12, taxClass: "service" },
    { code: "FLOOR-STRIP-SF", name: "Strip and wax resilient floor, per square foot", category: "Floor care", price: "0.88", cost: "0.39", taxClass: "service" },
    { code: "FLOOR-BUFF-SF", name: "Buff and burnish, per square foot", category: "Floor care", price: "0.22", cost: "0.095", taxClass: "service" },
    { code: "CARPET-EXT-SF", name: "Carpet hot water extraction, per square foot", category: "Floor care", price: "0.39", cost: "0.17", taxClass: "service" },
    { code: "TILE-GROUT-SF", name: "Tile and grout deep clean, per square foot", category: "Floor care", price: "1.10", cost: "0.46", taxClass: "service" },
    { code: "ADD-FRIDGE", name: "Inside refrigerator", category: "Add ons", price: "48.00", cost: "19.00", laborMinutes: 35, taxClass: "service" },
    { code: "ADD-OVEN", name: "Inside oven", category: "Add ons", price: "48.00", cost: "19.00", laborMinutes: 35, taxClass: "service" },
    { code: "ADD-CAB", name: "Inside cabinets and drawers", category: "Add ons", price: "68.00", cost: "29.00", laborMinutes: 50, taxClass: "service" },
    { code: "ADD-WIN-INT", name: "Interior window, per pane", category: "Add ons", price: "6.00", cost: "2.40", laborMinutes: 6, taxClass: "service" },
    { code: "ADD-WIN-EXT", name: "Exterior window, ground floor, per pane", category: "Add ons", price: "8.50", cost: "3.40", laborMinutes: 8, taxClass: "service" },
    { code: "ADD-BASE", name: "Hand wipe baseboards, whole home", category: "Add ons", price: "58.00", cost: "25.00", laborMinutes: 45, taxClass: "service" },
    { code: "ADD-LAUNDRY", name: "Laundry, wash dry and fold, per load", category: "Add ons", price: "26.00", cost: "10.00", laborMinutes: 20, taxClass: "service" },
    { code: "ADD-PET", name: "Pet hair and litter surcharge", category: "Add ons", price: "35.00", cost: "14.00", laborMinutes: 25, taxClass: "service", description: "Applied where pet hair adds real time to every room. Agreed at the walkthrough so it is never a surprise on the invoice." },
    { code: "SUPPLY-PASS", name: "Consumable supplies, passed through at cost", kind: "material", category: "Fees", price: "0", taxClass: "material", description: "Paper, liners and soap stocked for a commercial account, billed at the amount we paid." },
    { code: "KEY-LOCKBOX", name: "Lockbox supplied and installed", kind: "equipment", category: "Fees", price: "48.00", cost: "24.00", laborMinutes: 15, taxClass: "equipment", description: "A lockbox means the clean happens whether or not anyone is home, and it means no member of staff is carrying your house key around all day." },
    { code: "CANCEL-LATE", name: "Late cancellation or lockout fee", kind: "fee", category: "Fees", price: "75.00", taxClass: "service", description: "Charged when a team arrives and cannot get in, or a visit is cancelled too late to fill the slot. The team is paid either way." },
    { code: "TRIP-OUT", name: "Travel fee outside the route area", kind: "fee", category: "Fees", price: "29.00", taxClass: "service" },
  ],

  /**
   * Deliberately small. A cleaning company owns almost no customer equipment,
   * and a pack that invents an asset tree here would make the setup wizard
   * ask forty questions nobody can answer. What it does hold is access: keys,
   * codes, cards and the alarm, and that is worth a real record with a
   * custody history. On site equipment is only listed because a commercial
   * account sometimes has a machine left in a janitor closet, and when that
   * machine dies somebody has to know whose it is.
   */
  equipmentCategories: [
    { code: "access-credential", name: "Key, fob or access code", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "credential_type", label: "Type", kind: "select", options: ["House key", "Lockbox", "Door code", "Smart lock code", "Building fob", "Garage code", "Gate code"] },
      { key: "identifier", label: "Tag or identifier", kind: "text" },
      { key: "issued_to", label: "Issued to", kind: "text" },
      { key: "issued_date", label: "Issued date", kind: "date" },
      { key: "returned_date", label: "Returned date", kind: "date" },
    ]},
    { code: "alarm-system", name: "Alarm or access system", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "panel_location", label: "Panel location", kind: "text" },
      { key: "entry_delay_seconds", label: "Entry delay", kind: "numeric" },
      { key: "monitoring_contact", label: "Who to call on a false alarm", kind: "text" },
    ]},
    { code: "site-equipment", name: "Equipment stored on site", attributes: [
      { key: "equipment_type", label: "Type", kind: "select", options: ["Upright vacuum", "Backpack vacuum", "Autoscrubber", "Burnisher", "Carpet extractor", "Mop and bucket system"] },
      { key: "owned_by", label: "Owned by", kind: "select", options: ["Us", "Customer"] },
      { key: "storage_location", label: "Storage location", kind: "text" },
    ]},
  ],

  /**
   * Fewer readings than a mechanical trade, and none of them regulated. What
   * a cleaning owner actually needs back from a visit is whether the scope was
   * completed, how long it took against what was sold, what was used, and what
   * the place looked like on arrival, because that last one is the whole of
   * every scope dispute.
   */
  readings: [
    { key: "checklist_pct", label: "Checklist completion", kind: "numeric", unit: "%", trend: true, min: 0, max: 100 },
    { key: "rooms_completed", label: "Rooms or areas completed", kind: "numeric", trend: true, min: 0, max: 200, customerVisible: false },
    { key: "time_on_site", label: "Time on site", kind: "numeric", unit: "min", trend: true, min: 10, max: 720, customerVisible: false },
    { key: "condition_on_arrival", label: "Condition on arrival", kind: "select", options: ["Ready to clean", "Cluttered", "Heavily soiled", "Occupied and in use", "Could not access"] },
    { key: "condition_score", label: "Condition score after the visit", kind: "numeric", trend: true, min: 1, max: 5 },
    { key: "chemical_used", label: "Concentrate used", kind: "numeric", unit: "oz", trend: true, min: 0, max: 640, customerVisible: false },
    { key: "liners_used", label: "Can liners used", kind: "numeric", trend: true, min: 0, max: 500, customerVisible: false },
    { key: "supply_restock", label: "Supplies restocked on site", kind: "text", customerVisible: false },
    { key: "access_method", label: "How the team got in", kind: "select", options: ["Lockbox", "Door code", "Smart lock code", "Customer home", "Building fob", "Key from office"], customerVisible: false },
    { key: "damage_found", label: "Damage or breakage found or caused", kind: "boolean" },
    { key: "damage_photo", label: "Photo of the damage", kind: "photo" },
    { key: "secured_on_exit", label: "Property locked and alarm set on exit", kind: "boolean" },
  ],

  checklists: [
    /**
     * Custody. Every item here exists because of a specific way a cleaning
     * company loses a customer: the code written in a note the customer can
     * read on the portal, the key that went home in somebody's pocket, the
     * alarm nobody re-set, the unlocked back door.
     */
    { code: "access-keys", name: "Key and access handling", jobTypeCodes: ["recur-res", "deep", "move", "comm-night"], items: [
      { label: "Confirm the access method on the account before leaving for the stop", required: true },
      { label: "Record which credential was used to enter", required: true },
      { label: "Disarm the alarm using the code on file and confirm it cleared", required: true, safety: true },
      { label: "Never write a door, gate or alarm code into a note the customer portal shows", required: true },
      { label: "Keep keys on the team lead, never left in a vehicle or on a counter", required: true, safety: true },
      { label: "Before leaving, walk every exterior door and window and confirm it is locked", required: true, safety: true },
      { label: "Re-set the alarm and confirm it armed", required: true, safety: true },
      { label: "Return the key to the lockbox or to the office the same day and log it", required: true },
      { label: "Photograph the locked front door as the last action on the stop", required: true },
    ]},
    /**
     * Arrival condition. The rule that matters is do not touch it: a team
     * that tidies a broken thing away is a team that owns the breakage.
     */
    { code: "arrival-condition", name: "Arrival condition and damage", jobTypeCodes: ["recur-res", "deep", "move", "comm-night", "post-con"], items: [
      { label: "Walk the property before starting and record the condition on arrival", required: true },
      { label: "If something is already broken, stained or missing, photograph it before touching anything", required: true },
      { label: "Do not clean, move or attempt to repair anything that is already damaged", required: true, safety: true },
      { label: "Call the office before continuing, and before saying anything to the customer", required: true },
      { label: "If the team breaks something, stop, photograph it, and report it in the same visit", required: true },
      { label: "If the property cannot be safely entered or worked in, leave and call the office", required: true, safety: true },
      { label: "Record the damage reading and attach every photo to this visit", required: true },
      { label: "Note anything that needs a trade the customer should call: a leak, a failed appliance, mould growth" },
    ]},
    { code: "res-standard", name: "Standard residential clean", jobTypeCodes: ["recur-res", "deep"], items: [
      { label: "Confirm any pets are secured or accounted for before opening doors", required: true, safety: true },
      { label: "Check every product against its label and never mix a bleach product with an ammonia product", required: true, safety: true },
      { label: "Ventilate bathrooms before using any concentrated product", required: true, safety: true },
      { label: "Put out a wet floor sign on any hard floor while it dries", required: true, safety: true },
      { label: "Use a step stool. Never stand on furniture, a worktop or a bath edge", required: true, safety: true },
      { label: "Kitchen: worktops, sink, hob, exterior of appliances, splashback, floor", required: true },
      { label: "Bathrooms: shower, bath, toilet, sink, mirrors, fixtures, floor", required: true },
      { label: "All rooms: dust reachable surfaces, wipe touch points, vacuum and mop floors", required: true },
      { label: "Empty bins and replace liners" },
      { label: "Record the checklist completion and time on site", required: true },
      { label: "Final walk of every room before packing the caddy", required: true },
    ]},
  ],

  inspectionPrograms: [
    {
      code: "quality-inspection",
      name: "Quality inspection",
      standard: "Scored against the written scope of work agreed for this account. A scope dispute is settled by the scope, not by the inspection.",
      reportAudience: "customer",
      frequencyMonths: 1,
      checkpoints: [
        { key: "restrooms", label: "Restrooms: fixtures, floors, dispensers filled, no odour", severityOnFail: "major" },
        { key: "floors", label: "Floors: vacuumed, mopped, edges and corners, no streaking", severityOnFail: "minor" },
        { key: "trash", label: "Trash removed, liners replaced, bins clean", severityOnFail: "major" },
        { key: "high_dust", label: "High dusting: vents, ledges, frames, above eye line", severityOnFail: "minor" },
        { key: "touch_points", label: "Touch points: handles, switches, rails, lift buttons", severityOnFail: "major" },
        { key: "glass_entry", label: "Entry glass and lobby presentable", severityOnFail: "minor" },
        { key: "breakroom", label: "Breakroom and kitchen: surfaces, sink, appliance exteriors", severityOnFail: "minor" },
        { key: "supplies", label: "Consumable supply levels adequate until the next stock", requiresReading: true, severityOnFail: "advisory" },
        { key: "closet", label: "Janitor closet tidy, chemicals labelled and stored correctly", severityOnFail: "major" },
        { key: "prior_items", label: "Every item from the last inspection closed out", severityOnFail: "major" },
      ],
    },
  ],

  /**
   * One entry, and it is a record kept rather than a filing made. This trade's
   * real obligations are employment and wage and hour, which are a company
   * matter and not something a trade pack should pretend to handle.
   */
  submissions: [
    {
      kind: "hazcom.chemical_inventory",
      label: "Chemical inventory and safety data sheet index",
      authorityName: "Kept on site and available to employees and inspectors",
      jurisdiction: "US",
      cadence: "annual",
      notes:
        "The pack lists every cleaning product in use by account and links each to its safety data sheet, so the index can be produced for a site binder or for a customer who asks what is being used in their building. Nothing is filed anywhere by the software, and no jurisdiction's specific requirements are encoded.",
    },
  ],

  retention: [
    { entityType: "access_credential", entityKind: "key_custody", clockStart: "contract_ended", retainMonths: 24, basis: "Who held a key or code to a property and when it came back. The question is asked long after the account closes." },
    { entityType: "photo", entityKind: "damage", clockStart: "work_completed", retainMonths: 36, basis: "Damage and breakage claims arrive months after the visit, and the arrival photo is the only defence." },
    { entityType: "inspection", entityKind: "quality-inspection", clockStart: "next_activity_of_type", retainMonths: 24, basis: "Commercial accounts review a year of inspections at renewal." },
  ],

  /**
   * Density economics. Revenue per cleaner hour is the number, and every
   * other KPI here explains a move in it: too few stops, too much drive time,
   * customers churning off the route, or cancellations hollowing out a day
   * that is already staffed.
   */
  kpis: [
    { key: "revenue_per_cleaner_hour", label: "Revenue per cleaner hour", definition: "Invoiced revenue divided by paid cleaner hours, counting every person on a team separately. EXCLUDES office and administrative hours, and EXCLUDES training hours for a new hire shadowing a team, which produce no revenue and would make every hiring month look like a downturn.", format: "money", target: "52" },
    { key: "stops_per_day", label: "Stops per team day", definition: "Completed stops divided by team days worked. EXCLUDES deep cleans, move outs and post construction, which are all day jobs and would pull the recurring route average down to nothing.", format: "number", target: "6" },
    { key: "drive_time_pct", label: "Drive time share of the day", definition: "Drive minutes between stops divided by total clocked minutes. EXCLUDES the drive from home or office to the first stop and from the last stop home, which is commute and not route inefficiency.", format: "percent", target: "15" },
    { key: "recurring_retention", label: "Recurring customer retention", definition: "Recurring accounts still active at the end of the period divided by accounts active at the start. EXCLUDES customers who moved out of the service area or sold the home, which are not churn the owner can do anything about, and EXCLUDES one time cleans entirely.", format: "percent", target: "88" },
    { key: "cancel_rate_route", label: "Cancellation rate by route", definition: "Stops cancelled or skipped inside the notice window divided by stops scheduled, reported per route and per weekday. EXCLUDES visits the company cancelled for weather or staffing, which are a separate and more serious number.", format: "percent", target: "5" },
    { key: "reclean_rate", label: "Reclean rate", definition: "Zero revenue return visits to fix a complaint divided by completed visits. EXCLUDES return visits to finish work that was cut short because the team could not get in, which belong to the access problem and not to quality.", format: "percent", target: "2" },
    { key: "oneoff_to_recurring", label: "One time to recurring conversion", definition: "One time, deep or move in customers who book a recurring plan within sixty days, divided by one time customers served. EXCLUDES move out cleans, where the customer is leaving the home and was never a candidate.", format: "percent", target: "25" },
    { key: "supply_cost_pct", label: "Supply cost share of revenue", definition: "Chemical, consumable and equipment consumable cost divided by invoiced revenue. EXCLUDES supplies stocked for a commercial account and billed back at cost, which are a pass through and not a margin leak.", format: "percent", target: "4" },
  ],

  portalBlocks: [
    { kind: "next_visit", title: "Your next clean" },
    { kind: "checklist_results", title: "What we did this visit" },
    { kind: "photo_gallery", title: "Before and after" },
    { kind: "visit_timeline", title: "Your cleaning history" },
    { kind: "plan_status", title: "Your plan and frequency" },
    { kind: "contact_card", title: "Your team" },
    { kind: "invoices" },
  ],
};
