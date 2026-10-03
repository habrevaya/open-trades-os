export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves, as
 * the payments barrel does. A deployment whose lender is somebody else
 * imports `./provider` and its own adapter.
 */
import "./wisetack";
