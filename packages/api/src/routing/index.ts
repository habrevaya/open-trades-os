export * from "./provider";
export { osrmRouter } from "./osrm";
export { mapboxRouter } from "./mapbox";
export { openRouteServiceRouter } from "./openrouteservice";

/**
 * Imported for the side effect of registering themselves, as the geocoders
 * do. The travel time service resolves a provider by the connection's name
 * and never mentions a vendor.
 */
import "./osrm";
import "./mapbox";
import "./openrouteservice";
