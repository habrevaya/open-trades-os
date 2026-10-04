import { ConflictError } from "@opentradesos/api/services";

/**
 * A LIST ASKED FOR WITH A FIELD FILTER, AND WHAT TO SAY WHEN IT CANNOT BE.
 *
 * Both halves from the address bar or neither. A filter the service refuses
 * (a field the company no longer declares, "soon" for a number) is the list
 * without it and the sentence beside it, never an error page.
 */
export function fieldFrom(params: { field?: string | undefined; value?: string | undefined }) {
  const fieldKey = params.field?.trim() || undefined;
  const fieldValue = params.value?.trim() || undefined;
  return { fieldKey, fieldValue, byField: fieldKey && fieldValue ? { fieldKey, fieldValue } : {} };
}

export async function withFieldFilter<T>(
  run: (byField: boolean) => Promise<T>,
): Promise<{ page: T; refusal: string | null }> {
  try {
    return { page: await run(true), refusal: null };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return { page: await run(false), refusal: error.message };
  }
}
