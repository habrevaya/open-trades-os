import { createClient, schema } from "@opentradesos/db";
import { deliverySchedules, portal } from "@opentradesos/api/services";
import { and, desc, eq } from "drizzle-orm";

/**
 * The clock, moved by hand.
 *
 * A schedule is due at seven on Monday and the suite does not wait for
 * Monday. This puts the schedule's next occurrence a minute in the past and
 * hands it to the same `deliverOne` the worker's pass calls, which is what
 * the worker would do on its next pass. Nothing else is faked: the report
 * runs as its owner, the delivery is recorded, and the email goes to the
 * outbox, which in the seeded company has no mail provider to send it.
 */
export async function deliverScheduleNow(name: string) {
  const db = createClient();
  try {
    const [row] = await db.select({ id: schema.deliverySchedule.id, organizationId: schema.deliverySchedule.organizationId })
      .from(schema.deliverySchedule)
      .where(and(eq(schema.deliverySchedule.name, name), eq(schema.deliverySchedule.kind, "report")))
      .orderBy(desc(schema.deliverySchedule.createdAt)).limit(1);
    if (!row) throw new Error(`No schedule called ${name}`);
    await db.update(schema.deliverySchedule).set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.deliverySchedule.id, row.id));
    return await deliverySchedules.deliverOne(db, row.organizationId, row.id, new Date());
  } finally {
    await db.$close();
  }
}

/**
 * A customer's account link, as the office hands one over, so the customer's
 * side of an emailed statement can be opened without a mail provider.
 */
export async function accountLink(customerId: string): Promise<string> {
  const db = createClient();
  try {
    const [customer] = await db.select({ organizationId: schema.customer.organizationId })
      .from(schema.customer).where(eq(schema.customer.id, customerId)).limit(1);
    if (!customer) throw new Error(`No customer ${customerId}`);
    const grant = await portal.mintGrant(db, {
      organizationId: customer.organizationId, customerId, scope: "customer", expiresInDays: 1,
    });
    return new URL(grant.url).pathname;
  } finally {
    await db.$close();
  }
}
