import type { TradePackInput } from "../src/schema";

/**
 * Lawn care and landscaping. The largest business count of any trade in the
 * research, and the pack that proves capacity is a property of the job type
 * rather than of the company.
 *
 * A landscape company of any size runs two businesses out of one yard. The
 * maintenance side is a route: a crew leaves with fifteen to forty stops on a
 * fixed weekday and the route itself is the object that gets balanced. The
 * install side is crew production: a named crew plus assigned equipment on one
 * property for a day or a week, measured in square feet, linear feet and cubic
 * yards. The money is in install, so the pack declares crew_production at the
 * top, but the mowing and application job types below are honestly marked as
 * route work. Forcing either side into the other's model is the single most
 * common reason a landscaper abandons generic field service software.
 *
 * Chemical application is the other thing generic software gets wrong. A
 * fertilisation round is not a note in a work order, it is a record with a
 * product, an EPA registration number, the licence of the person who applied
 * it, a rate, a treated area and a target. Those are readings here, flagged
 * regulated, so the record is a by product of doing the visit rather than
 * paperwork done later from memory.
 *
 * Prices are US national average starting points, not recommendations. Setup
 * walks the owner through re-margining for their market.
 */
export const lawnAndLandscape: TradePackInput = {
  id: "lawn-and-landscape",
  name: "Lawn care and landscaping",
  version: 1,
  capacityModel: "crew_production",
  summary:
    "Maintenance routes, fertilisation and weed control programmes, irrigation, and landscape and hardscape install. Route work and crew production live side by side because the business genuinely runs both.",
  status:
    "Price book, job types, checklists, readings, irrigation asset tracking and KPIs are complete. Pesticide application records are captured in full but no state submission formatter is written, and state requirements differ enough that none is assumed. Aerial measurement, budgeted hour variance against a crew schedule, seasonal contract instalment billing and equipment hour tracking per mower are modelled in the price book but not yet in the product. Snow is not included and belongs in its own pack.",

  /**
   * Two capacity models in one trade. The route job types carry no production
   * unit because a mowing stop is priced and scheduled as a stop; the crew
   * job types carry the unit the work is actually estimated and costed in.
   */
  jobTypes: [
    { code: "mow", name: "Mowing route stop", capacityModel: "route", defaultDurationMinutes: 35, requiredSkills: ["mow-crew"], color: "#2E7D32" },
    { code: "fert", name: "Fertilisation and weed control round", capacityModel: "route", defaultDurationMinutes: 30, requiredSkills: ["applicator-license"], color: "#F9A825" },
    { code: "php", name: "Tree and shrub care round", capacityModel: "route", defaultDurationMinutes: 45, requiredSkills: ["applicator-license"] },
    { code: "irr", name: "Irrigation service", capacityModel: "technician_dispatch", defaultDurationMinutes: 90, requiredSkills: ["irrigation-tech"], color: "#0277BD" },
    { code: "cleanup", name: "Seasonal clean up", capacityModel: "crew_production", defaultDurationMinutes: 240, productionUnit: "square feet" },
    { code: "mulch", name: "Mulch and bed refresh", capacityModel: "crew_production", defaultDurationMinutes: 180, productionUnit: "cubic yards" },
    { code: "install", name: "Landscape and hardscape install", capacityModel: "crew_production", defaultDurationMinutes: 480, requiredSkills: ["install-crew"], productionUnit: "square feet", color: "#6B3FA0" },
    { code: "wall-edge", name: "Retaining wall and bed edging", capacityModel: "crew_production", defaultDurationMinutes: 420, requiredSkills: ["install-crew"], productionUnit: "linear feet" },
  ],

  priceBook: [
    { code: "MOW-S", name: "Mow, trim, edge and blow, up to 5,000 sq ft of turf", category: "Maintenance", price: "48.00", cost: "23.00", laborMinutes: 25, taxClass: "service", description: "Cut at the height set for your grass type, string trim, hard edge the walks and drive, blow every hard surface clean." },
    { code: "MOW-M", name: "Mow, trim, edge and blow, 5,000 to 10,000 sq ft", category: "Maintenance", price: "62.00", cost: "29.00", laborMinutes: 35, taxClass: "service" },
    { code: "MOW-L", name: "Mow, trim, edge and blow, 10,000 sq ft to half acre", category: "Maintenance", price: "84.00", cost: "40.00", laborMinutes: 50, taxClass: "service" },
    { code: "MOW-XL", name: "Mow, trim, edge and blow, half acre to one acre", category: "Maintenance", price: "125.00", cost: "58.00", laborMinutes: 75, taxClass: "service" },
    { code: "MOW-COMM-AC", name: "Commercial grounds mowing, per acre per visit", category: "Maintenance", price: "95.00", cost: "46.00", laborMinutes: 55, taxClass: "service" },
    /**
     * The seasonal instalment is the SKU generic software cannot hold. The
     * customer pays the same amount every month across a seven month season
     * while visit counts swing from five in a wet May to two in August, so
     * revenue recognition and route costing have to be separable.
     */
    { code: "MOW-SEASON-M", name: "Seasonal mowing agreement, medium lot, monthly instalment", category: "Agreements", price: "248.00", cost: "116.00", taxClass: "service", description: "One price every month across the season rather than a bill that swings with the weather. Visit frequency follows growth, not the calendar." },
    { code: "FERT-R1", name: "Round 1: pre emergent and balanced fertiliser, up to 5,000 sq ft", category: "Turf programme", price: "74.00", cost: "27.00", laborMinutes: 25, taxClass: "service", description: "Applied before soil temperatures wake the annual grasses up. Timing is driven by soil temperature, not by a date on a calendar." },
    { code: "FERT-R2", name: "Round 2: pre emergent and broadleaf weed control, up to 5,000 sq ft", category: "Turf programme", price: "74.00", cost: "28.00", laborMinutes: 25, taxClass: "service" },
    { code: "FERT-R3", name: "Round 3: slow release fertiliser and spot weed control, up to 5,000 sq ft", category: "Turf programme", price: "79.00", cost: "31.00", laborMinutes: 25, taxClass: "service" },
    { code: "FERT-R4", name: "Round 4: summer fertiliser with iron, up to 5,000 sq ft", category: "Turf programme", price: "84.00", cost: "34.00", laborMinutes: 25, taxClass: "service" },
    { code: "FERT-R5", name: "Round 5: early autumn fertiliser and broadleaf control, up to 5,000 sq ft", category: "Turf programme", price: "79.00", cost: "31.00", laborMinutes: 25, taxClass: "service" },
    { code: "FERT-R6", name: "Round 6: winterising fertiliser, up to 5,000 sq ft", category: "Turf programme", price: "86.00", cost: "35.00", laborMinutes: 25, taxClass: "service" },
    { code: "FERT-ADD-1K", name: "Additional 1,000 sq ft of turf, any round", category: "Turf programme", price: "9.50", cost: "3.60", taxClass: "service" },
    { code: "FERT-PROG-6", name: "Six round turf programme, prepaid annual, up to 5,000 sq ft", category: "Agreements", price: "436.00", cost: "186.00", taxClass: "service", description: "All six rounds at a prepay discount, with free service calls between rounds if a weed breaks through." },
    { code: "GRUB-PREV", name: "Grub preventative application, up to 5,000 sq ft", category: "Turf programme", price: "98.00", cost: "39.00", laborMinutes: 25, taxClass: "service" },
    { code: "WEED-SPOT", name: "Spot weed control service call", category: "Turf programme", price: "68.00", cost: "23.00", laborMinutes: 25, taxClass: "service" },
    { code: "AER-CORE", name: "Core aeration, up to 5,000 sq ft", category: "Turf renovation", price: "149.00", cost: "57.00", laborMinutes: 45, taxClass: "service", description: "Pulled cores left on the surface to break down. Relieves compaction so water, air and fertiliser reach the root zone." },
    { code: "AER-SEED-1K", name: "Overseed with aeration, per 1,000 sq ft", category: "Turf renovation", price: "38.00", cost: "16.00", taxClass: "service" },
    { code: "SOIL-TEST", name: "Soil test with written recommendations", category: "Turf renovation", price: "78.00", cost: "29.00", laborMinutes: 20, taxClass: "service", description: "Lab results for pH and nutrients, with what the numbers mean for your programme next season." },
    { code: "MULCH-YD", name: "Double shredded hardwood mulch, installed, per cubic yard", kind: "material", category: "Beds", price: "95.00", cost: "48.00", taxClass: "material" },
    { code: "MULCH-DYE-YD", name: "Dyed mulch, installed, per cubic yard", kind: "material", category: "Beds", price: "108.00", cost: "56.00", taxClass: "material" },
    { code: "BED-EDGE-LF", name: "Hand cut bed edge, per linear foot", category: "Beds", price: "2.25", cost: "0.95", taxClass: "service" },
    { code: "IRR-START", name: "Irrigation start up, up to 8 zones", category: "Irrigation", price: "148.00", cost: "54.00", laborMinutes: 75, taxClass: "service", description: "Charge the system, run and watch every zone, adjust heads for coverage, set the controller for the season." },
    { code: "IRR-ZONE-ADD", name: "Additional irrigation zone, start up or winterisation", category: "Irrigation", price: "14.00", cost: "5.00", laborMinutes: 6, taxClass: "service" },
    { code: "IRR-WINT", name: "Irrigation winterisation, compressed air blow out, up to 8 zones", category: "Irrigation", price: "128.00", cost: "46.00", laborMinutes: 60, taxClass: "service" },
    { code: "IRR-HEAD", name: "Spray head replacement", category: "Irrigation", price: "29.00", cost: "6.50", laborMinutes: 15, taxClass: "material", warrantyMonths: 12 },
    { code: "IRR-ROTOR", name: "Rotor replacement", category: "Irrigation", price: "48.00", cost: "15.00", laborMinutes: 20, taxClass: "material", warrantyMonths: 12 },
    { code: "IRR-VALVE", name: "Zone valve replacement", category: "Irrigation", price: "235.00", cost: "39.00", laborMinutes: 90, taxClass: "material", warrantyMonths: 12 },
    { code: "IRR-CTRL-SMART", name: "Smart irrigation controller, installed", kind: "equipment", category: "Irrigation", price: "495.00", cost: "192.00", laborMinutes: 90, taxClass: "equipment", warrantyMonths: 24 },
    { code: "IRR-AUDIT", name: "Irrigation audit with catch cup test", category: "Irrigation", price: "289.00", cost: "112.00", laborMinutes: 150, taxClass: "service", description: "Measured distribution uniformity zone by zone, with a written schedule that waters the dry spots instead of the whole lawn." },
    { code: "PAVER-PATIO-SF", name: "Paver patio, installed, per square foot", category: "Hardscape", price: "27.00", cost: "14.50", taxClass: "service", warrantyMonths: 60 },
    { code: "WALL-BLOCK-SF", name: "Segmental retaining wall, per face square foot", category: "Hardscape", price: "44.00", cost: "24.00", taxClass: "service", warrantyMonths: 60 },
    { code: "SOD-SF", name: "Sod, installed on prepared soil, per square foot", kind: "material", category: "Install", price: "1.95", cost: "0.98", taxClass: "material" },
    { code: "SHRUB-TRIM-HR", name: "Shrub and hedge trimming, per crew hour", kind: "labor", category: "Tree and shrub", price: "88.00", cost: "40.00", laborMinutes: 60, taxClass: "labor" },
    { code: "TREE-DEEP-FEED", name: "Deep root feed, per tree", category: "Tree and shrub", price: "68.00", cost: "24.00", laborMinutes: 20, taxClass: "service" },
    { code: "TREE-INSECT", name: "Tree and shrub insect control, per application", category: "Tree and shrub", price: "98.00", cost: "36.00", laborMinutes: 30, taxClass: "service" },
    { code: "CLEAN-SPRING-HR", name: "Spring clean up, per crew hour", kind: "labor", category: "Seasonal", price: "78.00", cost: "36.00", laborMinutes: 60, taxClass: "labor" },
    { code: "CLEAN-FALL-HR", name: "Autumn leaf clean up, per crew hour", kind: "labor", category: "Seasonal", price: "78.00", cost: "36.00", laborMinutes: 60, taxClass: "labor" },
    { code: "DEBRIS-YD", name: "Green waste haul away, per cubic yard", kind: "fee", category: "Fees", price: "38.00", cost: "17.00", taxClass: "service" },
    { code: "TRIP-OUT", name: "Travel fee outside the route area", kind: "fee", category: "Fees", price: "39.00", taxClass: "service", description: "Charged only where a property sits off the day's route and the drive cannot be shared with other stops." },
  ],

  /**
   * Irrigation is the one place a lawn company genuinely owns an asset record
   * that outlives the customer relationship. A controller has zones, a zone
   * has a head type and a plant type, and the history of which zone was rebuilt
   * in which year is worth more than any other note on the account. The turf
   * and bed areas are here too because the programme is sold against a measured
   * area and that measurement should not live in a proposal PDF.
   */
  equipmentCategories: [
    { code: "irrigation-controller", name: "Irrigation controller", attributes: [
      { key: "zone_count", label: "Zone count", kind: "numeric" },
      { key: "location", label: "Location", kind: "text" },
      { key: "smart", label: "Weather based control", kind: "boolean" },
      { key: "power", label: "Power and common wire condition", kind: "select", options: ["Good", "Suspect", "Failed"] },
    ]},
    { code: "irrigation-zone", name: "Irrigation zone", parentCode: "irrigation-controller", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "zone_number", label: "Zone number", kind: "numeric" },
      { key: "head_type", label: "Head type", kind: "select", options: ["Spray", "Rotor", "Rotary nozzle", "Drip", "Bubbler"] },
      { key: "plant_type", label: "Plant type", kind: "select", options: ["Turf", "Shrub bed", "Annual bed", "Tree ring", "Vegetable"] },
      { key: "exposure", label: "Sun exposure", kind: "select", options: ["Full sun", "Part sun", "Shade"] },
      { key: "runtime_minutes", label: "Seasonal runtime", kind: "numeric" },
    ]},
    { code: "rain-sensor", name: "Rain or soil moisture sensor", parentCode: "irrigation-controller", tracksWarranty: true },
    { code: "backflow-device", name: "Backflow prevention device", attributes: [
      { key: "device_type", label: "Device type", kind: "select", options: ["Pressure vacuum breaker", "Double check", "Reduced pressure"] },
      { key: "last_test_date", label: "Last test date", kind: "date" },
    ]},
    { code: "turf-area", name: "Turf area", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "square_feet", label: "Measured square feet", kind: "numeric" },
      { key: "grass_type", label: "Grass type", kind: "select", options: ["Tall fescue", "Kentucky bluegrass", "Perennial ryegrass", "Bermuda", "Zoysia", "St Augustine", "Centipede", "Buffalo", "Mixed"] },
      { key: "irrigated", label: "Irrigated", kind: "boolean" },
    ]},
    { code: "landscape-bed", name: "Landscape bed", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "square_feet", label: "Measured square feet", kind: "numeric" },
      { key: "mulch_yards", label: "Mulch yards to refresh", kind: "numeric" },
      { key: "edge_linear_feet", label: "Edge linear feet", kind: "numeric" },
    ]},
  ],

  /**
   * The first block is the application record. Every one of these is flagged
   * regulated because together they are what an inspector asks to see, and
   * because capturing them at the stop is the only way they are ever accurate.
   * Rate and treated area trend: a rate that climbs season over season on the
   * same lawn is either a measurement problem or a resistance problem, and
   * both are worth seeing.
   */
  readings: [
    { key: "product_applied", label: "Product applied, brand name as on the label", kind: "chemical", regulated: true },
    { key: "epa_reg_no", label: "EPA registration number", kind: "chemical", regulated: true },
    { key: "applicator_license", label: "Applicator licence number", kind: "chemical", regulated: true, customerVisible: false },
    { key: "target_pest", label: "Target weed, insect or disease", kind: "chemical", regulated: true },
    { key: "rate_applied", label: "Rate applied", kind: "chemical", unit: "per 1000 sqft", regulated: true, trend: true, min: 0, max: 512 },
    { key: "area_treated", label: "Area treated", kind: "chemical", unit: "sq ft", regulated: true, trend: true, min: 0, max: 500000 },
    { key: "wind_speed", label: "Wind speed at application", kind: "numeric", unit: "mph", regulated: true, trend: true, min: 0, max: 40 },
    { key: "air_temp", label: "Air temperature at application", kind: "numeric", unit: "F", regulated: true, trend: true, min: 10, max: 120 },
    { key: "reentry_posted", label: "Re entry notice posted at the property", kind: "boolean", regulated: true },
    { key: "soil_ph", label: "Soil pH", kind: "measurement", trend: true, min: 3.5, max: 9.5 },
    { key: "soil_moisture", label: "Soil moisture", kind: "measurement", unit: "%", trend: true, min: 0, max: 60 },
    { key: "mow_height", label: "Mowing height", kind: "measurement", unit: "in", trend: true, min: 0.5, max: 5 },
    { key: "thatch_depth", label: "Thatch depth", kind: "measurement", unit: "in", trend: true, min: 0, max: 2 },
    { key: "turf_density", label: "Turf density rating", kind: "numeric", trend: true, min: 1, max: 9, customerVisible: true },
    { key: "weed_pressure", label: "Weed pressure", kind: "select", options: ["None", "Light", "Moderate", "Heavy"] },
    { key: "irr_pressure", label: "Irrigation static pressure", kind: "numeric", unit: "psi", trend: true, min: 15, max: 120, customerVisible: false },
    { key: "zone_uniformity", label: "Zone distribution uniformity", kind: "measurement", unit: "%", trend: true, min: 0, max: 100 },
    { key: "clippings_removed", label: "Clippings bagged and removed", kind: "boolean", customerVisible: false },
    { key: "site_photo", label: "Property photo after the visit", kind: "photo" },
  ],

  checklists: [
    /**
     * The safety items here are the ones that end up in a complaint or a
     * claim. Children and pets before spraying is first because it is the one
     * an applicator in a hurry skips, and it is the one the neighbour films.
     */
    { code: "chem-app", name: "Chemical application", jobTypeCodes: ["fert", "php"], items: [
      { label: "Read the product label for this application before mixing", required: true, safety: true },
      { label: "Wear the PPE the label calls for, including gloves and eye protection", required: true, safety: true },
      { label: "Walk the property and confirm no children or pets are outside before spraying", required: true, safety: true },
      { label: "Check for a registered sensitive site or no spray flag on the account", required: true, safety: true },
      { label: "Record wind speed and air temperature before the first application", required: true, safety: true },
      { label: "Confirm gates are closed so a pet cannot come out mid application", required: true, safety: true },
      { label: "Record product, EPA registration number, rate and area treated", required: true },
      { label: "Post the re entry notice where the customer will see it", required: true, safety: true },
      { label: "Rinse and secure the tank, and lock the product compartment before driving", required: true, safety: true },
      { label: "Leave a written summary of what was applied and when it is safe to re enter", required: true },
    ]},
    { code: "mow-stop", name: "Mowing route stop", jobTypeCodes: ["mow"], items: [
      { label: "Confirm the yard is clear of children, pets and toys before dropping the deck", required: true, safety: true },
      { label: "Check blade condition and mowing height against the height set for this grass type", required: true },
      { label: "Confirm string trimmer guard and blower are in working order", required: true, safety: true },
      { label: "Mow at the set height and alternate the pattern from the last visit" },
      { label: "Hard edge the walks, drive and kerb line" },
      { label: "Blow every hard surface clean, blowing away from the street drain", required: true },
      { label: "Close and latch every gate before leaving the property", required: true, safety: true },
      { label: "Photograph the finished property from the street", required: true },
      { label: "Log anything the customer should know: disease, insect damage, irrigation breaks, storm damage" },
    ]},
    { code: "crew-start", name: "Crew day start, trailer and equipment", jobTypeCodes: ["mow", "cleanup", "mulch", "install", "wall-edge"], items: [
      { label: "Walk around the truck and trailer: tyres, lights, plate, mirrors", required: true, safety: true },
      { label: "Check the trailer coupler, safety chains and breakaway cable", required: true, safety: true },
      { label: "Confirm every machine on the trailer is strapped down", required: true, safety: true },
      { label: "Check fuel, oil and hydraulic levels on each machine" },
      { label: "Record engine hours on each mower before leaving the yard" },
      { label: "Confirm first aid kit, fire extinguisher and eye wash are on board", required: true, safety: true },
      { label: "Load water and confirm the shade and rest plan for the forecast heat", required: true, safety: true },
      { label: "For any digging today, confirm the utility locate was requested and the marks are still good", required: true, safety: true },
      { label: "Confirm the route order and the stops that need gate codes or key access" },
    ]},
  ],

  inspectionPrograms: [
    {
      code: "property-condition",
      name: "Property condition assessment",
      standard: "Visual assessment against the programme sold for this property. Not a diagnostic laboratory test.",
      reportAudience: "customer",
      frequencyMonths: 12,
      checkpoints: [
        { key: "turf_density", label: "Turf density and colour against the target for this grass type", requiresReading: true, severityOnFail: "minor" },
        { key: "weed_pressure", label: "Weed pressure within the programme's expected range", requiresReading: true, severityOnFail: "major" },
        { key: "disease_insect", label: "Disease or insect damage present", severityOnFail: "major" },
        { key: "mow_height", label: "Mowing height correct for the grass type", assetCategory: "turf-area", requiresReading: true, unit: "in", severityOnFail: "minor" },
        { key: "thatch", label: "Thatch layer within tolerance", requiresReading: true, unit: "in", severityOnFail: "minor" },
        { key: "soil_ph", label: "Soil pH in range for the grass type", requiresReading: true, severityOnFail: "advisory" },
        { key: "irrigation_coverage", label: "Irrigation coverage with no dry or drowned zones", assetCategory: "irrigation-zone", severityOnFail: "major" },
        { key: "beds", label: "Bed edges, mulch depth and weed cover acceptable", assetCategory: "landscape-bed", severityOnFail: "minor" },
        { key: "trees_shrubs", label: "Tree and shrub health and structure", severityOnFail: "advisory" },
        { key: "drainage", label: "Drainage and erosion, including wash from hardscape", severityOnFail: "major" },
      ],
    },
    {
      code: "irrigation-audit",
      name: "Irrigation distribution audit",
      standard: "Catch cup audit method as taught by the Irrigation Association. Method named as text, not enforced as a rule.",
      reportAudience: "customer",
      frequencyMonths: 24,
      checkpoints: [
        { key: "zone_uniformity", label: "Distribution uniformity measured per zone", assetCategory: "irrigation-zone", requiresReading: true, unit: "%", severityOnFail: "major" },
        { key: "head_condition", label: "Heads level, unobstructed and arcs set", assetCategory: "irrigation-zone", severityOnFail: "minor" },
        { key: "pressure", label: "Static and operating pressure in range", requiresReading: true, unit: "psi", severityOnFail: "major" },
        { key: "controller_schedule", label: "Controller schedule matches the measured precipitation rate", assetCategory: "irrigation-controller", severityOnFail: "minor" },
        { key: "backflow_present", label: "Backflow prevention device present and intact", assetCategory: "backflow-device", severityOnFail: "critical" },
        { key: "leaks", label: "No visible mainline or lateral leaks", severityOnFail: "major" },
      ],
    },
  ],

  /**
   * What the software must produce, and to whom. Deliberately no deadlines,
   * thresholds or citations: those differ by state and by licence category,
   * and a pack that guesses them is worse than a pack that stays quiet.
   */
  submissions: [
    {
      kind: "pesticide.application_record",
      label: "Commercial pesticide application record",
      authorityName: "State lead pesticide agency, record kept by the applicator",
      jurisdiction: "US, varies by state",
      cadence: "per_event",
      notes:
        "Built from the regulated readings on every application visit: product and EPA registration number, the licensed applicator, target, rate, area treated, date and time, and the weather conditions at application. The pack produces and retains the record per application. Which fields a given state adds, how long the record must be held and who may ask for it are not encoded here and the owner should confirm them with their state agency.",
    },
    {
      kind: "pesticide.use_report",
      label: "Periodic pesticide use report",
      authorityName: "State lead pesticide agency",
      jurisdiction: "US, varies by state",
      cadence: "annual",
      route: "portal",
      notes:
        "Some states ask commercial applicators to report use on a recurring schedule rather than only on request. The pack can export every application record for a date range with the fields above. No state specific file format or schedule is implemented yet.",
    },
    {
      kind: "nutrient.application_record",
      label: "Fertiliser and nutrient application record",
      authorityName: "State agriculture or environment agency, record kept by the applicator",
      jurisdiction: "US, varies by state",
      cadence: "per_event",
      notes:
        "Nutrient applications are recorded with product, analysis, rate and area treated so a record exists where a state or watershed programme asks for one. Reporting formats differ by state and none is assumed.",
    },
  ],

  retention: [
    { entityType: "service_report", entityKind: "pesticide_application", clockStart: "record_created", retainMonths: 36, basis: "Application records. States set their own period and some run longer than this default, so the owner should set it to their state." },
    { entityType: "service_report", entityKind: "nutrient_application", clockStart: "calendar_year_end", retainMonths: 36, basis: "Nutrient records are usually reported by season, so the clock runs from year end rather than from the visit." },
    { entityType: "contract", entityKind: "seasonal_agreement", clockStart: "contract_ended", retainMonths: 48, basis: "Seasonal agreements are billed in instalments and disputed after the season closes." },
  ],

  /**
   * Route and crew economics. An owner in this trade does not manage to
   * average ticket, they manage to what a crew produced in a day against what
   * the route was supposed to produce.
   */
  kpis: [
    { key: "revenue_per_crew_day", label: "Revenue per crew day", definition: "Invoiced revenue divided by crew days worked, taken from crew clock in and out rather than from the roster. EXCLUDES yard time, shop days and rain days where no stop was completed, which otherwise make a washed out week look like a productivity collapse.", format: "money", target: "1450" },
    { key: "stops_per_day", label: "Stops per crew day", definition: "Completed maintenance stops divided by crew days. EXCLUDES install and enhancement days entirely, since a crew on a patio all day has one stop and would drag the maintenance number to nothing.", format: "number", target: "22" },
    { key: "route_density", label: "Route density", definition: "Completed stops divided by route miles driven for the day. EXCLUDES the drive from the yard to the first stop and back from the last, which is fixed cost and not a measure of how tightly the route is built.", format: "number", target: "1.5" },
    { key: "production_per_crew_hour", label: "Production units per crew hour", definition: "Production units completed, in the unit on the job type, divided by crew hours on site. EXCLUDES drive time and EXCLUDES mobilisation on the first day of a multi day job, when nothing is produced but the crew is paid.", format: "number" },
    { key: "budget_hour_variance", label: "Budgeted hour variance", definition: "Actual crew hours minus budgeted hours on completed jobs, as a percentage of budgeted. EXCLUDES change order hours that were separately approved, or every approved upsell reads as an overrun.", format: "percent", target: "5" },
    { key: "programme_renewal", label: "Programme renewal rate", definition: "Turf and maintenance agreements renewed for the next season divided by agreements eligible to renew. EXCLUDES properties that sold or where the customer moved, which are not a service failure and should not be managed as one.", format: "percent", target: "85" },
    { key: "reapplication_rate", label: "Free reapplication rate", definition: "Zero revenue service calls inside a programme divided by programme applications completed. EXCLUDES calls where the customer asked for an unrelated estimate while the applicator was on site.", format: "percent", target: "6" },
    { key: "install_gross_margin", label: "Install gross margin", definition: "Install revenue less material, subcontract, disposal and crew burdened labour, divided by install revenue. EXCLUDES maintenance and programme revenue, which carries a different margin and hides a badly estimated patio.", format: "percent", target: "45" },
  ],

  portalBlocks: [
    { kind: "next_visit", title: "Your next visit" },
    { kind: "visit_timeline", title: "Every visit this season" },
    { kind: "photo_gallery", title: "Your property after each visit" },
    { kind: "readings_trend", title: "How the lawn is doing", config: { keys: ["turf_density", "soil_ph", "mow_height"] } },
    { kind: "service_report", title: "What was applied and when it is safe to re enter" },
    { kind: "equipment_register", title: "Your irrigation system" },
    { kind: "plan_status", title: "Your programme" },
  ],
};
