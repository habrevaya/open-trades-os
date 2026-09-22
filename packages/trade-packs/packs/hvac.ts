import type { TradePackInput } from "../src/schema";

/**
 * HVAC. The exemplar pack: every other pack should match this depth.
 *
 * Chosen first because it exercises every part of the schema. HVAC has
 * dispatch scheduling, a deep flat rate price book, equipment with serials and
 * warranty that outlive several owners, readings that genuinely trend, a
 * regulated refrigerant record, maintenance agreements, and a replacement
 * pipeline that is the most valuable report in the business.
 *
 * Prices are national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const hvac: TradePackInput = {
  id: "hvac",
  name: "HVAC",
  version: 1,
  capacityModel: "technician_dispatch",
  summary:
    "Heating, ventilation and air conditioning. Service, maintenance agreements and replacement, with equipment history that follows the unit rather than the owner.",
  status:
    "Price book, job types, checklists, readings and KPIs are complete. Refrigerant tracking captures the readings but the submission formatter is not written yet. Load calculations are not included.",

  jobTypes: [
    { code: "diag", name: "Diagnostic", capacityModel: "technician_dispatch", defaultDurationMinutes: 60, requiredSkills: ["hvac-service"], color: "#0B57D0" },
    { code: "repair", name: "Repair", capacityModel: "technician_dispatch", defaultDurationMinutes: 120, requiredSkills: ["hvac-service"] },
    { code: "maint", name: "Maintenance", capacityModel: "technician_dispatch", defaultDurationMinutes: 75, requiredSkills: ["hvac-service"], color: "#6B3FA0" },
    { code: "install", name: "System replacement", capacityModel: "crew_production", defaultDurationMinutes: 480, requiredSkills: ["hvac-install"], productionUnit: "system" },
    { code: "iaq", name: "Indoor air quality", capacityModel: "technician_dispatch", defaultDurationMinutes: 90 },
    { code: "emergency", name: "No heat or no cool", capacityModel: "technician_dispatch", defaultDurationMinutes: 90, requiredSkills: ["hvac-service"], color: "#C4261D" },
  ],

  priceBook: [
    { code: "DIAG-STD", name: "Diagnostic fee", category: "Service", price: "129.00", cost: "0", laborMinutes: 60, taxClass: "service", description: "Full system diagnosis with a written findings report. Applied to the repair if you go ahead today." },
    { code: "DIAG-AH", name: "After hours diagnostic", category: "Service", price: "229.00", laborMinutes: 60, taxClass: "service" },
    { code: "MAINT-TUNE", name: "Precision tune up, one system", category: "Maintenance", price: "189.00", cost: "62.00", laborMinutes: 75, taxClass: "service", description: "Twenty one point inspection, coil clean, filter change, full performance readings recorded and trended." },
    { code: "MAINT-TUNE-ADD", name: "Additional system, same visit", category: "Maintenance", price: "129.00", cost: "45.00", laborMinutes: 45, taxClass: "service" },
    { code: "PLAN-RES-1", name: "Comfort plan, one system, annual", category: "Agreements", price: "228.00", cost: "124.00", taxClass: "service", description: "Two tune ups a year, priority scheduling, no overtime rate, fifteen percent off repairs." },
    { code: "PLAN-RES-2", name: "Comfort plan, two systems, annual", category: "Agreements", price: "384.00", cost: "212.00", taxClass: "service" },
    { code: "CAP-RUN", name: "Run capacitor replacement", category: "Electrical", price: "289.00", cost: "18.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "CAP-DUAL", name: "Dual run capacitor replacement", category: "Electrical", price: "329.00", cost: "31.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "CONT-1P", name: "Contactor, single pole", category: "Electrical", price: "279.00", cost: "22.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "CONT-2P", name: "Contactor, two pole", category: "Electrical", price: "319.00", cost: "34.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "MOT-COND", name: "Condenser fan motor", category: "Motors", price: "749.00", cost: "218.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },
    { code: "MOT-BLOW-PSC", name: "Blower motor, PSC", category: "Motors", price: "889.00", cost: "264.00", laborMinutes: 150, taxClass: "material", warrantyMonths: 12 },
    { code: "MOT-BLOW-ECM", name: "Blower motor, ECM", category: "Motors", price: "1489.00", cost: "512.00", laborMinutes: 180, taxClass: "material", warrantyMonths: 12 },
    { code: "IGN-HSI", name: "Hot surface igniter", category: "Heating", price: "319.00", cost: "38.00", laborMinutes: 45, taxClass: "material", warrantyMonths: 12 },
    { code: "FLAME-SENS", name: "Flame sensor clean or replace", category: "Heating", price: "189.00", cost: "14.00", laborMinutes: 30, taxClass: "material" },
    { code: "IND-MOTOR", name: "Inducer motor assembly", category: "Heating", price: "1149.00", cost: "398.00", laborMinutes: 180, taxClass: "material", warrantyMonths: 12 },
    { code: "HX-INSPECT", name: "Heat exchanger inspection with camera", category: "Heating", price: "159.00", laborMinutes: 45, taxClass: "service" },
    { code: "TXV-REPL", name: "TXV replacement", category: "Refrigeration", price: "1289.00", cost: "186.00", laborMinutes: 240, taxClass: "material", warrantyMonths: 12 },
    { code: "LEAK-SEARCH", name: "Refrigerant leak search", category: "Refrigeration", price: "389.00", laborMinutes: 120, taxClass: "service" },
    { code: "R410A-LB", name: "R-410A refrigerant, per pound", kind: "material", category: "Refrigeration", price: "89.00", cost: "31.00", taxClass: "material" },
    { code: "R454B-LB", name: "R-454B refrigerant, per pound", kind: "material", category: "Refrigeration", price: "109.00", cost: "44.00", taxClass: "material" },
    { code: "COIL-EVAP", name: "Evaporator coil replacement", category: "Refrigeration", price: "2489.00", cost: "742.00", laborMinutes: 360, taxClass: "material", warrantyMonths: 12 },
    { code: "TSTAT-PROG", name: "Programmable thermostat", category: "Controls", price: "329.00", cost: "84.00", laborMinutes: 60, taxClass: "material", warrantyMonths: 12 },
    { code: "TSTAT-SMART", name: "Smart thermostat, installed", category: "Controls", price: "589.00", cost: "198.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 24 },
    { code: "IAQ-UV", name: "UV air purifier, installed", category: "Indoor air quality", price: "899.00", cost: "289.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 24 },
    { code: "IAQ-MEDIA", name: "Media air cleaner, installed", category: "Indoor air quality", price: "749.00", cost: "236.00", laborMinutes: 120, taxClass: "material", warrantyMonths: 12 },
    { code: "IAQ-HUMID", name: "Whole home humidifier, installed", category: "Indoor air quality", price: "1089.00", cost: "372.00", laborMinutes: 180, taxClass: "material", warrantyMonths: 12 },
    { code: "DUCT-SEAL", name: "Duct sealing, accessible runs", category: "Distribution", price: "989.00", laborMinutes: 240, taxClass: "service" },
    { code: "SYS-14SEER-25", name: "2.5 ton 14.3 SEER2 system, installed", kind: "equipment", category: "Replacement", price: "8990.00", cost: "4120.00", laborMinutes: 480, taxClass: "equipment", warrantyMonths: 120, description: "Matched condenser and coil, new line set where accessible, permit and start up included. Ten year parts warranty with registration." },
    { code: "SYS-16SEER-30", name: "3.0 ton 16 SEER2 system, installed", kind: "equipment", category: "Replacement", price: "11490.00", cost: "5380.00", laborMinutes: 540, taxClass: "equipment", warrantyMonths: 120 },
    { code: "SYS-HP-30", name: "3.0 ton heat pump system, installed", kind: "equipment", category: "Replacement", price: "13290.00", cost: "6240.00", laborMinutes: 600, taxClass: "equipment", warrantyMonths: 120 },
    { code: "FURN-80", name: "80 percent furnace, installed", kind: "equipment", category: "Replacement", price: "5890.00", cost: "2640.00", laborMinutes: 420, taxClass: "equipment", warrantyMonths: 120 },
    { code: "FURN-96", name: "96 percent furnace, installed", kind: "equipment", category: "Replacement", price: "7890.00", cost: "3580.00", laborMinutes: 480, taxClass: "equipment", warrantyMonths: 120 },
    { code: "TRIP-ZONE2", name: "Extended travel fee", kind: "fee", category: "Fees", price: "49.00", taxClass: "service" },
    { code: "PERMIT", name: "Permit, passed through at cost", kind: "fee", category: "Fees", price: "0", taxClass: "exempt", description: "Billed at the amount charged by the jurisdiction." },
  ],

  equipmentCategories: [
    { code: "condenser", name: "Condensing unit", attributes: [
      { key: "tonnage", label: "Tonnage", kind: "select", options: ["1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "5.0"] },
      { key: "seer", label: "SEER2", kind: "numeric" },
      { key: "refrigerant", label: "Refrigerant", kind: "select", options: ["R-22", "R-410A", "R-454B", "R-32"] },
    ]},
    { code: "air-handler", name: "Air handler" },
    { code: "furnace", name: "Furnace", attributes: [
      { key: "afue", label: "AFUE", kind: "numeric" },
      { key: "stages", label: "Stages", kind: "select", options: ["Single", "Two", "Modulating"] },
    ]},
    { code: "evap-coil", name: "Evaporator coil", parentCode: "air-handler" },
    { code: "compressor", name: "Compressor", parentCode: "condenser" },
    { code: "thermostat", name: "Thermostat" },
    { code: "mini-split", name: "Ductless mini split" },
  ],

  readings: [
    { key: "supply_temp", label: "Supply air temperature", kind: "numeric", unit: "F", trend: true, min: 40, max: 160 },
    { key: "return_temp", label: "Return air temperature", kind: "numeric", unit: "F", trend: true, min: 50, max: 95 },
    { key: "delta_t", label: "Temperature split", kind: "numeric", unit: "F", trend: true, min: 14, max: 22 },
    { key: "suction_psi", label: "Suction pressure", kind: "numeric", unit: "psi", trend: true, customerVisible: false },
    { key: "liquid_psi", label: "Liquid pressure", kind: "numeric", unit: "psi", trend: true, customerVisible: false },
    { key: "superheat", label: "Superheat", kind: "numeric", unit: "F", trend: true, customerVisible: false, min: 8, max: 14 },
    { key: "subcooling", label: "Subcooling", kind: "numeric", unit: "F", trend: true, customerVisible: false, min: 8, max: 14 },
    { key: "static_total", label: "Total external static pressure", kind: "numeric", unit: "in wc", trend: true, max: 0.8 },
    { key: "amp_compressor", label: "Compressor amps", kind: "numeric", unit: "A", trend: true, customerVisible: false },
    { key: "cap_measured", label: "Capacitor measured", kind: "numeric", unit: "uF", trend: true },
    { key: "cap_rated", label: "Capacitor rated", kind: "numeric", unit: "uF" },
    { key: "flame_signal", label: "Flame signal", kind: "numeric", unit: "uA", trend: true, customerVisible: false },
    { key: "co_ambient", label: "Ambient carbon monoxide", kind: "numeric", unit: "ppm", trend: true, max: 9 },
    { key: "hx_condition", label: "Heat exchanger condition", kind: "select", options: ["Pass", "Monitor", "Fail"] },
    { key: "refrig_added", label: "Refrigerant added", kind: "chemical", unit: "lb", regulated: true, customerVisible: true },
    { key: "refrig_recovered", label: "Refrigerant recovered", kind: "chemical", unit: "lb", regulated: true },
  ],

  checklists: [
    { code: "maint-cool", name: "Cooling maintenance", jobTypeCodes: ["maint"], items: [
      { label: "Confirm power is off and locked out before opening the unit", required: true, safety: true },
      { label: "Inspect and photograph the data plate" },
      { label: "Clean condenser coil" },
      { label: "Check and record capacitor, measured against rated", required: true },
      { label: "Inspect contactor for pitting" },
      { label: "Record compressor and fan amp draw", required: true },
      { label: "Record suction and liquid pressures, superheat and subcooling", required: true },
      { label: "Measure and record temperature split", required: true },
      { label: "Measure total external static pressure", required: true },
      { label: "Replace filter and record size" },
      { label: "Flush condensate drain and confirm flow" },
      { label: "Check float switch operation" },
      { label: "Photograph before and after" },
      { label: "Review findings with the customer and record declined work", required: true },
    ]},
    { code: "maint-heat", name: "Heating maintenance", jobTypeCodes: ["maint"], items: [
      { label: "Confirm gas is off before opening the burner compartment", required: true, safety: true },
      { label: "Inspect heat exchanger with camera and record condition", required: true, safety: true },
      { label: "Measure ambient carbon monoxide and record", required: true, safety: true },
      { label: "Clean and test flame sensor, record microamps", required: true },
      { label: "Inspect igniter" },
      { label: "Check inducer operation and pressure switch" },
      { label: "Verify gas pressure" },
      { label: "Test safety controls and limits", required: true, safety: true },
      { label: "Replace filter and record size" },
      { label: "Record supply and return temperatures", required: true },
    ]},
    { code: "install-start", name: "Replacement start up", jobTypeCodes: ["install"], items: [
      { label: "Confirm permit is pulled and posted", required: true },
      { label: "Photograph old equipment data plates before removal", required: true },
      { label: "Recover refrigerant and record the amount", required: true },
      { label: "Pressure test and evacuate to 500 microns", required: true },
      { label: "Record charge added by weight", required: true },
      { label: "Verify superheat and subcooling at start up", required: true },
      { label: "Record new equipment serials", required: true },
      { label: "Register manufacturer warranty", required: true },
      { label: "Walk the customer through the thermostat" },
      { label: "Schedule the first maintenance visit" },
    ]},
  ],

  inspectionPrograms: [
    { code: "comfort-plan", name: "Comfort plan visit", reportAudience: "customer", frequencyMonths: 6, checkpoints: [
      { key: "cooling", label: "Cooling performance within range", requiresReading: true, unit: "F", severityOnFail: "major" },
      { key: "heating", label: "Heating performance within range", requiresReading: true, unit: "F", severityOnFail: "major" },
      { key: "hx", label: "Heat exchanger integrity", severityOnFail: "critical" },
      { key: "co", label: "Ambient carbon monoxide below threshold", requiresReading: true, unit: "ppm", severityOnFail: "critical" },
      { key: "static", label: "Static pressure within design", requiresReading: true, unit: "in wc", severityOnFail: "minor" },
      { key: "capacitor", label: "Capacitor within tolerance", requiresReading: true, unit: "uF", severityOnFail: "major" },
    ]},
  ],

  submissions: [
    {
      kind: "epa.608.refrigerant_record",
      label: "Refrigerant addition and recovery record",
      authorityName: "EPA, kept on site",
      cadence: "per_event",
      notes:
        "Captured per visit from the regulated readings. The record is produced and retained; the submission formatter is not written yet.",
    },
  ],

  retention: [
    { entityType: "service_report", entityKind: "refrigerant", clockStart: "record_created", retainMonths: 36, basis: "Refrigerant servicing records" },
    { entityType: "inspection", entityKind: "comfort-plan", clockStart: "next_activity_of_type", retainMonths: 12 },
  ],

  kpis: [
    { key: "avg_ticket", label: "Average ticket", definition: "Invoiced revenue divided by completed jobs. Excludes zero revenue agreement visits, which otherwise drag the number down and make a good month look bad.", format: "money", target: "650" },
    { key: "close_rate", label: "Close rate", definition: "Approved estimates divided by presented estimates, by technician.", format: "percent", target: "45" },
    { key: "callback_rate", label: "Callback rate", definition: "Warranty jobs linked to a parent job within thirty days, divided by completed jobs.", format: "percent", target: "2" },
    { key: "maint_attach", label: "Maintenance plan attach rate", definition: "New plans sold divided by completed service calls to non members.", format: "percent", target: "30" },
    { key: "replace_pipeline", label: "Replacement pipeline", definition: "Total value of declined replacement recommendations on systems over twelve years old that are still active.", format: "money" },
    { key: "revenue_per_tech", label: "Revenue per technician per day", definition: "Invoiced revenue divided by technician days worked, from the timeclock rather than from the roster.", format: "money", target: "1800" },
    { key: "first_time_fix", label: "First time fix rate", definition: "Jobs completed in one visit divided by all completed jobs, EXCLUDING jobs planned as multi visit. Including planned multi visit work makes this meaningless.", format: "percent", target: "85" },
  ],

  portalBlocks: [
    { kind: "next_visit" },
    { kind: "equipment_register", title: "Your systems" },
    { kind: "readings_trend", title: "Performance over time", config: { keys: ["delta_t", "static_total", "co_ambient"] } },
    { kind: "visit_timeline", title: "Service history" },
    { kind: "recommended_work", title: "What we found" },
    { kind: "plan_status" },
    { kind: "invoices" },
  ],
};
