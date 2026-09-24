import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { properties, equipment as equipmentService, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { Register } from "./Register";

export const dynamic = "force-dynamic";

/**
 * AN ADDRESS, AND WHAT IS IN IT
 *
 * The property read has returned an `equipmentCount` since it was written,
 * and there was no screen to show it on and nothing that could list what the
 * count counted. So the product knew there were twelve units at a building
 * and could not say what any of them were.
 *
 * For a service trade those four questions are the whole of the first minute
 * of a call: what is here, how old is it, is it still covered, and what did
 * we do to it last time.
 */
export default async function PropertyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  /**
   * A record outside the caller's scope is a 404, not a 403, same as a
   * customer: "forbidden" answers the question they were not allowed to ask.
   */
  const property = await properties.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  const readsEquipment = can(user.actor, "equipment:read");
  const register = readsEquipment
    ? await equipmentService.atProperty(ctx, { propertyId: id })
    : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/customers">Customers</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{property.address.line1}</h1>
      <p className="text-sm text-ink-700">
        {[property.address.city, property.address.state, property.address.postalCode]
          .filter(Boolean).join(" ")}
      </p>

      <Facts>
        {property.customers.length > 0 && (
          <Fact label="People">
            {property.customers.map((link) => (
              <a key={link.id} href={`/customers/${link.id}`}
                 className="mr-2 hover:underline">
                {link.name}
                <span className="ml-1 text-ink-500">{link.role}</span>
              </a>
            ))}
          </Fact>
        )}
        {property.hasDog && <Fact label="On site"><Chip tone="warning">Dog</Chip></Fact>}
        {property.gateCode && <Fact label="Gate">{property.gateCode}</Fact>}
        <Fact label="Units">{property.equipmentCount}</Fact>
      </Facts>

      {readsEquipment ? (
        <Register
          propertyId={id}
          units={register}
          writes={can(user.actor, "equipment:write")}
        />
      ) : (
        <Empty title="Equipment is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      )}
    </div>
  );
}
