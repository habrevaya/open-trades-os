import type { TradePackInput } from "../src/schema";

/**
 * Dumpster rental. The only pack in the set whose capacity is a steel box.
 *
 * Every other trade sells hours. This one sells container days. The scarce
 * resource is a can, not a person, and the whole economics of the business
 * fall out of one number: what fraction of the fleet is sitting on a customer
 * site earning, versus sitting in the yard. A shop with forty cans and sixty
 * percent utilisation is a shop that bought sixteen cans it did not need.
 *
 * Three consequences run through this file.
 *
 * Delivery and pickup are two separate dispatchable events against one rental,
 * and a swap is a pickup and a delivery performed in one stop. Scheduling the
 * job as a single visit, the way a dispatch trade would, loses the thing the
 * operator most needs to see: where every can is right now and how long it has
 * been there.
 *
 * Billing has two independent meters. One runs on elapsed time, from the
 * delivery to the final pickup, against an included rental period. The other
 * runs on weight, from the scale ticket at the disposal facility, against an
 * included tonnage. Neither is labour, and neither can be derived from the
 * other.
 *
 * The truck cannot help a can that is blocked in. A trip made and a load not
 * taken is still a haul that cost fuel, a driver and a slot on the route, which
 * is why the fee lines here are not an afterthought.
 *
 * Prices are national average starting points, not recommendations, and they
 * move more with the local tipping fee than with anything in this file. Setup
 * walks the owner through re-margining for their market.
 */
