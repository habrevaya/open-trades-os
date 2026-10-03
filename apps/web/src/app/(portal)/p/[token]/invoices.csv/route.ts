import { getDb } from "@/lib/db";
import { payerDelivery } from "@opentradesos/api/services";

/**
 * The payer's open invoices as a CSV, for the link holder.
 *
 * A read: unlike the office's export it records nothing as delivered, so a
 * clerk downloading it twice, or a mail scanner following the link, changes
 * nothing. A link that does not resolve is a 404 like every portal page.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const body = await payerDelivery.portalCsv(getDb(), { token });
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=\"open-invoices.csv\"",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
