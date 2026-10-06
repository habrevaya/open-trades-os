import type { tax } from "@opentradesos/core";
import { adapterSettings } from "../secrets/endpoints";

/**
 * THE TAX PROVIDER SEAM
 *
 * One question: what rate is this sale charged, and why. The interface is
 * core's (`tax.TaxProvider`), so the arithmetic and the decision can be
 * tested without a database; this file is the registry every other seam
 * here has (`registerMailProvider`, the accounting and routing providers),
 * so a service asks for a provider by name and never imports an adapter.
 *
 * ONE IMPLEMENTATION, ON PURPOSE. The built-in `table` answers from the
 * rates the company wrote down (`services/tax.ts` loads them). Looking a
 * jurisdiction's rate up from an address is a commercial product (Avalara,
 * TaxJar and the like) and BUILD.md keeps "Tax rate determination" out of
 * this one; this seam is where an adapter for one would register. Such an
 * adapter asks over the network, so the service would ask it before the
 * transaction that writes the document rather than inside it, which the
 * table, being already loaded, does not need.
 */
export interface TaxProviderInput {
  /** The company's own rates, loaded inside the caller's transaction. */
  table: tax.TaxTable;
  /** The connection's settings, for an adapter that has one. The table has none. */
  settings?: Record<string, unknown>;
}

const registry = new Map<string, (input: TaxProviderInput) => tax.TaxProvider>();

export function registerTaxProvider(name: string, factory: (input: TaxProviderInput) => tax.TaxProvider): void {
  registry.set(name, factory);
}

export function createTaxProvider(name: string, input: TaxProviderInput): tax.TaxProvider {
  const factory = registry.get(name);
  if (!factory) throw new Error(`No tax provider registered for "${name}"`);
  // Never a stored endpoint override: see `adapterSettings`. The table reads
  // none, and an adapter that asks over the network is handed none either.
  return factory(input.settings ? { ...input, settings: adapterSettings(name, input.settings) } : input);
}

/** Read by the seam's test. */
export const registeredTaxProviders = (): string[] => [...registry.keys()];
