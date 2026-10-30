import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { priceBook } from "@opentradesos/api/services";
import { photoResponse } from "../../../../(portal)/photo-response";

/**
 * The picture uploaded onto one version of a price book item, for the office:
 * the item page and the estimate composer. Under `pricebook:read`, and only
 * the picture the version names, so this reads nothing else in the company's
 * file store. Anything else, a removed item or no picture, is the same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const user = await requireSetupUser();
  const { versionId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) return photoResponse(null);
  return photoResponse(await priceBook.pictureOfVersion({ actor: user.actor, db: getDb() }, { versionId }).catch(() => null));
}
