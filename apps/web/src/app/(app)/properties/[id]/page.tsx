import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { properties, equipment as equipmentService, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { Register } from "./Register";
import { PinEditor } from "@/components/PinEditor";
import { tileSource } from "@/lib/map-tiles";
import { placePropertyPin, clearPropertyPin } from "./actions";

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

      {can(user.actor, "job:write") && property.customers.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-2">
          {property.customers.map((link) => (
            <a key={link.id} href={`/jobs/new?customer=${link.id}&property=${id}`}
               className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
              {property.customers.length === 1 ? "Book a job here" : `Book a job here for ${link.name}`}
            </a>
          ))}
        </p>
      )}

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

      {/*
        Where it is. A pin the geocoder could not place, or placed in the
        middle of a postcode, is fixed here by hand, and the dispatch map's
        "not on the map yet" list links straight to this section.
      */}
      <section id="pin" aria-label="Where it is" className="mt-8">
        <h2 className="text-base font-semibold">Where it is</h2>
        <div className="mt-2">
          <PinEditor
            id={id}
            label={property.address.line1}
            tiles={tileSource()}
            current={{
              latitude: property.latitude, longitude: property.longitude,
              precision: property.locationPrecision, source: property.locationSource,
            }}
            place={can(user.actor, "property:write") ? placePropertyPin : null}
            clear={can(user.actor, "property:write") ? clearPropertyPin : null}
          />
        </div>
      </section>

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
