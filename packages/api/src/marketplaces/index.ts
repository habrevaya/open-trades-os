export * from "./provider";

/**
 * The adapters register themselves on import, like every other seam: a
 * deployment that writes one for a regional marketplace imports `./provider`
 * and theirs, and the intake path names none of these.
 */
import "./angi";
import "./thumbtack";
import "./yelp";
