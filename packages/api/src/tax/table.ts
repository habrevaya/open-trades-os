import { tax } from "@opentradesos/core";
import { registerTaxProvider } from "./provider";

/** The company's own rates: the only tax provider, and the default. See `provider.ts`. */
registerTaxProvider("table", (input) => tax.tableProvider(input.table));