export const dumpsterRental: TradePackInput = {
  id: "dumpster-rental",
  name: "Dumpster rental",
  version: 1,
  capacityModel: "asset_rental",
  summary:
    "Roll off container rental. The container is the unit of capacity, delivery and pickup are separate events on one rental, and billing runs on elapsed rental period plus disposal weight from the scale ticket.",
  status:
    "Price book, job types, checklists, weight and load readings, disposal records and KPIs are complete. Tipping fees are placeholders and must be re-margined against the operator's own facility accounts, which is the single largest cost line in the trade. There are no inspection programmes, because the trade has none. Local hauler franchise rules, right of way permit workflows and per jurisdiction diversion report formats are not modelled.",

  jobTypes: [
    { code: "delivery", name: "Delivery", capacityModel: "asset_rental", defaultDurationMinutes: 30, requiredSkills: ["roll-off-driver"], color: "#1E8E3E" },
    { code: "pickup", name: "Final pickup", capacityModel: "asset_rental", defaultDurationMinutes: 30, requiredSkills: ["roll-off-driver"], color: "#0B57D0" },
    // A swap is one stop that closes and opens a rental period at the same
    // address. Modelled as its own job type because the driver must arrive
    // with an empty can on the truck, which the router has to know.
    { code: "swap", name: "Swap, empty for full", capacityModel: "asset_rental", defaultDurationMinutes: 45, requiredSkills: ["roll-off-driver"], color: "#6B3FA0" },
    { code: "dump-return", name: "Dump and return", capacityModel: "asset_rental", defaultDurationMinutes: 75, requiredSkills: ["roll-off-driver"] },
    { code: "relocate", name: "Relocate on site", capacityModel: "asset_rental", defaultDurationMinutes: 30, requiredSkills: ["roll-off-driver"] },
    // The only stop in the trade that is about a person's hours rather than a
    // container's days, and it happens in the yard.
    { code: "yard-repair", name: "Container inspection and repair", capacityModel: "technician_dispatch", defaultDurationMinutes: 120, requiredSkills: ["welding"] },
  ],

  priceBook: [
    // Rental lines carry an included period and an included tonnage in the
    // description, because those two numbers are what the customer is actually
    // buying and what every overage line below is measured against.
    { code: "RO-10-07", name: "10 yard container, 7 day rental", category: "Rental", price: "375.00", cost: "140.00", taxClass: "service", description: "Delivery, seven days on site, pickup and disposal of up to one ton. Best for a bathroom remodel, a garage clear out or heavy debris." },
    { code: "RO-15-07", name: "15 yard container, 7 day rental", category: "Rental", price: "425.00", cost: "165.00", taxClass: "service", description: "Delivery, seven days on site, pickup and disposal of up to two tons." },
    { code: "RO-20-07", name: "20 yard container, 7 day rental", category: "Rental", price: "475.00", cost: "195.00", taxClass: "service", description: "Delivery, seven days on site, pickup and disposal of up to three tons. The size most jobs want." },
    { code: "RO-30-07", name: "30 yard container, 7 day rental", category: "Rental", price: "565.00", cost: "235.00", taxClass: "service", description: "Delivery, seven days on site, pickup and disposal of up to four tons." },
    { code: "RO-40-07", name: "40 yard container, 7 day rental", category: "Rental", price: "645.00", cost: "275.00", taxClass: "service", description: "Delivery, seven days on site, pickup and disposal of up to five tons. Bulky light debris only." },
    { code: "RO-20-14", name: "20 yard container, 14 day rental", category: "Rental", price: "545.00", cost: "215.00", taxClass: "service" },
    { code: "RO-30-14", name: "30 yard container, 14 day rental", category: "Rental", price: "645.00", cost: "260.00", taxClass: "service" },
    { code: "RO-20-28", name: "20 yard container, 28 day construction rate", category: "Rental", price: "795.00", cost: "320.00", taxClass: "service", description: "For an active job site. Twenty eight days on site with scheduled swaps billed separately." },
    { code: "RO-30-28", name: "30 yard container, 28 day construction rate", category: "Rental", price: "915.00", cost: "380.00", taxClass: "service" },
    { code: "RO-10-HEAVY", name: "10 yard heavy debris container, 7 day rental", category: "Rental", price: "425.00", cost: "185.00", taxClass: "service", description: "Concrete, brick, block, dirt and stone only. Loaded level with the rail, never above it." },
    { code: "RO-20-ROOF", name: "20 yard roofing container, 7 day rental", category: "Rental", price: "495.00", cost: "215.00", taxClass: "service", description: "Shingles and roofing tear off only, which keeps the load clean enough for the cheaper disposal rate." },
    { code: "RO-MONTHLY", name: "Container on site, monthly standing rate", category: "Rental", price: "285.00", cost: "95.00", taxClass: "service", description: "For a container that stays on site indefinitely. Hauls and disposal are billed per event." },
    // The elapsed period meter. Per day, from the day after the included
    // period ends, and it runs whether or not anyone is loading the can.
    { code: "OVR-DAY-SM", name: "Extra rental day, 10 to 20 yard", kind: "fee", category: "Overage", price: "12.00", cost: "3.00", taxClass: "service" },
    { code: "OVR-DAY-LG", name: "Extra rental day, 30 to 40 yard", kind: "fee", category: "Overage", price: "18.00", cost: "4.00", taxClass: "service" },
    // The weight meter. Priced per ton over the included tonnage, by material,
    // because the facility charges by material and so must the invoice.
    { code: "OVR-TON-CD", name: "Disposal over included tonnage, mixed construction and demolition, per ton", category: "Disposal", price: "85.00", cost: "62.00", taxClass: "service" },
    { code: "OVR-TON-MSW", name: "Disposal over included tonnage, municipal solid waste, per ton", category: "Disposal", price: "95.00", cost: "68.00", taxClass: "service" },
    { code: "OVR-TON-HEAVY", name: "Disposal over included tonnage, concrete, brick and dirt, per ton", category: "Disposal", price: "55.00", cost: "38.00", taxClass: "service" },
    { code: "OVR-TON-ROOF", name: "Disposal over included tonnage, roofing and shingles, per ton", category: "Disposal", price: "105.00", cost: "78.00", taxClass: "service" },
    { code: "DISP-TON-FLAT", name: "Disposal, per ton, no included tonnage", category: "Disposal", price: "95.00", cost: "70.00", taxClass: "service", description: "Used where the quote is haul plus tonnage rather than a flat rental." },
    { code: "HAUL-FLAT", name: "Haul charge, per haul, disposal billed separately", category: "Disposal", price: "265.00", cost: "115.00", taxClass: "service" },
    { code: "SVC-SWAP", name: "Swap, empty container for full", category: "Service events", price: "275.00", cost: "120.00", taxClass: "service", description: "One trip that takes the full can and leaves an empty one. Disposal is billed on the load removed." },
    { code: "SVC-DUMPRET", name: "Dump and return the same container", category: "Service events", price: "265.00", cost: "120.00", taxClass: "service" },
    { code: "SVC-RELOCATE", name: "Relocate the container on site", category: "Service events", price: "135.00", cost: "55.00", taxClass: "service" },
    { code: "SVC-LIVE-15", name: "Live load wait, per fifteen minutes", kind: "labor", category: "Service events", price: "35.00", cost: "12.00", laborMinutes: 15, taxClass: "labor" },
    // The trip fees. A blocked driveway, a car parked in the way, a locked
    // gate or a can loaded above the rail all mean the truck leaves empty, and
    // that trip cost the same as a successful one.
    { code: "FEE-TRIP-BLOCKED", name: "Trip fee, blocked or inaccessible placement", kind: "fee", category: "Fees", price: "145.00", cost: "55.00", taxClass: "service", description: "Charged when the container cannot be reached or removed on arrival: a vehicle in the way, a locked gate, or no safe path for the truck." },
    { code: "FEE-DRYRUN", name: "Dry run, container not ready at the scheduled pickup", kind: "fee", category: "Fees", price: "125.00", cost: "55.00", taxClass: "service" },
    { code: "FEE-OVERWEIGHT", name: "Overweight container fee, per occurrence", kind: "fee", category: "Fees", price: "150.00", taxClass: "service", description: "Charged when the loaded weight exceeds what the truck and the road limit allow, over and above the per ton disposal." },
    { code: "FEE-OVERFILL", name: "Overfilled container, loaded above the rail", kind: "fee", category: "Fees", price: "125.00", taxClass: "service", description: "A can loaded above the rail cannot be tarped, which means it cannot legally leave the site until it is levelled." },
    { code: "FEE-CONTAM", name: "Contaminated load sorting, per load", kind: "fee", category: "Fees", price: "250.00", cost: "120.00", taxClass: "service", description: "Charged when a clean load, such as concrete or shingles, has to be re-sorted or re-graded at the facility." },
    { code: "FEE-PROH-MATTRESS", name: "Prohibited item, mattress or box spring, each", kind: "fee", category: "Prohibited items", price: "45.00", cost: "22.00", taxClass: "service" },
    { code: "FEE-PROH-TIRE", name: "Prohibited item, tire, each", kind: "fee", category: "Prohibited items", price: "25.00", cost: "12.00", taxClass: "service" },
    { code: "FEE-PROH-APPLIANCE", name: "Prohibited item, appliance containing refrigerant, each", kind: "fee", category: "Prohibited items", price: "65.00", cost: "35.00", taxClass: "service" },
    { code: "FEE-PROH-PAINT", name: "Prohibited item, liquid paint or chemical container, each", kind: "fee", category: "Prohibited items", price: "35.00", cost: "15.00", taxClass: "service" },
    { code: "FEE-PROH-ELEC", name: "Prohibited item, electronics, each", kind: "fee", category: "Prohibited items", price: "30.00", cost: "14.00", taxClass: "service" },
    { code: "FEE-ZONE-MILE", name: "Extended delivery zone, per mile beyond the included radius", kind: "fee", category: "Fees", price: "4.50", cost: "2.10", taxClass: "service" },
    { code: "FEE-FUEL", name: "Fuel and environmental surcharge, per haul", kind: "fee", category: "Fees", price: "18.00", taxClass: "service" },
    { code: "FEE-PERMIT", name: "Street or right of way placement permit, passed through at cost", kind: "fee", category: "Fees", price: "0", taxClass: "exempt", description: "Billed at the amount charged by the jurisdiction." },
    { code: "ACC-BOARDS", name: "Driveway protection boards, per delivery", kind: "material", category: "Accessories", price: "45.00", cost: "18.00", taxClass: "material", description: "Plywood or matting under the rails and wheels. Cheaper than a resurfaced driveway." },
    { code: "ACC-LOCKBAR", name: "Lockable lid or door bar, per rental", kind: "equipment", category: "Accessories", price: "25.00", cost: "8.00", taxClass: "equipment" },
    { code: "YARD-REPAIR-HR", name: "Container repair labour, per hour", kind: "labor", category: "Fleet", price: "95.00", cost: "48.00", laborMinutes: 60, taxClass: "labor" },
  ],

  /**
   * The containers are COMPANY assets, not customer equipment, so they are not
   * modelled here. A can belongs to a fleet, moves between customers weekly,
   * and its utilisation is the business. Putting it in the customer's
   * equipment register would attach a company asset to whoever happened to
   * rent it last and quietly destroy the fleet view that this trade runs on.
   *
   * What genuinely persists at a customer address is the placement: where the
   * can goes, what the ground is, what is overhead, and how the truck gets to
   * it. That is worth remembering because the second delivery to the same
   * address should not rediscover the low branch the hard way.
   */
  equipmentCategories: [
    { code: "site-placement", name: "Container placement location", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "surface", label: "Ground surface", kind: "select", options: ["Asphalt", "Concrete", "Pavers", "Gravel", "Grass", "Dirt", "Public street"] },
      { key: "protection_required", label: "Driveway protection required", kind: "boolean" },
      { key: "overhead_clearance_ft", label: "Overhead clearance, feet", kind: "numeric" },
      { key: "overhead_hazard", label: "Overhead hazard present", kind: "select", options: ["None", "Power lines", "Service drop", "Tree limbs", "Eaves or awning", "Carport or structure"] },
      { key: "permit_required", label: "Placement permit required", kind: "boolean" },
      { key: "max_size", label: "Largest container this spot takes", kind: "select", options: ["10 yard", "15 yard", "20 yard", "30 yard", "40 yard"] },
      { key: "placement_notes", label: "Placement notes", kind: "text" },
    ]},
    { code: "site-access", name: "Access route to the placement", parentCode: "site-placement", tracksSerial: false, tracksWarranty: false, attributes: [
      { key: "gate_width_ft", label: "Narrowest gate or gap, feet", kind: "numeric" },
      { key: "turning_space", label: "Room to turn the truck", kind: "select", options: ["Pull through", "Back in from the street", "Tight, spotter needed", "No room, street placement only"] },
      { key: "weight_limit", label: "Posted weight or bridge limit on the approach", kind: "text" },
      { key: "access_code", label: "Gate or lot access code", kind: "text" },
    ]},
  ],

  /**
   * Fewer readings than a diagnostic trade, and all of them are either money
   * or evidence. The scale ticket numbers are the support for the largest line
   * on the invoice and the largest line in the cost of goods, so they are
   * captured as first class readings rather than as an attachment somebody
   * photographs and nobody can total.
   */
  readings: [
    { key: "ticket_number", label: "Scale ticket number", kind: "text", customerVisible: true },
    { key: "disposal_facility", label: "Receiving facility", kind: "text", customerVisible: true },
    { key: "material_type", label: "Material disposed", kind: "select", customerVisible: true, options: ["Mixed construction and demolition", "Municipal solid waste", "Roofing and shingles", "Concrete, brick and block", "Soil and dirt", "Yard waste", "Metal", "Cardboard", "Mixed recycling"] },
    { key: "gross_weight", label: "Gross weight at the scale", kind: "numeric", unit: "lb", trend: true, min: 0, max: 120000, customerVisible: false },
    { key: "tare_weight", label: "Tare weight", kind: "numeric", unit: "lb", min: 0, max: 60000, customerVisible: false },
    { key: "net_tons", label: "Net tonnage disposed", kind: "measurement", unit: "ton", trend: true, min: 0, max: 30, customerVisible: true },
    { key: "diverted_tons", label: "Tonnage diverted to recycling", kind: "measurement", unit: "ton", trend: true, min: 0, max: 30, customerVisible: true },
    { key: "fill_level", label: "Fill level at pickup", kind: "select", customerVisible: true, options: ["Under half", "Half", "Three quarters", "Level with the rail", "Above the rail"] },
    { key: "overfilled", label: "Loaded above the rail and could not be tarped", kind: "boolean", customerVisible: true },
    { key: "contamination_observed", label: "Prohibited or contaminating material observed in the load", kind: "boolean", customerVisible: true },
    // Photographed before the can is hooked, because once it is on the truck
    // nobody can prove whose mattress it was.
    { key: "contamination_photo", label: "Photo of the contaminating material in place", kind: "photo", customerVisible: true },
    { key: "placement_photo", label: "Placement photo at delivery", kind: "photo", customerVisible: true },
    { key: "removal_photo", label: "Site photo after removal", kind: "photo", customerVisible: true },
    { key: "container_condition", label: "Container condition at pickup", kind: "select", customerVisible: false, options: ["Serviceable", "Minor damage", "Needs repair", "Out of service"] },
  ],

  checklists: [
    { code: "delivery-place", name: "Delivery and placement", jobTypeCodes: ["delivery", "swap", "relocate"], items: [
      { label: "Look up before raising the bed: power lines, service drops, tree limbs, eaves and carports", required: true, safety: true },
      { label: "Confirm the truck is on level ground and the parking brake is set before raising the bed", required: true, safety: true },
      { label: "Clear people, pets and vehicles from the swing and roll path", required: true, safety: true },
      { label: "Confirm clearance for the can door to open fully", required: true },
      { label: "Assess the ground: soft, sloped, freshly sealed or a surface that will mark", required: true, safety: true },
      { label: "Lay driveway protection boards under the rails and the wheels where required", required: true },
      { label: "Photograph the placement and the surrounding surface before leaving", required: true },
      { label: "Photograph any pre existing damage to the driveway, kerb or lawn", required: true },
      { label: "Confirm the can is not blocking a hydrant, a sidewalk or a neighbour's access", required: true, safety: true },
      { label: "Confirm the placement permit is in hand where the can sits on a public street", required: true },
      { label: "Leave the prohibited item list and the fill line instruction with the customer", required: true },
      { label: "Tell the customer the rental period end date and what an extra day costs", required: true },
    ]},
    { code: "pickup-load", name: "Pickup and load inspection", jobTypeCodes: ["pickup", "swap", "dump-return"], items: [
      { label: "Walk the container before hooking it", required: true, safety: true },
      { label: "Record the fill level", required: true },
      { label: "Confirm nothing is loaded above the rail, and stop if it is", required: true, safety: true },
      { label: "Look for prohibited items and photograph anything found before it goes on the truck", required: true },
      { label: "Confirm the load is dry enough to haul and not holding water", safety: true },
      { label: "Inspect the cable, hook, rails and rollers before lifting", required: true, safety: true },
      { label: "Tarp the load and confirm the tarp is secured before moving", required: true, safety: true },
      { label: "Photograph the site after removal, including the ground the can sat on", required: true },
      { label: "Record the scale ticket number, facility, gross, tare and net weight", required: true },
      { label: "Record the container condition and tag it out of service if it needs repair", required: true },
    ]},
    { code: "yard-inspect", name: "Container yard inspection", jobTypeCodes: ["yard-repair"], items: [
      { label: "Lock out the truck and chock the container before working on it", required: true, safety: true },
      { label: "Inspect the floor for thin spots, punctures and weld failures", required: true },
      { label: "Inspect the top rail and side walls for bends that will foul the tarp", required: true },
      { label: "Check the door hinges, latch and gasket", required: true },
      { label: "Inspect the hook eye, cable attachment and rollers", required: true, safety: true },
      { label: "Confirm the unit number and reflective markings are legible", required: true },
      { label: "Return the container to service in the fleet, or leave it tagged out", required: true },
    ]},
  ],

  // No inspection programmes. There is no recurring obligated inspection of a
  // customer site in this trade, and inventing one to fill the array would put
  // a checkpoint list in front of a driver that nobody asked for.
  inspectionPrograms: [],

  submissions: [
    {
      kind: "waste.disposal_ticket",
      label: "Scale ticket and disposal record",
      authorityName: "Receiving landfill or transfer station, and the customer",
      cadence: "per_event",
      notes:
        "One record per haul linking the container, the rental, the receiving facility, the ticket number, gross, tare and net weight and the material type. It is the support behind the tonnage line on the invoice and behind the cost line in the facility account, and the two have to reconcile per haul rather than per month.",
    },
    {
      kind: "waste.manifest",
      label: "Hauling manifest for the load",
      authorityName: "Receiving facility, which acknowledges it",
      cadence: "per_event",
      notes:
        "A two party document: the hauler writes it and the receiving facility acknowledges it. The software must store the acknowledgement or ticket number against the haul, and where a load is refused and re-routed, carry both destinations on the same record rather than overwriting the first.",
    },
    {
      kind: "waste.diversion_report",
      label: "Recycling and diversion report",
      authorityName: "Local or state solid waste authority, where one collects it",
      cadence: "quarterly",
      route: "portal",
      notes:
        "Aggregates net and diverted tonnage by material type and by facility for a period. Which jurisdictions collect this, on what cadence and in what format is configured by the operator. Only a generic export exists; no per jurisdiction formatter is written. The same aggregate is what a commercial customer chasing a diversion target asks for.",
    },
    {
      kind: "waste.placement_permit_register",
      label: "Hauler and placement permit register",
      authorityName: "City or county hauler licensing and right of way permitting",
      cadence: "per_event",
      notes:
        "Per placement, stores the permit number, the issuing body, the validity window and the address, so a container standing on a public street can be shown to have been permitted for the days it stood there. The pack ships no permit types, fees or durations: those are local and they differ street by street.",
    },
  ],

  retention: [
    { entityType: "disposal_ticket", entityKind: "scale_ticket", clockStart: "work_completed", retainMonths: 36, basis: "Runs from the haul, which is the event both the facility and the customer reference when a tonnage charge is questioned." },
    // The rental, not the delivery. A can that sits on a site for eight months
    // would otherwise start ageing out of the archive while it is still out
    // there earning.
    { entityType: "rental_agreement", entityKind: "container", clockStart: "contract_ended", retainMonths: 48, basis: "Runs from the end of the rental rather than its start, so a long standing container is never archived while still on site." },
    { entityType: "photo", entityKind: "placement", clockStart: "contract_ended", retainMonths: 24, basis: "Placement and removal photos are the only answer to a driveway or kerb damage claim, and those arrive well after the can is gone." },
  ],

  kpis: [
    // The number the whole business turns on, and the one most often computed
    // in a way that flatters the fleet. Cans in the yard are available and
    // unrented; leaving them out of the denominator hides exactly the problem
    // the metric exists to expose.
    { key: "utilisation_rate", label: "Container utilisation rate", definition: "Container days rented divided by container days available, where a container day is one container on a customer site for any part of a calendar day. Available days INCLUDE cans sitting in the yard and EXCLUDE only cans tagged out of service for repair. Excluding yard cans makes a bloated fleet look fully booked.", format: "percent", target: "75" },
    { key: "revenue_per_container_month", label: "Revenue per container per month", definition: "Rental, overage, disposal and fee revenue attributed to a container divided by the months that container was in the fleet, including months it never left the yard. EXCLUDES taxes and permit amounts passed through at cost, which are not revenue.", format: "money", target: "1100" },
    { key: "avg_rental_duration", label: "Average rental duration", definition: "Elapsed days from delivery to final pickup, averaged over rentals that ENDED in the period. EXCLUDES rentals still open, which would drag the average down, and counts a swap inside the parent rental rather than as a rental of its own.", format: "duration", target: "9" },
    { key: "disposal_cost_pct", label: "Disposal cost as a percent of revenue", definition: "Tipping and disposal cost taken from scale tickets divided by invoiced revenue on the same hauls. EXCLUDES fuel, driver labour and truck cost, which belong in cost per haul. This is the line that moves when a facility raises its gate rate and nobody reprices.", format: "percent", target: "28" },
    { key: "turnaround_hours", label: "Turnaround between pickup and redelivery", definition: "Hours from a container being emptied at the facility to it being placed on the next customer site. EXCLUDES cans routed to the yard for repair and cans held at customer request, since neither is a dispatch failure.", format: "duration", target: "24" },
    { key: "hauls_per_truck_day", label: "Hauls per truck day", definition: "Completed haul events, meaning deliveries, pickups, swaps, dump and returns and relocations, divided by truck days worked taken from the driver timeclock rather than the roster. Dry runs and blocked trips do NOT count as hauls, but track them separately because they consume the same slot.", format: "number", target: "8" },
    { key: "avg_tons_per_haul", label: "Average tons per haul", definition: "Net tonnage from scale tickets divided by completed hauls, reported by container size. EXCLUDES hauls with no ticket, which should be investigated rather than averaged in at zero.", format: "number", target: "2.4" },
    { key: "overage_capture", label: "Overage capture rate", definition: "Rentals billed for at least one extra day or one extra ton divided by rentals that actually exceeded their included period or tonnage. Measures billing leakage, not pricing: anything under one hundred percent is work already done and never invoiced.", format: "percent", target: "95" },
  ],

  portalBlocks: [
    { kind: "next_visit", title: "Your delivery and pickup" },
    { kind: "service_report", title: "Haul record" },
    { kind: "readings_trend", title: "Tonnage per haul", config: { keys: ["net_tons", "diverted_tons"] } },
    { kind: "photo_gallery", title: "Placement and removal photos" },
    { kind: "documents", title: "Weight tickets and the prohibited item list" },
    { kind: "invoices" },
    { kind: "payments" },
  ],
};
