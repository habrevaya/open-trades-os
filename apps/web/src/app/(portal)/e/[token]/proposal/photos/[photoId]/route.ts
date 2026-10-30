import { getDb } from "@/lib/db";
import { proposals, proposalTemplates } from "@opentradesos/api/services";
import { photoResponse } from "../../../../../photo-response";

/**
 * ONE PHOTOGRAPH THE CUSTOMER'S PROPOSAL SHOWS: its cover (`cover`), one on
 * an option of this estimate, or the picture of a price book item one of its
 * lines was priced from (`item-` and the version), and nothing else. The link that shows the
 * proposal is what shows its photographs; reading one does not spend it.
 * A bad token, another estimate's photograph and a removed one are all the
 * same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; photoId: string }> }) {
  const { token, photoId } = await params;
  if (!proposalTemplates.isProposalPhotoId(photoId)) return photoResponse(null);
  return photoResponse(await proposals.proposalPhotoForToken(getDb(), token, photoId).catch(() => null));
}
