import { createClient } from "@opentradesos/db";
import { sql } from "drizzle-orm";

/**
 * The office revoking a technician's phone, which has no screen yet: a lost
 * phone is revoked through the API or by an operator. The suite does it
 * directly, the way e2e/stripe.ts points Stripe at its fake.
 */
export async function setBrowserDeviceRevoked(technicianName: string, revoked: boolean): Promise<void> {
  const db = createClient();
  try {
    await db.execute(sql`
      update public.device set revoked_at = ${revoked ? sql`now()` : sql`null`}
      where installation_id like 'web:%'
        and technician_id in (select id from public.technician where display_name = ${technicianName})
    `);
  } finally {
    await db.$close();
  }
}
