import type { TradePackInput } from "../src/schema";

/**
 * Pest control. The pack that proves regulated work is content, not code.
 *
 * Every other trade in this set logs what was done. Pest control logs what was
 * APPLIED, and the application record is the deliverable: product, EPA
 * registration number, rate, total amount, target pest, method, treated area,
 * the licensed person who applied it and the conditions at the time. An
 * inspector can ask for it years later and a food safety auditor can ask for it
 * monthly. If the pack schema cannot carry that, every regulated trade needs
 * bespoke engineering. It can, and this file is the proof.
 *
 * Two rules govern what is written here, and they are the same rule twice.
 *
 * The pack models the FIELDS that must be captured. It ships no EPA
 * registration numbers, no product names tied to a registration, no label
 * rates, no re-entry interval durations, no recording deadlines and no state
 * form numbers. Those are the operator's, they change, they differ by state,
 * and a pack that guessed them would be worse than a pack that stayed quiet:
 * the label is the law and the label is not in this repository.
 *
 * Capacity is a route. The scarce thing is a technician day of stops in a
 * tight geography, not an hour of skilled diagnosis, and the economics follow
 * from density. Termite work is the exception and runs as crew production.
 *
 * Prices are national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const pestControl: TradePackInput = {
  id: "pest-control",
  name: "Pest control",
  version: 1,
  capacityModel: "route",
  summary:
    "General pest, termite, rodent and targeted pest work sold as recurring programs and run as routes, with a pesticide application record on every visit and device history per station.",
  status:
    "Price book, job types, checklists, the application record readings, device categories and KPIs are complete. Products are captured as fields, not seeded: the operator loads their own product register with registration numbers, label rates and re-entry intervals. State use report formatters and state WDI forms are not written. Route optimisation and subscription billing live in the product, not the pack.",

  jobTypes: [
    // The initial is dispatched rather than routed: it is longer, it is sold
    // separately and it usually cannot wait for the route to come round.
    { code: "initial", name: "Initial service", capacityModel: "technician_dispatch", defaultDurationMinutes: 90, requiredSkills: ["applicator-general"], color: "#0B57D0" },
    { code: "recurring", name: "Recurring program service", capacityModel: "route", defaultDurationMinutes: 35, requiredSkills: ["applicator-general"], color: "#1E8E3E" },
    { code: "reservice", name: "Warranty re service", capacityModel: "route", defaultDurationMinutes: 30, requiredSkills: ["applicator-general"], color: "#C4261D" },
    { code: "commercial", name: "Commercial device service", capacityModel: "route", defaultDurationMinutes: 60, requiredSkills: ["applicator-general", "commercial-accounts"] },
    { code: "termite", name: "Termite treatment", capacityModel: "crew_production", defaultDurationMinutes: 360, requiredSkills: ["applicator-termite"], productionUnit: "linear foot" },
    { code: "wdi", name: "Wood destroying insect inspection", capacityModel: "technician_dispatch", defaultDurationMinutes: 75, requiredSkills: ["applicator-termite"] },
    { code: "bedbug", name: "Bed bug treatment", capacityModel: "technician_dispatch", defaultDurationMinutes: 180, requiredSkills: ["applicator-general"] },
  ],

  priceBook: [
    // Programs are priced per service, because the customer is usually billed
    // monthly while being serviced quarterly and the two must not be conflated.
    { code: "PROG-QTR-S", name: "Quarterly general pest program, up to 2000 sq ft", category: "Programs", price: "119.00", cost: "38.00", laborMinutes: 35, taxClass: "service", description: "Exterior perimeter and interior as needed, every ninety days. Covers the common household pests listed in your agreement. Free re service between visits." },
    { code: "PROG-QTR-M", name: "Quarterly general pest program, 2001 to 3500 sq ft", category: "Programs", price: "139.00", cost: "44.00", laborMinutes: 40, taxClass: "service" },
    { code: "PROG-QTR-L", name: "Quarterly general pest program, over 3500 sq ft", category: "Programs", price: "169.00", cost: "52.00", laborMinutes: 50, taxClass: "service" },
    { code: "PROG-BIMO", name: "Bi monthly general pest program, per service", category: "Programs", price: "99.00", cost: "36.00", laborMinutes: 30, taxClass: "service" },
    { code: "PROG-MON", name: "Monthly general pest program, per service", category: "Programs", price: "79.00", cost: "32.00", laborMinutes: 25, taxClass: "service" },
    { code: "PROG-ANN-PRE", name: "Annual prepay, four quarterly services", category: "Programs", price: "449.00", cost: "152.00", taxClass: "service", description: "A year of quarterly service paid up front. One service free against the per visit rate." },
    { code: "PROG-COMM-MON", name: "Commercial monthly service, per visit", category: "Programs", price: "149.00", cost: "54.00", laborMinutes: 60, taxClass: "service" },
    { code: "INIT-STD", name: "Initial service, standard", category: "Initial", price: "199.00", cost: "58.00", laborMinutes: 90, taxClass: "service", description: "Full interior and exterior inspection, treatment of active areas, web and nest removal, and a written findings report with photographs." },
    { code: "INIT-HEAVY", name: "Initial service, active infestation", category: "Initial", price: "349.00", cost: "96.00", laborMinutes: 150, taxClass: "service" },
    { code: "MOSQ-SVC", name: "Mosquito program, per service", category: "Targeted pests", price: "89.00", cost: "29.00", laborMinutes: 30, taxClass: "service" },
    { code: "MOSQ-EVENT", name: "Single event mosquito treatment", category: "Targeted pests", price: "149.00", cost: "38.00", laborMinutes: 45, taxClass: "service" },
    { code: "ANT-INT", name: "Interior ant treatment", category: "Targeted pests", price: "179.00", cost: "42.00", laborMinutes: 60, taxClass: "service" },
    { code: "ROACH-CLEANOUT", name: "German cockroach clean out, per unit", category: "Targeted pests", price: "249.00", cost: "64.00", laborMinutes: 90, taxClass: "service" },
    { code: "ROACH-FOLLOW", name: "German cockroach follow up, per unit", category: "Targeted pests", price: "119.00", cost: "38.00", laborMinutes: 45, taxClass: "service" },
    { code: "FLEA-INT", name: "Flea treatment, interior, per 1000 sq ft", category: "Targeted pests", price: "189.00", cost: "44.00", laborMinutes: 60, taxClass: "service" },
    { code: "SPIDER-EXT", name: "Exterior spider and web sweep", category: "Targeted pests", price: "129.00", cost: "32.00", laborMinutes: 45, taxClass: "service" },
    { code: "WASP-NEST", name: "Wasp or hornet nest removal, each", category: "Targeted pests", price: "159.00", cost: "36.00", laborMinutes: 45, taxClass: "service" },
    { code: "BB-INSPECT", name: "Bed bug inspection", category: "Bed bugs", price: "149.00", cost: "40.00", laborMinutes: 60, taxClass: "service" },
    { code: "BB-CHEM", name: "Bed bug chemical treatment, per room", category: "Bed bugs", price: "289.00", cost: "74.00", laborMinutes: 90, taxClass: "service" },
    { code: "BB-HEAT", name: "Bed bug heat treatment, per room", category: "Bed bugs", price: "549.00", cost: "198.00", laborMinutes: 240, taxClass: "service" },
    { code: "ROD-CLEANOUT", name: "Rodent clean out, initial", category: "Rodents", price: "349.00", cost: "88.00", laborMinutes: 120, taxClass: "service" },
    { code: "ROD-STATION", name: "Exterior rodent bait station, installed, each", kind: "equipment", category: "Rodents", price: "49.00", cost: "17.00", laborMinutes: 10, taxClass: "equipment" },
    { code: "ROD-STATION-SVC", name: "Bait station service, per station per visit", category: "Rodents", price: "9.00", cost: "3.00", laborMinutes: 4, taxClass: "service" },
    { code: "ROD-TRAP", name: "Snap or multi catch trap, installed, each", kind: "equipment", category: "Rodents", price: "29.00", cost: "9.00", laborMinutes: 8, taxClass: "equipment" },
    { code: "ROD-EXCL-LF", name: "Rodent exclusion sealing, per linear foot", category: "Rodents", price: "14.00", cost: "4.50", laborMinutes: 6, taxClass: "service", warrantyMonths: 12 },
    { code: "MON-INSECT", name: "Insect monitor placement, each", kind: "equipment", category: "Devices", price: "6.00", cost: "1.75", taxClass: "equipment" },
    { code: "ILT-INSTALL", name: "Insect light trap, installed", kind: "equipment", category: "Devices", price: "389.00", cost: "148.00", laborMinutes: 60, taxClass: "equipment", warrantyMonths: 12 },
    { code: "ILT-SERVICE", name: "Insect light trap service, lamp and glueboard", category: "Devices", price: "69.00", cost: "24.00", laborMinutes: 15, taxClass: "service" },
    { code: "TERM-LIQ-LF", name: "Liquid termite treatment, per linear foot", category: "Termite", price: "9.50", cost: "2.80", laborMinutes: 4, taxClass: "service", warrantyMonths: 12 },
    { code: "TERM-SPOT", name: "Termite spot treatment", category: "Termite", price: "395.00", cost: "92.00", laborMinutes: 120, taxClass: "service", warrantyMonths: 12 },
    { code: "TERM-BAIT-INST", name: "Termite bait system installation, up to twenty stations", kind: "equipment", category: "Termite", price: "1450.00", cost: "420.00", laborMinutes: 240, taxClass: "equipment", warrantyMonths: 12 },
    { code: "TERM-BAIT-MON", name: "Termite bait system monitoring, annual", category: "Termite", price: "325.00", cost: "88.00", taxClass: "service" },
    { code: "TERM-RENEW", name: "Termite warranty renewal, annual", category: "Termite", price: "195.00", cost: "40.00", taxClass: "service", description: "Keeps your termite agreement in force for another year, including the annual inspection." },
    { code: "WDI-REPORT", name: "Wood destroying insect inspection and report", category: "Inspections", price: "125.00", cost: "34.00", laborMinutes: 75, taxClass: "service" },
    // Chemistry is billed inside the service almost everywhere. This line
    // exists so a shop that does bill it can, and so the finished dilution
    // actually applied has a unit of measure to hang off. The operator ties it
    // to a product in their own register, which is where the registration
    // number, the label rate and the re entry interval live.
    { code: "MAT-DILUTION-GAL", name: "Finished dilution applied, per gallon", kind: "material", category: "Materials", price: "6.00", cost: "1.80", taxClass: "material" },
    { code: "RESERVICE-WAR", name: "Warranty re service, no charge", category: "Programs", price: "0", laborMinutes: 30, taxClass: "service", description: "If the pests come back between visits, so do we, at no charge." },
    { code: "FEE-TRIP", name: "Trip fee, no access at the scheduled time", kind: "fee", category: "Fees", price: "59.00", taxClass: "service" },
    { code: "FEE-AH", name: "After hours or weekend service", kind: "fee", category: "Fees", price: "89.00", taxClass: "service" },
    { code: "FEE-ZONE", name: "Extended travel outside the route area", kind: "fee", category: "Fees", price: "39.00", taxClass: "service" },
  ],

  // Pest is one of the few trades where the tracked asset is not the
  // customer's equipment but the devices this company installed and now owns
  // the service history for. They nest: a station is a housing, and what is
  // inside it (bait, a trap mechanism, a lure) is consumed and replaced on its
  // own clock, which is exactly the history an auditor asks to see.
  equipmentCategories: [
    { code: "site", name: "Serviced structure or area", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "site_type", label: "Site type", kind: "select", options: ["Single family home", "Multi family unit", "Common area", "Restaurant", "Food processing", "Warehouse", "Retail", "Office", "School", "Healthcare", "Other"] },
      { key: "sq_ft", label: "Treated area, square feet", kind: "numeric" },
      { key: "construction", label: "Construction type", kind: "select", options: ["Slab", "Crawl space", "Basement", "Pier and beam", "Mixed"] },
    ]},
    { code: "rodent-station-ext", name: "Exterior rodent bait station", parentCode: "site", tracksWarranty: false, attributes: [
      { key: "station_number", label: "Station number on the site map", kind: "text" },
      { key: "location", label: "Location description", kind: "text" },
      { key: "anchored", label: "Anchored and tamper resistant", kind: "boolean" },
      { key: "key_number", label: "Key or lock number", kind: "text" },
    ]},
    { code: "rodent-station-int", name: "Interior rodent station", parentCode: "site", tracksWarranty: false, attributes: [
      { key: "station_number", label: "Station number on the site map", kind: "text" },
      { key: "location", label: "Location description", kind: "text" },
      { key: "device_type", label: "Device type", kind: "select", options: ["Snap trap", "Multi catch", "Glue board", "Bait station"] },
    ]},
    // What sits inside a station is its own record because it is replaced on
    // its own schedule and, when it is a bait, it is a regulated product.
    { code: "bait-placement", name: "Bait placement in a station", parentCode: "rodent-station-ext", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "form", label: "Bait form", kind: "select", options: ["Block", "Soft bait", "Pellet", "Liquid", "None, mechanical only"] },
      { key: "placed_on", label: "Placed on", kind: "date" },
    ]},
    { code: "trap-mechanism", name: "Trap mechanism in a station", parentCode: "rodent-station-int", tracksSerial: false, tracksWarranty: false },
    { code: "insect-monitor", name: "Insect monitor", parentCode: "site", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "monitor_number", label: "Monitor number on the site map", kind: "text" },
      { key: "location", label: "Location description", kind: "text" },
    ]},
    { code: "pheromone-lure", name: "Pheromone lure in a monitor", parentCode: "insect-monitor", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "target", label: "Target", kind: "text" },
      { key: "expires_on", label: "Lure expiry", kind: "date" },
    ]},
    { code: "insect-light-trap", name: "Insect light trap", parentCode: "site", attributes: [
      { key: "unit_number", label: "Unit number on the site map", kind: "text" },
      { key: "mounting", label: "Mounting", kind: "select", options: ["Wall", "Ceiling", "Free standing"] },
    ]},
    { code: "ilt-lamp", name: "Insect light trap lamp", parentCode: "insect-light-trap", tracksSerial: false, attributes: [
      { key: "changed_on", label: "Lamp changed on", kind: "date" },
    ]},
    { code: "termite-station", name: "Termite bait station", parentCode: "site", tracksWarranty: false, attributes: [
      { key: "station_number", label: "Station number on the graph", kind: "text" },
      { key: "distance_from_structure", label: "Distance from the structure, feet", kind: "numeric" },
    ]},
    { code: "termite-cartridge", name: "Termite bait cartridge", parentCode: "termite-station", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "installed_on", label: "Installed on", kind: "date" },
    ]},
  ],

  /**
   * The application record, as readings.
   *
   * Everything marked `regulated` belongs to one event: a product was applied
   * at a place, by a licensed person, at a rate, to a target. Capturing them as
   * readings rather than as a bespoke form means they trend, they range check,
   * they export, and they are the same primitive the refrigerant record in HVAC
   * and the chemistry log in pool already use.
   *
   * No unit is set on the product quantity fields on purpose. The unit comes
   * from the product's own label in the operator's register, and a pack that
   * hard coded ounces would be wrong for every product sold by the gallon.
   */
  readings: [
    { key: "product_applied", label: "Product applied, brand or product name", kind: "chemical", regulated: true, customerVisible: true },
    { key: "epa_reg_no", label: "EPA registration number of the product applied", kind: "chemical", regulated: true, customerVisible: true },
    { key: "amount_applied", label: "Total amount of product applied", kind: "chemical", regulated: true, trend: true, customerVisible: true },
    { key: "mix_rate", label: "Mix rate used, against the label rate", kind: "chemical", regulated: true, trend: true, customerVisible: false },
    { key: "concentration_pct", label: "Finished concentration applied", kind: "numeric", unit: "%", regulated: true, trend: true, min: 0, max: 100, customerVisible: false },
    { key: "target_pest", label: "Target pest or purpose", kind: "select", regulated: true, options: ["Ants", "German cockroach", "Other cockroach", "Rodent", "Subterranean termite", "Drywood termite", "Other wood destroying insect", "Bed bug", "Flea", "Tick", "Mosquito", "Spider", "Stored product pest", "Wasp or hornet", "Fly", "Occasional invader", "Other"] },
    { key: "application_method", label: "Application method", kind: "select", regulated: true, options: ["Crack and crevice", "Spot", "Perimeter band", "Broadcast", "Void injection", "Bait placement", "Dust", "Space or fogging", "Soil trench", "Soil rod injection", "Foam"] },
    { key: "area_treated_sqft", label: "Area treated", kind: "measurement", unit: "sq ft", regulated: true, trend: true, min: 0, max: 250000 },
    { key: "linear_ft_treated", label: "Linear feet treated", kind: "measurement", unit: "ft", regulated: true, trend: true, min: 0, max: 5000 },
    { key: "applicator_name", label: "Name of the person applying or supervising", kind: "text", regulated: true, customerVisible: true },
    // Snapshot, never a live join to the employee record. Licences expire and
    // categories change, and the record has to say what was held on the day.
    { key: "applicator_license", label: "Licence number and category held on the day", kind: "text", regulated: true, customerVisible: false },
    // Start time is entered; the end time comes from the visit's own
    // completion timestamp rather than being typed twice.
    { key: "application_start", label: "Application start time", kind: "text", regulated: true, customerVisible: false },
    // The duration is on the product label, which is not in this repository.
    // The pack records only that the interval was read from the label and
    // communicated, and to whom.
    { key: "rei_communicated", label: "Re entry interval from the label communicated to the customer", kind: "boolean", regulated: true, customerVisible: true },
    { key: "air_temp", label: "Air temperature at application", kind: "numeric", unit: "F", regulated: true, trend: true, min: -20, max: 130, customerVisible: false },
    { key: "wind_speed", label: "Wind speed at application", kind: "numeric", unit: "mph", regulated: true, trend: true, min: 0, max: 40, customerVisible: false },
    // A visit with nothing applied is a legitimate outcome and a common one on
    // a monitoring account. It still has to say why, or the gap in the history
    // is indistinguishable from a technician who skipped the stop.
    { key: "no_product_reason", label: "No product applied, reason", kind: "select", customerVisible: false, options: ["No activity found, monitoring only", "Customer declined", "Occupant, pet or food risk present", "Weather unsuitable", "No access to the treatment area", "Mechanical or exclusion work only"] },
    { key: "stations_serviced", label: "Stations and devices serviced", kind: "numeric", trend: true, min: 0, max: 500 },
    { key: "station_activity", label: "Highest activity level found at any device", kind: "select", options: ["None", "Light", "Moderate", "Heavy"] },
  ],

  checklists: [
    { code: "pre-treat", name: "Pre treatment safety and notification", jobTypeCodes: ["initial", "recurring", "reservice", "bedbug", "termite"], items: [
      { label: "Confirm your licence covers this category and is current for the state of the service address", required: true, safety: true },
      { label: "Read the product label before mixing and mix only at a rate the label allows", required: true, safety: true },
      { label: "Put on the personal protective equipment the label requires and record what you wore", required: true, safety: true },
      { label: "Ask who is home: account for children, pregnant occupants, the elderly and anyone with a respiratory condition", required: true, safety: true },
      { label: "Confine pets and cover aquariums and reptile enclosures before treating", required: true, safety: true },
      { label: "Cover or remove food, utensils, pet bowls and food preparation surfaces before treating an interior", required: true, safety: true },
      { label: "Confirm no bare food contact surface has been treated", required: true, safety: true },
      { label: "Tell the customer the re entry interval stated on the label, in plain words, and record that you did", required: true, safety: true },
      { label: "Leave or send the label and safety data sheet for every product applied", required: true },
      { label: "Record the notification: who was told, when and by what channel", required: true },
      { label: "Confirm the spill kit is on the vehicle", safety: true },
      { label: "Lock the chemical compartment before leaving the site", required: true, safety: true },
    ]},
    { code: "service-visit", name: "Recurring service visit", jobTypeCodes: ["recurring", "commercial", "reservice"], items: [
      { label: "Check in at the site and sign the site logbook on a commercial account" },
      { label: "Review findings and open corrective actions from the last visit", required: true },
      { label: "Inspect the exterior perimeter, eaves, utility penetrations and entry points" },
      { label: "Service every station and monitor on the site map and record the activity level at each", required: true },
      { label: "Record conducive conditions: moisture, harbourage, sanitation, gaps and vegetation contact" },
      { label: "Record the application: product, EPA registration number, rate, total amount, method and target pest", required: true },
      { label: "Record the area treated in square feet, or linear feet for a perimeter or trench application", required: true },
      { label: "Record air temperature and wind speed at the time of application", required: true },
      { label: "If no product was applied, record the reason", required: true },
      { label: "Photograph anything the customer must fix" },
      { label: "Review the findings with the customer and record what was declined", required: true },
    ]},
    { code: "term-inspect", name: "Termite inspection and graph", jobTypeCodes: ["termite", "wdi"], items: [
      { label: "Confirm the crawl space or attic is safe to enter, including for gas, wiring and structure, before entering", required: true, safety: true },
      { label: "Check every accessible area for live insects, damage, mud tubes and evidence of previous treatment", required: true },
      { label: "Measure and record the linear footage of the structure inspected or treated", required: true },
      { label: "Note every obstructed or inaccessible area on the graph", required: true },
      { label: "Draw the graph and attach it to the report", required: true },
      { label: "Record moisture readings at each area of concern" },
      { label: "Record the treatment specification: trench, rod, drill spacing and total volume applied", required: true },
      { label: "Photograph all findings" },
      { label: "Explain the warranty terms and what voids them, and record that you did", required: true },
    ]},
  ],

  inspectionPrograms: [
    // reportAudience is "both" because on a food handling account the report
    // has two readers with different needs: the customer, who wants to know
    // what to fix, and a third party auditor, who wants an unbroken device
    // history and a trend. One report, two audiences, and the pack says so
    // rather than the product guessing.
    { code: "comm-monthly", name: "Commercial pest management site inspection", standard: "The site's own food safety or quality scheme, named by the operator", reportAudience: "both", frequencyMonths: 1, checkpoints: [
      { key: "stations-ext", label: "Every exterior station located, serviced and recorded", assetCategory: "rodent-station-ext", requiresReading: true, severityOnFail: "major" },
      { key: "stations-int", label: "Every interior device located, serviced and recorded", assetCategory: "rodent-station-int", requiresReading: true, severityOnFail: "major" },
      { key: "monitors", label: "Insect monitors inspected and catch recorded", assetCategory: "insect-monitor", requiresReading: true, severityOnFail: "minor" },
      { key: "ilt", label: "Insect light trap lamps and glueboards within service interval", assetCategory: "insect-light-trap", severityOnFail: "minor" },
      { key: "exclusion", label: "Structural exclusion intact: doors, seals, penetrations and screens", severityOnFail: "major" },
      { key: "sanitation", label: "Sanitation and conducive conditions reviewed with the site contact", severityOnFail: "advisory", failIsDeficiency: false },
      { key: "activity-trend", label: "Activity trend reviewed against previous visits", requiresReading: true, severityOnFail: "advisory" },
      { key: "prior-actions", label: "Corrective actions from the previous visit closed", severityOnFail: "critical" },
      { key: "logbook", label: "Site logbook, labels and safety data sheets current and on site", severityOnFail: "major" },
    ]},
    { code: "term-annual", name: "Annual termite agreement inspection", reportAudience: "customer", frequencyMonths: 12, checkpoints: [
      { key: "perimeter", label: "Accessible perimeter inspected for tubes, swarmers and damage", severityOnFail: "major" },
      { key: "stations", label: "Every bait station located, opened and recorded", assetCategory: "termite-station", requiresReading: true, severityOnFail: "major" },
      { key: "moisture", label: "Moisture readings at areas of concern", requiresReading: true, unit: "%", severityOnFail: "minor" },
      { key: "conducive", label: "Conducive conditions: wood to soil contact, grade, mulch and drainage", severityOnFail: "advisory" },
      { key: "graph", label: "Graph updated and any new inaccessible areas noted", severityOnFail: "minor" },
    ]},
  ],

  /**
   * What the software must PRODUCE, and for whom. Not what any business is
   * legally required to do: which records a given operator owes, in what
   * fields, on what clock, is set by their state and their own counsel, and
   * this pack deliberately ships none of those values.
   */
  submissions: [
    {
      kind: "pesticide.application_record",
      label: "Pesticide application record",
      authorityName: "State pesticide lead agency, held by the applicator and produced on request",
      cadence: "per_event",
      notes:
        "One record per application, assembled from the regulated readings on the visit: product and registration number, total amount, mix rate, target, method, area or linear feet treated, service address, date and times, and the name and licence held by the person who applied or supervised. Which of these fields a given state requires is configured by the operator. Records are immutable after a configurable window, with corrections written as superseding entries rather than edits.",
    },
    {
      kind: "pesticide.restricted_use_register",
      label: "Restricted use pesticide register",
      authorityName: "State pesticide lead agency",
      cadence: "on_threshold",
      notes:
        "A filterable register of applications where the product was flagged restricted use in the operator's product register, exportable for an inspection. The flag comes from the product record, never from the pack: no product, registration number or classification ships here.",
    },
    {
      kind: "pesticide.use_report",
      label: "Periodic pesticide use report",
      authorityName: "State pesticide lead agency or county agricultural authority",
      cadence: "monthly",
      route: "portal",
      notes:
        "Where a jurisdiction collects periodic use reporting, application records for the period are aggregated into an export. Cadence, scope and format differ by jurisdiction and are set by the operator. Only a generic CSV export exists today; per state formatters are not written.",
    },
    {
      kind: "pest.occupant_notification",
      label: "Occupant and customer treatment notification",
      authorityName: "Occupant, property manager or institution, per contract or local rule",
      cadence: "per_event",
      route: "email",
      notes:
        "Produces the notice and, more importantly, stores proof: what was sent, to whom, when, by what channel and whether delivery was confirmed. An intent to notify is not a notification record.",
    },
    {
      kind: "pest.wdi_report",
      label: "Wood destroying insect inspection report",
      authorityName: "Customer, lender or closing agent, and the state agency where one collects it",
      cadence: "per_event",
      notes:
        "Captures findings, inaccessible areas, measurements and the graph, and renders a report. State specific forms differ and no per state form renderer ships yet.",
    },
  ],

  retention: [
    // The clearest case in the whole schema for a clock that is not
    // record_created. The record ages from the application, not from the night
    // an office manager finally typed it up, and a purge job that got this
    // wrong would destroy records the shop still has to hold.
    { entityType: "application_record", entityKind: "pesticide", clockStart: "work_completed", retainMonths: 24, basis: "Runs from the date of the application. Operators in states with a longer period raise this; the pack ships the shortest defensible default and no state values." },
    { entityType: "notification", entityKind: "occupant", clockStart: "work_completed", retainMonths: 24, basis: "The notice and its proof of delivery are only meaningful next to the application they belong to, so they age on the same clock." },
    { entityType: "warranty", entityKind: "termite", clockStart: "contract_ended", retainMonths: 120, basis: "Termite bonds are claimed years after the treatment and often by a later owner of the house, so the clock starts when the agreement ends, not when the work was done." },
  ],

  kpis: [
    { key: "stops_per_day", label: "Stops per technician day", definition: "Completed service stops divided by technician days worked, taken from the timeclock rather than the roster. EXCLUDES sales and inspection only visits, and excludes cancelled stops, which otherwise reward a route that was never run.", format: "number", target: "14" },
    { key: "revenue_per_stop", label: "Revenue per stop", definition: "Invoiced revenue attributed to completed stops divided by those stops. Program revenue is recognised per service, not per billing month, or a quarterly customer billed monthly makes three empty stops look like three paid ones. EXCLUDES no charge warranty re services.", format: "money", target: "105" },
    { key: "route_density", label: "Route density", definition: "Completed stops divided by driving miles on the route, or its inverse read as miles between stops. The number that decides whether a market is profitable. EXCLUDES the first leg from the yard and the last leg home.", format: "number", target: "1.2" },
    { key: "renewal_rate", label: "Program renewal rate", definition: "Programs renewed divided by programs reaching the end of a term in the period. EXCLUDES customers who moved or sold the property, since those are not a service failure, but count them separately so the exclusion cannot be abused.", format: "percent", target: "82" },
    { key: "callback_rate", label: "Re service rate", definition: "Warranty re services linked to a parent service within thirty days divided by completed services. The honest measure of whether the treatment worked. EXCLUDES re services on accounts inside a scheduled clean out sequence, where a second visit is the plan.", format: "percent", target: "6" },
    { key: "chemical_cost_per_stop", label: "Chemical cost per stop", definition: "Cost of product applied, valued from the product register, divided by completed stops. EXCLUDES devices, bait stations and monitors, which are capital placed at a site rather than chemistry consumed on a visit.", format: "money", target: "9" },
    { key: "program_attach", label: "Program attach rate", definition: "Recurring programs sold divided by completed one off and initial services to customers not already on a program. The single biggest lever on the value of the book.", format: "percent", target: "40" },
    { key: "record_completeness", label: "Application record completeness", definition: "Completed visits where every regulated field required by the operator's configuration was captured, divided by completed visits. EXCLUDES visits recorded with a no product applied reason, which have their own required set.", format: "percent", target: "100" },
  ],

  portalBlocks: [
    { kind: "next_visit" },
    { kind: "service_report", title: "What we did and what we used" },
    { kind: "equipment_register", title: "Stations and devices at your property" },
    { kind: "readings_trend", title: "Activity over time", config: { keys: ["stations_serviced", "amount_applied", "area_treated_sqft"] } },
    { kind: "documents", title: "Product labels and safety data sheets" },
    { kind: "plan_status" },
    { kind: "invoices" },
  ],
};
