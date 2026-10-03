import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { currentPortalSession } from "@/lib/portal-session";
import { photoResponse } from "../../../../../photo-response";

/**
 * ONE PHOTOGRAPH FROM A SIGNED IN CUSTOMER'S ACCOUNT, read with the sign in
 * cookie rather than a token in the address, for the reason the logo route
 * beside it gives. The same check as the account link's photographs.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const session = await currentPortalSession(slug);
  if (!session) return new NextResponse("Not found", { status: 404 });
  return photoResponse(await portalAccount.accountPhotoFor(getDb(), session.token, id).catch(() => null));
}
