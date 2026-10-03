import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { portalAccount } from "@opentradesos/api/services";
import { photoResponse } from "../../../../photo-response";

/**
 * ONE PHOTOGRAPH FROM THE CUSTOMER'S ACCOUNT, THROUGH THE ACCOUNT LINK.
 *
 * The job link's rule over every job the customer has: the service checks
 * the photograph is on one of this customer's jobs and shown to them, and a
 * bad token, another customer's photograph and a private one are all the
 * same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  return photoResponse(await portalAccount.accountPhotoFor(getDb(), token, id).catch(() => null));
}
