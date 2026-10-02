export * from "./provider";
export { nominatimGeocoder, PUBLIC_ENDPOINT } from "./nominatim";
export { mapboxGeocoder } from "./mapbox";

/**
 * Imported for the side effect of registering themselves, exactly as the
 * messaging, payment and calendar barrels do. The geocoding worker resolves a
 * provider by the connection's name and never mentions either vendor.
 */
import "./nominatim";
import "./mapbox";
