import type { TradePackInput } from "../src/schema";

/**
 * Plumbing. Dispatch trade, flat rate book, and the deepest asset history of
 * the three service trades: a water heater outlives two owners and the next
 * technician needs to know what the last one found.
 *
 * Two things shape this pack more than anything else. First, drains: a drain
 * call is a low ticket that either ends at the cleanout or becomes a camera,
 * a locate and a sewer job, so the price book and the readings have to carry
 * that path. Second, backflow: an assembly test is a report to a water
 * authority rather than to the customer, which is why it is an inspection
 * programme and a submission rather than just another job type.
 *
 * Prices are national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const plumbing: TradePackInput = {
  id: "plumbing",
  name: "Plumbing",
  version: 1,
  summary:
    "Residential and light commercial plumbing. Service, drains and sewer, water heaters, water treatment and backflow testing, with fixture and appliance history that follows the property.",
  status:
    "Price book, job types, checklists, readings and KPIs are complete. Backflow test reports are captured and rendered for the customer, but the per authority submission formats are not written yet, so a test still gets filed by hand. Sewer lining and repipe are priced as line items only: there is no takeoff or per segment estimating. Medical gas work is out of scope.",

  jobTypes: [
    { code: "diag", name: "Diagnostic", capacityModel: "technician_dispatch", defaultDurationMinutes: 60, requiredSkills: ["plumbing-service"], color: "#0B57D0" },
    { code: "repair", name: "Service repair", capacityModel: "technician_dispatch", defaultDurationMinutes: 120, requiredSkills: ["plumbing-service"] },
    { code: "drain", name: "Drain and sewer", capacityModel: "technician_dispatch", defaultDurationMinutes: 90, requiredSkills: ["drain-tech"], color: "#6B3FA0" },
    { code: "wh", name: "Water heater replacement", capacityModel: "technician_dispatch", defaultDurationMinutes: 240, requiredSkills: ["plumbing-service"] },
    { code: "backflow", name: "Backflow assembly test", capacityModel: "technician_dispatch", defaultDurationMinutes: 45, requiredSkills: ["backflow-tester"], color: "#0F7B6C" },
    // Repipe is the one plumbing job sold by the fixture rather than by the
    // hour, and it ties up a crew for days. Scheduling it against dispatch
    // capacity buries the board for a week.
    { code: "repipe", name: "Repipe", capacityModel: "crew_production", defaultDurationMinutes: 480, requiredSkills: ["plumbing-install"], productionUnit: "fixture" },
    { code: "emergency", name: "Leak or no water", capacityModel: "technician_dispatch", defaultDurationMinutes: 90, requiredSkills: ["plumbing-service"], color: "#C4261D" },
  ],

  priceBook: [
    { code: "DIAG-STD", name: "Diagnostic fee", category: "Service", price: "99.00", cost: "0", laborMinutes: 60, taxClass: "service", description: "Full diagnosis with a written findings report and photos. Applied to the repair if you go ahead today." },
    { code: "DIAG-AH", name: "After hours diagnostic", category: "Service", price: "199.00", laborMinutes: 60, taxClass: "service" },
    { code: "LEAK-DETECT", name: "Electronic leak detection", category: "Service", price: "389.00", laborMinutes: 120, taxClass: "service", description: "Acoustic and thermal location of a concealed leak, with the suspected point marked and photographed before any opening is made." },
    { code: "PLAN-RES", name: "Home plumbing plan, annual", category: "Agreements", price: "189.00", cost: "92.00", taxClass: "service", description: "Annual whole home inspection, water heater flush, priority scheduling, no after hours rate and fifteen percent off repairs." },

    { code: "DRAIN-CLEANOUT", name: "Drain clearing through an accessible cleanout", category: "Drains", price: "289.00", cost: "22.00", laborMinutes: 90, taxClass: "service", warrantyMonths: 1 },
    { code: "DRAIN-PULL", name: "Drain clearing, toilet pulled and reset", category: "Drains", price: "449.00", cost: "48.00", laborMinutes: 150, taxClass: "service", warrantyMonths: 1 },
    { code: "DRAIN-MAIN", name: "Main line clearing", category: "Drains", price: "489.00", cost: "36.00", laborMinutes: 150, taxClass: "service", warrantyMonths: 1 },
    { code: "HYDRO-JET", name: "Hydro jetting, main line", category: "Drains", price: "949.00", cost: "180.00", laborMinutes: 240, taxClass: "service", description: "High pressure cleaning of the full line, with a camera pass before and after so you can see what came out." },
    { code: "CAMERA-INSPECT", name: "Sewer camera inspection with recording", category: "Drains", price: "329.00", cost: "18.00", laborMinutes: 90, taxClass: "service" },

    { code: "WH-40-GAS", name: "40 gallon gas water heater, installed", kind: "equipment", category: "Water heaters", price: "2190.00", cost: "890.00", laborMinutes: 240, taxClass: "equipment", warrantyMonths: 72, description: "New heater, new flex connectors, new shutoff, expansion tank where the system needs one, haul away of the old unit, permit where the jurisdiction requires one." },
    { code: "WH-50-GAS", name: "50 gallon gas water heater, installed", kind: "equipment", category: "Water heaters", price: "2490.00", cost: "1020.00", laborMinutes: 240, taxClass: "equipment", warrantyMonths: 72 },
    { code: "WH-50-ELEC", name: "50 gallon electric water heater, installed", kind: "equipment", category: "Water heaters", price: "2090.00", cost: "810.00", laborMinutes: 210, taxClass: "equipment", warrantyMonths: 72 },
    { code: "WH-TANKLESS", name: "Tankless gas water heater, installed", kind: "equipment", category: "Water heaters", price: "5290.00", cost: "2380.00", laborMinutes: 480, taxClass: "equipment", warrantyMonths: 120 },
    { code: "WH-TP-VALVE", name: "Temperature and pressure relief valve replacement", category: "Water heaters", price: "289.00", cost: "24.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "WH-EXP-TANK", name: "Thermal expansion tank, installed", category: "Water heaters", price: "349.00", cost: "62.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "WH-ANODE", name: "Anode rod replacement", category: "Water heaters", price: "329.00", cost: "48.00", laborMinutes: 90, taxClass: "material" },
    { code: "WH-FLUSH", name: "Water heater flush and inspection", category: "Water heaters", price: "189.00", cost: "18.00", laborMinutes: 60, taxClass: "service" },
    { code: "WH-ELEMENT", name: "Electric element and thermostat replacement", category: "Water heaters", price: "329.00", cost: "36.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },
    { code: "WH-GAS-VALVE", name: "Gas control valve replacement", category: "Water heaters", price: "689.00", cost: "240.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },

    { code: "TOILET-REBUILD", name: "Toilet rebuild, tank internals", category: "Fixtures", price: "289.00", cost: "38.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "TOILET-RESET", name: "Toilet pull and reset with new wax and bolts", category: "Fixtures", price: "349.00", cost: "24.00", laborMinutes: 90, taxClass: "service", warrantyMonths: 12 },
    { code: "TOILET-INSTALL", name: "Toilet supplied and installed", category: "Fixtures", price: "749.00", cost: "268.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },
    { code: "FAUCET-LAV", name: "Lavatory faucet supplied and installed", category: "Fixtures", price: "329.00", cost: "88.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },
    { code: "ANGLE-STOP", name: "Angle stop replacement", category: "Fixtures", price: "189.00", cost: "12.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "SHOWER-CART", name: "Shower valve cartridge replacement", category: "Fixtures", price: "349.00", cost: "42.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },
    { code: "GARB-DISP", name: "Garbage disposal supplied and installed", category: "Fixtures", price: "549.00", cost: "168.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 24 },

    { code: "PRV-REPL", name: "Pressure reducing valve replacement", category: "Water supply", price: "689.00", cost: "148.00", laborMinutes: 150, taxClass: "material", warrantyMonths: 12, description: "Replaces the valve that holds house pressure at a safe level. High incoming pressure is the most common cause of repeat fixture leaks." },
    { code: "SHUTOFF-MAIN", name: "Main shutoff valve replacement", category: "Water supply", price: "789.00", cost: "118.00", laborMinutes: 180, taxClass: "material", warrantyMonths: 12 },
    { code: "PIPE-REPAIR", name: "Supply pipe repair, accessible", category: "Water supply", price: "489.00", cost: "34.00", laborMinutes: 120, taxClass: "service", warrantyMonths: 12 },
    { code: "SOFTENER", name: "Water softener, installed", kind: "equipment", category: "Water treatment", price: "2890.00", cost: "1180.00", laborMinutes: 300, taxClass: "equipment", warrantyMonths: 60 },
    { code: "FILTER-WHOLE", name: "Whole home water filter, installed", kind: "equipment", category: "Water treatment", price: "1290.00", cost: "420.00", laborMinutes: 180, taxClass: "equipment", warrantyMonths: 24 },

    { code: "GAS-TEST", name: "Gas line pressure test", category: "Gas", price: "289.00", laborMinutes: 90, taxClass: "service" },
    { code: "GAS-LINE-FT", name: "Gas line run, per foot", kind: "material", category: "Gas", price: "38.00", cost: "9.00", taxClass: "material" },

    { code: "SEWER-SPOT", name: "Sewer spot repair, excavated", category: "Sewer", price: "3890.00", cost: "1240.00", laborMinutes: 600, taxClass: "service", warrantyMonths: 24 },
    { code: "SEWER-LINER-FT", name: "Sewer line lining, per foot", category: "Sewer", price: "168.00", cost: "62.00", taxClass: "service", warrantyMonths: 120 },
    { code: "REPIPE-FIXTURE", name: "Whole home repipe in PEX, per fixture", category: "Repipe", price: "890.00", cost: "310.00", taxClass: "service", warrantyMonths: 120, description: "Priced by fixture count because that is what drives the labour, not by square footage." },

    { code: "BF-TEST", name: "Backflow prevention assembly test", category: "Backflow", price: "149.00", cost: "28.00", laborMinutes: 45, taxClass: "service", description: "Test of the assembly with a calibrated gauge, and the completed report prepared for the water authority that holds the record." },
    { code: "BF-REBUILD", name: "Backflow prevention assembly rebuild", category: "Backflow", price: "489.00", cost: "96.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },

    { code: "TRIP-ZONE2", name: "Extended travel fee", kind: "fee", category: "Fees", price: "49.00", taxClass: "service" },
    { code: "PERMIT", name: "Permit, passed through at cost", kind: "fee", category: "Fees", price: "0", taxClass: "exempt", description: "Billed at the amount charged by the jurisdiction." },
  ],

  equipmentCategories: [
    { code: "water-heater", name: "Water heater", attributes: [
      { key: "fuel", label: "Fuel", kind: "select", options: ["Natural gas", "Propane", "Electric", "Heat pump"] },
      { key: "capacity_gal", label: "Capacity, gallons", kind: "numeric" },
      { key: "vent_type", label: "Vent type", kind: "select", options: ["Atmospheric", "Power vent", "Direct vent", "Not applicable"] },
      { key: "install_date", label: "Install date", kind: "date" },
    ]},
    // The parts that fail on their own schedule and get replaced without the
    // heater being touched. Nesting them keeps the replacement history on the
    // heater rather than scattered across old invoices.
    { code: "tp-valve", name: "Temperature and pressure relief valve", parentCode: "water-heater", tracksSerial: false },
    { code: "expansion-tank", name: "Thermal expansion tank", parentCode: "water-heater", tracksSerial: false },
    { code: "water-softener", name: "Water softener", attributes: [
      { key: "grain_capacity", label: "Grain capacity", kind: "numeric" },
      { key: "salt_type", label: "Salt type", kind: "select", options: ["Pellet", "Crystal", "Block", "Potassium"] },
    ]},
    { code: "backflow-assembly", name: "Backflow prevention assembly", attributes: [
      { key: "assembly_type", label: "Assembly type", kind: "select", options: ["Reduced pressure", "Double check", "Pressure vacuum breaker", "Spill resistant vacuum breaker"] },
      { key: "size", label: "Size", kind: "text" },
      { key: "hazard", label: "Protects against", kind: "select", options: ["Irrigation", "Fire line", "Boiler", "Process water", "Other"] },
    ]},
    { code: "prv", name: "Pressure reducing valve", tracksSerial: false },
    { code: "sump-pump", name: "Sump or sewage ejector pump", attributes: [
      { key: "hp", label: "Horsepower", kind: "text" },
      { key: "has_battery_backup", label: "Battery backup fitted", kind: "boolean" },
    ]},
    { code: "sewer-lateral", name: "Sewer lateral", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "material", label: "Material", kind: "select", options: ["Cast iron", "Clay", "Orangeburg", "ABS", "PVC", "Lined", "Unknown"] },
      { key: "length_ft", label: "Length to main, feet", kind: "numeric" },
    ]},
  ],

  readings: [
    { key: "static_pressure", label: "Static water pressure", kind: "numeric", unit: "psi", trend: true, min: 40, max: 80 },
    // Static alone hides a supply restriction. The drop between static and
    // flowing is the reading that actually explains a low flow complaint.
    { key: "flowing_pressure", label: "Flowing water pressure", kind: "numeric", unit: "psi", trend: true },
    { key: "pressure_drop", label: "Pressure drop under flow", kind: "numeric", unit: "psi", trend: true },
    { key: "flow_rate", label: "Measured flow rate", kind: "measurement", unit: "gpm", trend: true },
    { key: "water_hardness", label: "Water hardness", kind: "chemical", unit: "gpg", trend: true, min: 0, max: 7 },
    { key: "water_tds", label: "Total dissolved solids", kind: "chemical", unit: "ppm", trend: true },
    { key: "hot_water_temp", label: "Hot water temperature at the fixture", kind: "numeric", unit: "F", trend: true, min: 110, max: 140 },
    { key: "wh_setpoint", label: "Water heater setpoint", kind: "numeric", unit: "F", trend: true },
    { key: "expansion_precharge", label: "Expansion tank precharge", kind: "numeric", unit: "psi", trend: true },
    // Gas readings carry no range here on purpose. The acceptable figure
    // depends on the fuel and the appliance, and a wrong default number on a
    // gas appliance is the worst kind of wrong.
    { key: "gas_static_wc", label: "Gas pressure, static", kind: "numeric", unit: "in wc", trend: true, customerVisible: false },
    { key: "gas_manifold_wc", label: "Gas pressure, manifold under load", kind: "numeric", unit: "in wc", trend: true, customerVisible: false },
    { key: "meter_creep", label: "Water meter moves with all fixtures off", kind: "boolean", customerVisible: true },
    { key: "camera_findings", label: "Drain camera findings", kind: "select", options: ["Clear", "Grease", "Roots", "Scale or buildup", "Belly", "Offset joint", "Crack or break", "Collapse"], customerVisible: true },
    { key: "camera_distance", label: "Distance to defect from access point", kind: "measurement", unit: "ft", trend: true },
    { key: "bf_differential", label: "Backflow relief valve differential", kind: "measurement", unit: "psid", trend: true, regulated: true, customerVisible: false },
    { key: "wh_anode_condition", label: "Anode rod condition", kind: "select", options: ["Good", "Half consumed", "Depleted", "Not accessible"] },
  ],

  checklists: [
    { code: "wh-replace", name: "Water heater replacement", jobTypeCodes: ["wh"], items: [
      { label: "Shut off the gas at the appliance valve, or the breaker on an electric unit, and confirm it is off", required: true, safety: true },
      { label: "Shut off and verify the cold water supply is isolated", required: true, safety: true },
      { label: "Test for a gas leak at the connection before and after the work", required: true, safety: true },
      { label: "Photograph the old data plate and record the serial before removal", required: true },
      { label: "Record incoming static water pressure", required: true },
      { label: "Confirm whether the system is closed and an expansion tank is needed", required: true },
      { label: "Fit new flex connectors and a new shutoff valve" },
      { label: "Confirm the relief valve discharge line runs to an approved termination", required: true, safety: true },
      { label: "Verify draft on an atmospherically vented unit", required: true, safety: true },
      { label: "Set and record the temperature setpoint", required: true },
      { label: "Record the new serial and register the manufacturer warranty", required: true },
      { label: "Photograph the finished install and haul away the old unit" },
    ]},
    { code: "drain-call", name: "Drain and sewer call", jobTypeCodes: ["drain"], items: [
      { label: "Confirm no live electrical or standing sewage hazard at the work area before setting up", required: true, safety: true },
      { label: "Protect floors and set containment before opening any line", required: true },
      { label: "Locate and photograph the access point used" },
      { label: "Record which fixtures were affected and which ran clear after" },
      { label: "Run the line to the full length of the cable and record the footage" },
      { label: "Camera the line and record findings and distance to any defect", required: true },
      { label: "Save the camera recording to the job" },
      { label: "Record the line material and the estimated length to the main" },
      { label: "Review findings with the customer and record declined work", required: true },
    ]},
    { code: "home-inspect", name: "Whole home plumbing inspection", jobTypeCodes: ["diag", "repair"], items: [
      { label: "Record static and flowing water pressure", required: true },
      { label: "Check and record the pressure reducing valve condition" },
      { label: "Test the water heater relief valve and record the result", required: true, safety: true },
      { label: "Record water heater age, setpoint and anode condition", required: true },
      { label: "Check the expansion tank precharge" },
      { label: "Test water hardness and record it", required: true },
      { label: "Run the meter creep test with all fixtures off", required: true },
      { label: "Inspect visible supply lines and angle stops" },
      { label: "Check every accessible shutoff valve for operation" },
      { label: "Test the sump pump and any battery backup" },
      { label: "Photograph anything recommended for repair", required: true },
    ]},
  ],

  inspectionPrograms: [
    // The customer is not the audience here. The report goes to whoever holds
    // the assembly record, and the tester's certification number goes on it,
    // which is why this is a programme rather than a checklist.
    { code: "backflow-annual", name: "Backflow prevention assembly test", standard: "Backflow assembly testing reported to the local water authority", reportAudience: "authority", frequencyMonths: 12, checkpoints: [
      { key: "assembly_id", label: "Assembly make, model, size and serial recorded", assetCategory: "backflow-assembly", severityOnFail: "major" },
      { key: "check1", label: "First check valve holds", assetCategory: "backflow-assembly", requiresReading: true, unit: "psid", severityOnFail: "critical" },
      { key: "check2", label: "Second check valve holds", assetCategory: "backflow-assembly", requiresReading: true, unit: "psid", severityOnFail: "critical" },
      { key: "relief", label: "Relief valve opens and the differential is recorded", assetCategory: "backflow-assembly", requiresReading: true, unit: "psid", severityOnFail: "critical" },
      { key: "shutoffs", label: "Shutoff valves hold and are operable", assetCategory: "backflow-assembly", severityOnFail: "major" },
      { key: "installation", label: "Assembly orientation and clearance are as installed", assetCategory: "backflow-assembly", severityOnFail: "minor" },
      { key: "gauge_cal", label: "Test gauge calibration date is current", requiresReading: false, severityOnFail: "major" },
    ]},
    { code: "home-plumbing", name: "Annual home plumbing inspection", reportAudience: "customer", frequencyMonths: 12, checkpoints: [
      { key: "pressure", label: "Incoming pressure within range", requiresReading: true, unit: "psi", severityOnFail: "major" },
      { key: "tp_valve", label: "Water heater relief valve operates", requiresReading: false, severityOnFail: "critical" },
      { key: "wh_age", label: "Water heater age and condition", severityOnFail: "advisory" },
      { key: "hardness", label: "Water hardness recorded", requiresReading: true, unit: "gpg", severityOnFail: "advisory" },
      { key: "leaks", label: "No meter movement with fixtures off", severityOnFail: "major" },
      { key: "shutoffs", label: "Main and fixture shutoffs operable", severityOnFail: "minor" },
    ]},
  ],

  submissions: [
    {
      kind: "water_authority.backflow_test_report",
      label: "Backflow assembly test report",
      authorityName: "Local water authority or purveyor holding the assembly record",
      cadence: "per_event",
      route: "portal",
      notes:
        "The software produces the completed test report from the inspection programme: assembly details, the recorded readings, the tester and gauge identifiers, and the pass or fail outcome. Filing routes and formats differ by authority, so the report is rendered and retained but the per authority submission formatters are not written yet.",
    },
  ],

  retention: [
    // The clock runs from when the report was prepared, not from the visit,
    // because a report is often finished and filed days after the test.
    { entityType: "inspection", entityKind: "backflow-annual", clockStart: "report_prepared", retainMonths: 60, basis: "Backflow assembly test records" },
    { entityType: "equipment", entityKind: "water-heater", clockStart: "equipment_removed", retainMonths: 24, basis: "Warranty and install history kept until after the unit is gone" },
    { entityType: "service_report", entityKind: "drain", clockStart: "work_completed", retainMonths: 36, basis: "Camera media and findings supporting a sewer recommendation" },
  ],

  kpis: [
    { key: "avg_ticket", label: "Average ticket", definition: "Invoiced revenue divided by completed jobs. Excludes warranty returns and zero revenue plan visits, which otherwise drag the number down and make a good month look bad.", format: "money", target: "540" },
    { key: "drain_conversion", label: "Drain call conversion", definition: "Drain jobs that produced a camera inspection, a lining or an excavation, divided by all drain jobs. Excludes repeat visits on the same line within thirty days, because counting the rework as a second conversion flatters the number.", format: "percent", target: "25" },
    { key: "close_rate", label: "Close rate", definition: "Approved estimates divided by presented estimates, by technician. Counts an estimate as presented only once per job, so a three option proposal is one presentation and not three.", format: "percent", target: "45" },
    { key: "callback_rate", label: "Callback rate", definition: "Warranty jobs linked to a parent job within thirty days, divided by completed jobs. Excludes jobs the customer booked again for different work at the same address, which are not callbacks.", format: "percent", target: "3" },
    { key: "wh_attach", label: "Water heater opportunity capture", definition: "Water heaters replaced divided by water heaters recorded as over ten years old and inspected in the period. Excludes units the customer has already scheduled with someone else, so the ones nobody followed up on stay visible.", format: "percent", target: "20" },
    { key: "backflow_recert", label: "Backflow retest capture", definition: "Assemblies retested within the period divided by assemblies whose last test is a year or more old. Excludes assemblies recorded as removed or abandoned, which otherwise sit in the denominator forever.", format: "percent", target: "85" },
    { key: "revenue_per_tech", label: "Revenue per technician per day", definition: "Invoiced revenue divided by technician days worked, from the timeclock rather than from the roster, so holiday and training days do not count as capacity.", format: "money", target: "1500" },
    { key: "first_time_fix", label: "First time fix rate", definition: "Jobs completed in one visit divided by all completed jobs, EXCLUDING jobs planned as multi visit and jobs held for a part order. Including planned return visits makes this meaningless.", format: "percent", target: "82" },
  ],

  portalBlocks: [
    { kind: "next_visit" },
    { kind: "equipment_register", title: "Your fixtures and equipment" },
    { kind: "readings_trend", title: "Water pressure and quality over time", config: { keys: ["static_pressure", "hot_water_temp", "water_hardness"] } },
    { kind: "photo_gallery", title: "Camera footage and photos" },
    { kind: "visit_timeline", title: "Service history" },
    { kind: "recommended_work", title: "What we found" },
    { kind: "invoices" },
  ],
};
