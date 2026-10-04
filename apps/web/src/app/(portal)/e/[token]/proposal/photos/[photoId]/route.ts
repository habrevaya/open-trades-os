import { getDb } from "@/lib/db";
import { proposals } from "@opentradesos/api/services";
import { photoResponse } from "../../../../../photo-response";

/**
 * ONE PHOTOGRAPH THE CUSTOMER'S PROPOSAL SHOWS: its cover (`cover`) or one on
 * an option of this estimate, and nothing else. The link that shows the
 * proposal is what shows its photographs; reading one does not spend it.
 * A bad token, another estimate's photograph and a removed one are all the
 * same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; photoId: string }> }) {
  const { token, photoId } = await params;
  if (photoId !== "cover" && !/^[0-9a-f-]{36}$/i.test(photoId)) return photoResponse(null);
  return photoResponse(await proposals.proposalPhotoForToken(getDb(), token, photoId).catch(() => null));
}
