import type { TradePackInput } from "../src/schema";

/**
 * Electrical. Dispatch service work, with the parts of project work that a
 * small shop actually runs from the same system.
 *
 * The thing this pack has to get right is the panel. Almost everything an
 * electrician sells later hangs off what is in that enclosure: whether there
 * is space, whether the bus is a known problem brand, what the service is
 * rated at, what circuits are already loaded. So the panel is an asset with
 * circuits nested under it, the readings are the ones taken at the panel, and
 * the safety inspection is built around it.
 *
 * The readings are also the trade's paper trail. Torque values and insulation
 * resistance are what a shop points at when a connection is blamed a year
 * later, so they are captured as readings rather than as checklist ticks.
 *
 * Prices are national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const electrical: TradePackInput = {
  id: "electrical",
  name: "Electrical",
  version: 1,
  capacityModel: "technician_dispatch",
  summary:
    "Residential and light commercial electrical. Troubleshooting, device and lighting work, panel and service upgrades, EV charging and standby power, with a panel and circuit register that lives with the property.",
  status:
    "Price book, job types, checklists, readings and KPIs are complete. Project work is only partly covered: assemblies can be priced as line items but there is no takeoff, no schedule of values and no progress billing, so bid spec jobs still need a second system. Certified payroll is captured from the timeclock but the state specific report formats are not written. Utility interconnection for solar and battery is out of scope.",

  jobTypes: [
    { code: "diag", name: "Troubleshooting", capacityModel: "technician_dispatch", defaultDurationMinutes: 60, requiredSkills: ["electrical-service"], color: "#0B57D0" },
    { code: "repair", name: "Service repair", capacityModel: "technician_dispatch", defaultDurationMinutes: 120, requiredSkills: ["electrical-service"] },
    { code: "panel", name: "Panel or service upgrade", capacityModel: "technician_dispatch", defaultDurationMinutes: 480, requiredSkills: ["electrical-service", "panel-work"], color: "#6B3FA0" },
    { code: "ev", name: "EV charger installation", capacityModel: "technician_dispatch", defaultDurationMinutes: 240, requiredSkills: ["electrical-service"] },
    { code: "generator", name: "Standby power installation", capacityModel: "technician_dispatch", defaultDurationMinutes: 600, requiredSkills: ["electrical-install", "generator"] },
    // Rough in is sold by device count and run by a crew for days at a time,
    // so it does not belong on the dispatch board with the service calls.
    { code: "rough", name: "Rough in and finish", capacityModel: "crew_production", defaultDurationMinutes: 480, requiredSkills: ["electrical-install"], productionUnit: "device" },
    { code: "inspection", name: "Safety inspection", capacityModel: "technician_dispatch", defaultDurationMinutes: 120, requiredSkills: ["electrical-service"], color: "#0F7B6C" },
  ],

  priceBook: [
    { code: "DIAG-STD", name: "Troubleshooting, first hour", category: "Service", price: "149.00", cost: "0", laborMinutes: 60, taxClass: "service", description: "Systematic fault finding with a written report of what was tested and what was found. Applied to the repair if you go ahead today." },
    { code: "DIAG-ADD", name: "Troubleshooting, each additional half hour", category: "Service", price: "79.00", laborMinutes: 30, taxClass: "service" },
    { code: "DIAG-AH", name: "After hours troubleshooting", category: "Service", price: "249.00", laborMinutes: 60, taxClass: "service" },
    { code: "SAFETY-INSPECT", name: "Whole home electrical safety inspection", category: "Service", price: "249.00", cost: "0", laborMinutes: 120, taxClass: "service", description: "Panel, grounding, device and protection review with a written report, photographs and a prioritised list of what to address." },
    { code: "PLAN-RES", name: "Electrical service plan, annual", category: "Agreements", price: "179.00", cost: "84.00", taxClass: "service", description: "Annual safety inspection, panel thermal scan, priority scheduling, no after hours rate and fifteen percent off repairs." },

    { code: "RECEP-STD", name: "Receptacle replacement", category: "Devices", price: "169.00", cost: "4.00", laborMinutes: 30, taxClass: "material", warrantyMonths: 12 },
    { code: "RECEP-GFCI", name: "GFCI receptacle replacement", category: "Devices", price: "249.00", cost: "22.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "RECEP-NEW", name: "New receptacle on an existing circuit, accessible wall", category: "Devices", price: "389.00", cost: "28.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },
    { code: "RECEP-240", name: "240 volt appliance receptacle", category: "Devices", price: "689.00", cost: "62.00", laborMinutes: 150, taxClass: "material", warrantyMonths: 12 },
    { code: "SW-STD", name: "Switch replacement", category: "Devices", price: "159.00", cost: "4.00", laborMinutes: 30, taxClass: "material", warrantyMonths: 12 },
    { code: "SW-DIMMER", name: "Dimmer switch installed", category: "Devices", price: "219.00", cost: "26.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "SW-SMART", name: "Smart switch installed and joined to the network", category: "Devices", price: "289.00", cost: "48.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "SMOKE-CO", name: "Hardwired smoke and carbon monoxide alarm, each", category: "Devices", price: "229.00", cost: "46.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },

    { code: "FIX-SWAP", name: "Light fixture swap, standard ceiling height", category: "Lighting", price: "189.00", laborMinutes: 45, taxClass: "service", warrantyMonths: 12 },
    { code: "FIX-HIGH", name: "Light fixture swap, high ceiling with a lift", category: "Lighting", price: "389.00", laborMinutes: 90, taxClass: "service", warrantyMonths: 12 },
    { code: "CAN-LED", name: "Recessed LED downlight, per light", category: "Lighting", price: "269.00", cost: "42.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "FAN-EXIST", name: "Ceiling fan installed on an existing rated box", category: "Lighting", price: "349.00", laborMinutes: 90, taxClass: "service", warrantyMonths: 12 },
    { code: "FAN-BRACE", name: "Ceiling fan with a new brace box", category: "Lighting", price: "549.00", cost: "52.00", laborMinutes: 150, taxClass: "material", warrantyMonths: 12 },
    { code: "FLOOD-EXT", name: "Exterior flood light installed", category: "Lighting", price: "389.00", cost: "68.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },

    { code: "BRKR-STD", name: "Circuit breaker replacement", category: "Panel", price: "289.00", cost: "32.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "BRKR-AFCI", name: "AFCI breaker replacement", category: "Panel", price: "349.00", cost: "58.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "BRKR-GFCI", name: "GFCI breaker replacement", category: "Panel", price: "369.00", cost: "68.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "PANEL-IR", name: "Panel thermal scan", category: "Panel", price: "189.00", laborMinutes: 45, taxClass: "service", description: "Infrared scan of the panel under load to find a hot connection before it becomes a failure, with the images saved to your record." },
    { code: "PANEL-100", name: "100 amp panel replacement", kind: "equipment", category: "Panel", price: "2290.00", cost: "780.00", laborMinutes: 420, taxClass: "equipment", warrantyMonths: 120 },
    { code: "PANEL-200", name: "200 amp panel replacement", kind: "equipment", category: "Panel", price: "2890.00", cost: "980.00", laborMinutes: 480, taxClass: "equipment", warrantyMonths: 120, description: "New panel and breakers, every circuit labelled, connections torqued to the manufacturer values and recorded, grounding and bonding brought up with the work, permit and inspection included." },
    { code: "SERVICE-200", name: "200 amp service upgrade with mast and meter base", kind: "equipment", category: "Panel", price: "4490.00", cost: "1680.00", laborMinutes: 600, taxClass: "equipment", warrantyMonths: 120 },
    { code: "SUBPANEL-100", name: "100 amp subpanel installed", kind: "equipment", category: "Panel", price: "1890.00", cost: "520.00", laborMinutes: 300, taxClass: "equipment", warrantyMonths: 120 },
    { code: "SPD-WHOLE", name: "Whole home surge protection device", category: "Panel", price: "649.00", cost: "178.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 60 },
    { code: "GROUND-CORR", name: "Grounding and bonding correction", category: "Panel", price: "489.00", cost: "64.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },

    { code: "CIRC-20", name: "Dedicated 20 amp circuit, accessible run", category: "Circuits", price: "689.00", cost: "78.00", laborMinutes: 180, taxClass: "material", warrantyMonths: 12 },
    { code: "CIRC-50", name: "50 amp circuit for a range or charger, accessible run", category: "Circuits", price: "989.00", cost: "148.00", laborMinutes: 240, taxClass: "material", warrantyMonths: 12 },
    { code: "WIRE-12-2", name: "12-2 NM-B cable, per foot", kind: "material", category: "Materials", price: "1.90", cost: "0.68", taxClass: "material" },
    { code: "CONDUIT-EMT", name: "Half inch EMT conduit installed, per foot", kind: "material", category: "Materials", price: "14.00", cost: "3.10", taxClass: "material" },

    { code: "EV-L2", name: "Level 2 EV charger installed, run under twenty five feet", kind: "equipment", category: "EV and backup power", price: "1690.00", cost: "620.00", laborMinutes: 240, taxClass: "equipment", warrantyMonths: 12, description: "Dedicated circuit, charger mounted and commissioned, load evaluated against the existing service, permit and inspection included." },
    { code: "EV-L2-LONG", name: "Level 2 EV charger installed, long or concealed run", kind: "equipment", category: "EV and backup power", price: "2490.00", cost: "980.00", laborMinutes: 360, taxClass: "equipment", warrantyMonths: 12 },
    { code: "GEN-INTERLOCK", name: "Generator interlock kit with an inlet", category: "EV and backup power", price: "1290.00", cost: "340.00", laborMinutes: 240, taxClass: "material", warrantyMonths: 12 },
    { code: "GEN-STANDBY-22", name: "22 kW standby generator installed", kind: "equipment", category: "EV and backup power", price: "12900.00", cost: "7200.00", laborMinutes: 900, taxClass: "equipment", warrantyMonths: 60 },
    { code: "ATS-200", name: "Automatic transfer switch installed", kind: "equipment", category: "EV and backup power", price: "2190.00", cost: "890.00", laborMinutes: 300, taxClass: "equipment", warrantyMonths: 60 },

    { code: "TRIP-ZONE2", name: "Extended travel fee", kind: "fee", category: "Fees", price: "49.00", taxClass: "service" },
    { code: "PERMIT", name: "Permit, passed through at cost", kind: "fee", category: "Fees", price: "0", taxClass: "exempt", description: "Billed at the amount charged by the jurisdiction." },
  ],

  equipmentCategories: [
    { code: "service-panel", name: "Service panel", attributes: [
      { key: "service_amps", label: "Service rating, amps", kind: "select", options: ["60", "100", "125", "150", "200", "320", "400"] },
      { key: "manufacturer", label: "Manufacturer", kind: "text" },
      { key: "spaces_total", label: "Total spaces", kind: "numeric" },
      { key: "spaces_open", label: "Open spaces", kind: "numeric" },
      { key: "known_concern", label: "Flagged as a known problem panel", kind: "boolean" },
    ]},
    { code: "main-breaker", name: "Main breaker or disconnect", parentCode: "service-panel" },
    // Circuits nest under the panel because the register is what makes a
    // second visit cheap: the next technician already knows what is on which
    // breaker instead of rediscovering it with a plug in tester.
    { code: "branch-circuit", name: "Branch circuit", parentCode: "service-panel", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "breaker_amps", label: "Breaker rating, amps", kind: "numeric" },
      { key: "conductor", label: "Conductor", kind: "select", options: ["Copper", "Aluminium", "Copper clad aluminium", "Unknown"] },
      { key: "protection", label: "Protection", kind: "select", options: ["Standard", "GFCI", "AFCI", "Dual function"] },
      { key: "serves", label: "Serves", kind: "text" },
    ]},
    { code: "subpanel", name: "Subpanel", parentCode: "service-panel" },
    { code: "ev-charger", name: "EV charging equipment", attributes: [
      { key: "amps", label: "Circuit rating, amps", kind: "numeric" },
      { key: "connection", label: "Connection", kind: "select", options: ["Hardwired", "Plug in"] },
      { key: "load_managed", label: "Load management fitted", kind: "boolean" },
    ]},
    { code: "generator", name: "Standby generator", attributes: [
      { key: "kw", label: "Rating, kW", kind: "numeric" },
      { key: "fuel", label: "Fuel", kind: "select", options: ["Natural gas", "Propane", "Diesel"] },
      { key: "last_exercise", label: "Last exercise run", kind: "date" },
    ]},
    { code: "transfer-switch", name: "Transfer switch", parentCode: "generator" },
    { code: "surge-device", name: "Surge protective device", parentCode: "service-panel" },
  ],

  readings: [
    { key: "volts_l1_n", label: "Voltage, line one to neutral", kind: "numeric", unit: "V", trend: true, min: 110, max: 126 },
    { key: "volts_l2_n", label: "Voltage, line two to neutral", kind: "numeric", unit: "V", trend: true, min: 110, max: 126 },
    { key: "volts_l1_l2", label: "Voltage, line to line", kind: "numeric", unit: "V", trend: true, min: 220, max: 252 },
    // Voltage at rest tells you almost nothing about a flickering light. The
    // reading that matters is how far it falls with the circuit loaded.
    { key: "volt_drop_load", label: "Voltage drop under load", kind: "numeric", unit: "V", trend: true, customerVisible: false },
    { key: "amps_l1", label: "Amperage, line one", kind: "numeric", unit: "A", trend: true, customerVisible: false },
    { key: "amps_l2", label: "Amperage, line two", kind: "numeric", unit: "A", trend: true, customerVisible: false },
    { key: "amps_neutral", label: "Neutral current", kind: "numeric", unit: "A", trend: true, customerVisible: false },
    { key: "circuit_load", label: "Measured load on the circuit worked", kind: "numeric", unit: "A", trend: true, customerVisible: false },
    { key: "insulation_res", label: "Insulation resistance", kind: "measurement", unit: "Mohm", trend: true, customerVisible: false },
    { key: "ground_res", label: "Grounding electrode resistance", kind: "measurement", unit: "ohm", trend: true, customerVisible: false },
    // Torque is recorded per connection, in the unit printed on the label,
    // because the manufacturer value is the only one that means anything.
    { key: "torque_lugs", label: "Torque applied at the service lugs", kind: "measurement", unit: "in-lb", trend: true, customerVisible: false },
    { key: "torque_breakers", label: "Torque applied at the breaker terminals", kind: "measurement", unit: "in-lb", trend: true, customerVisible: false },
    { key: "panel_temp_max", label: "Hottest connection on the thermal scan", kind: "numeric", unit: "F", trend: true },
    { key: "panel_temp_rise", label: "Rise above ambient at the hottest connection", kind: "numeric", unit: "F", trend: true },
    { key: "gfci_trip_ms", label: "GFCI trip time", kind: "measurement", unit: "ms", trend: true },
    { key: "receptacle_wiring", label: "Receptacle wiring condition", kind: "select", options: ["Correct", "Open ground", "Open neutral", "Reversed polarity", "Hot and ground reversed", "No power"] },
  ],

  checklists: [
    { code: "service-call", name: "Service call safety and findings", jobTypeCodes: ["diag", "repair"], items: [
      { label: "Test the meter on a known live source, prove the circuit dead, then test the meter again", required: true, safety: true },
      { label: "Lock out and tag the breaker before opening anything", required: true, safety: true },
      { label: "Confirm there is no backfeed from a generator, inverter or second supply", required: true, safety: true },
      { label: "Wear the rated PPE for working at the panel", required: true, safety: true },
      { label: "Photograph the panel label and record the service rating and open spaces", required: true },
      { label: "Record the measured voltage and the load on the circuit worked", required: true },
      { label: "Record what was tested and what was ruled out, not only the fault found", required: true },
      { label: "Update the circuit register for anything relabelled" },
      { label: "Test the repaired circuit under load before leaving", required: true },
      { label: "Review findings with the customer and record declined work", required: true },
    ]},
    { code: "panel-replace", name: "Panel or service upgrade", jobTypeCodes: ["panel"], items: [
      { label: "Confirm the permit is pulled and the utility disconnect is arranged", required: true },
      { label: "Confirm the service is de-energised at the meter and prove it dead at the panel", required: true, safety: true },
      { label: "Lock out and tag the supply for the duration of the work", required: true, safety: true },
      { label: "Photograph the old panel, the existing labelling and every circuit before removal", required: true },
      { label: "Record the old panel manufacturer and note any known concern", required: true },
      { label: "Fit the new panel and land every circuit, labelled as it is landed", required: true },
      { label: "Torque the lugs and breaker terminals to the manufacturer values and record them", required: true, safety: true },
      { label: "Verify grounding and bonding and record the electrode resistance", required: true },
      { label: "Energise and record voltage on both legs and neutral current", required: true },
      { label: "Test every GFCI and AFCI device and record the results", required: true },
      { label: "Thermal scan the panel under load before closing it up", required: true },
      { label: "Photograph the finished panel and the completed directory", required: true },
      { label: "Book the inspection and record the result when it is signed off", required: true },
    ]},
    { code: "ev-commission", name: "EV charger commissioning", jobTypeCodes: ["ev"], items: [
      { label: "Prove the circuit dead before terminating at the panel", required: true, safety: true },
      { label: "Record the existing service rating and the load evaluation used", required: true },
      { label: "Record the circuit rating, conductor size and run length", required: true },
      { label: "Torque the charger and breaker terminations and record the values", required: true, safety: true },
      { label: "Record the charger make, model and serial", required: true },
      { label: "Charge a vehicle or run the unit self test and record the result", required: true },
      { label: "Record voltage drop at full charge current", required: true },
      { label: "Register the manufacturer warranty and set up the customer app" },
      { label: "Book the inspection and record the result when it is signed off", required: true },
    ]},
  ],

  inspectionPrograms: [
    { code: "panel-safety", name: "Periodic panel and electrical safety inspection", standard: "Shop standard visual and test inspection of the service, panel and protective devices", reportAudience: "customer", frequencyMonths: 12, checkpoints: [
      { key: "panel_id", label: "Panel manufacturer, rating and spaces recorded", assetCategory: "service-panel", severityOnFail: "minor" },
      { key: "panel_condition", label: "Enclosure, dead front and cover intact with no openings", assetCategory: "service-panel", severityOnFail: "major" },
      { key: "thermal", label: "No abnormal heat at any connection on the thermal scan", assetCategory: "service-panel", requiresReading: true, unit: "F", severityOnFail: "critical" },
      { key: "torque_check", label: "Accessible terminations checked and torque recorded", assetCategory: "service-panel", requiresReading: true, unit: "in-lb", severityOnFail: "major" },
      { key: "grounding", label: "Grounding and bonding present and continuous", requiresReading: true, unit: "ohm", severityOnFail: "critical" },
      { key: "voltage", label: "Voltage on both legs within range", requiresReading: true, unit: "V", severityOnFail: "major" },
      { key: "neutral_load", label: "Neutral current consistent with the load", requiresReading: true, unit: "A", severityOnFail: "minor" },
      { key: "gfci", label: "Every GFCI device trips and the time is recorded", requiresReading: true, unit: "ms", severityOnFail: "critical" },
      { key: "afci", label: "Every AFCI device tests and resets", severityOnFail: "major" },
      { key: "directory", label: "Circuit directory complete and accurate", assetCategory: "branch-circuit", severityOnFail: "minor" },
      { key: "alarms", label: "Smoke and carbon monoxide alarms present and functional", severityOnFail: "critical" },
      { key: "spd", label: "Surge protective device present and indicating", assetCategory: "surge-device", failIsDeficiency: false, severityOnFail: "advisory" },
    ]},
    { code: "generator-service", name: "Standby generator annual service", reportAudience: "customer", frequencyMonths: 12, checkpoints: [
      { key: "exercise", label: "Exercise run completed under load", assetCategory: "generator", severityOnFail: "major" },
      { key: "transfer", label: "Transfer switch changes over and returns", assetCategory: "transfer-switch", severityOnFail: "critical" },
      { key: "output_v", label: "Output voltage within range", assetCategory: "generator", requiresReading: true, unit: "V", severityOnFail: "major" },
      { key: "battery", label: "Starting battery holds charge", assetCategory: "generator", severityOnFail: "major" },
      { key: "enclosure", label: "Enclosure, exhaust and clearances clear", assetCategory: "generator", severityOnFail: "minor" },
    ]},
  ],

  submissions: [
    {
      kind: "ahj.permit_inspection_request",
      label: "Permit and inspection request to the authority having jurisdiction",
      authorityName: "Local authority having jurisdiction",
      cadence: "per_event",
      route: "portal",
      notes:
        "The software assembles the request from the job record: scope, service rating, panel and circuit details, and the licence held by the shop. Every jurisdiction takes a different form by a different route, so the packet is produced and retained and the filing is still done by hand.",
    },
    {
      kind: "public_works.certified_payroll",
      label: "Certified payroll report for public work",
      authorityName: "Contracting agency for the public job",
      cadence: "per_event",
      route: "portal",
      notes:
        "Produced per payroll period for jobs flagged as public work. Hours come from the timeclock entries on those jobs, with the classification recorded against each technician. The report is rendered for review; the state specific formats are not written yet.",
    },
  ],

  retention: [
    { entityType: "inspection", entityKind: "panel-safety", clockStart: "report_prepared", retainMonths: 60, basis: "Inspection reports and the readings behind them" },
    // Panel work is the record a shop is asked for years later, so the clock
    // runs from completion and the term outlasts the typical workmanship claim.
    { entityType: "service_report", entityKind: "panel", clockStart: "work_completed", retainMonths: 120, basis: "Torque, grounding and commissioning records for panel and service work" },
    { entityType: "timesheet", entityKind: "certified-payroll", clockStart: "contract_ended", retainMonths: 60, basis: "Hours and classifications supporting a public works payroll report" },
  ],

  kpis: [
    { key: "avg_ticket", label: "Average ticket", definition: "Invoiced revenue divided by completed jobs. Excludes warranty returns and zero revenue plan visits, which otherwise drag the number down and make a good month look bad.", format: "money", target: "620" },
    { key: "close_rate", label: "Close rate", definition: "Approved estimates divided by presented estimates, by technician. Counts an estimate as presented only once per job, so a three option proposal is one presentation and not three.", format: "percent", target: "45" },
    { key: "diag_conversion", label: "Troubleshooting conversion", definition: "Troubleshooting calls that produced approved repair work on the same visit, divided by all troubleshooting calls. Excludes calls where the fault was found in equipment another trade owns, which the electrician was never going to close.", format: "percent", target: "70" },
    { key: "panel_pipeline", label: "Panel upgrade pipeline", definition: "Total value of declined panel and service upgrade recommendations on panels recorded as full, flagged as a known concern, or rated below 100 amps, counting only properties still on the customer list.", format: "money" },
    { key: "callback_rate", label: "Callback rate", definition: "Warranty jobs linked to a parent job within thirty days, divided by completed jobs. Excludes jobs the customer booked again for different work at the same address, which are not callbacks.", format: "percent", target: "2" },
    { key: "inspection_pass", label: "First time inspection pass rate", definition: "Permitted jobs signed off on the first inspection divided by all permitted jobs inspected, EXCLUDING jobs failed for something outside the electrical scope. Counting those hides whether the crews are the problem.", format: "percent", target: "95" },
    { key: "revenue_per_tech", label: "Revenue per technician per day", definition: "Invoiced revenue divided by technician days worked, from the timeclock rather than from the roster, so holiday and training days do not count as capacity.", format: "money", target: "1600" },
    { key: "first_time_fix", label: "First time fix rate", definition: "Jobs completed in one visit divided by all completed jobs, EXCLUDING jobs planned as multi visit and jobs held for a part order or an inspection. Including planned return visits makes this meaningless.", format: "percent", target: "85" },
  ],

  portalBlocks: [
    { kind: "next_visit" },
    { kind: "equipment_register", title: "Your panel and circuits" },
    { kind: "checklist_results", title: "Safety inspection results" },
    { kind: "readings_trend", title: "Panel readings over time", config: { keys: ["volts_l1_n", "volts_l2_n", "panel_temp_max"] } },
    { kind: "photo_gallery", title: "Photos and thermal images" },
    { kind: "recommended_work", title: "What we found" },
    { kind: "invoices" },
  ],
};
