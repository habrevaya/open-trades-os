"use client";

import { useActionState, useState } from "react";
import { Chip, Phone } from "@opentradesos/ui";
import { addContact, removeContact, makePrimary } from "./actions";

const BUTTON =
  "inline-flex h-8 items-center rounded border border-steel-300 px-3 text-sm hover:bg-steel-100 disabled:opacity-60";
const FIELD = "h-8 rounded border border-steel-300 px-2 text-sm";

export interface ContactRow {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  propertyId: string | null;
  isPrimary: boolean;
  preferredChannel: string;
  noticeRank: number;
}

/**
 * THE PEOPLE AT THE ADDRESS
 *
 * The list is ordered the way the on my way text picks a recipient, not
 * alphabetically, and the first row says so out loud. That ordering is the
 * only reason this screen is worth opening: somebody adding a tenant needs to
 * know whether the tenant is now the person who gets told, and working that
 * out from a rule described in a tooltip is not knowing it.
 *
 * WHICH PROPERTY IS A CHOICE, AND DEFAULTS TO NONE. A contact on the customer
 * is the office manager for all forty addresses; a contact on a property is
 * the person who opens that one door. Defaulting to the first property would
 * quietly make every manager a tenant of whichever address happened to sort
 * first.
 */
export function Contacts({
  customerId, contacts, properties,
}: {
  customerId: string;
  contacts: ContactRow[];
  properties: { id: string; label: string }[];
}) {
  const [addState, add, adding] = useActionState(addContact, null);
  const [removeState, remove, removing] = useActionState(removeContact, null);
  const [primaryState, primary, promoting] = useActionState(makePrimary, null);
  const [open, setOpen] = useState(false);

  const error = [addState, removeState, primaryState]
    .map((state) => (state && "error" in state ? state.error : null))
    .find(Boolean);

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">People</h2>
        <button type="button" onClick={() => setOpen((was) => !was)} className={BUTTON}>
          {open ? "Cancel" : "Add somebody"}
        </button>
      </div>

      {contacts.length === 0 ? (
        <p className="mt-2 max-w-prose text-sm text-ink-700">
          Nobody on file but the customer themselves, so every &ldquo;on the
          way&rdquo; text goes to the number on their record. On a rental that
          is the landlord rather than whoever is standing at the door.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {contacts.map((contact, index) => (
            <li key={contact.id} className="flex flex-wrap items-baseline gap-2 bg-canvas p-3">
              <span className="font-medium text-ink-900">{contact.name}</span>
              {contact.title && <span className="text-sm text-ink-500">{contact.title}</span>}
              {contact.propertyId
                ? <Chip tone="info">At a property</Chip>
                : <Chip tone="neutral">Customer wide</Chip>}
              {contact.isPrimary && <Chip tone="neutral">Primary</Chip>}
              {/*
                Said on the row rather than implied by its position. Somebody
                scanning this needs to know who hears from us, and "first in
                the list" is a thing people stop noticing.
              */}
              {index === 0 && <Chip tone="success">Gets the text</Chip>}
              {contact.phone && <span className="text-sm text-ink-700"><Phone value={contact.phone} /></span>}
              {contact.email && <span className="text-sm text-ink-700">{contact.email}</span>}
              <span className="text-xs text-ink-500">prefers {contact.preferredChannel}</span>

              <span className="ml-auto flex gap-2">
                {!contact.isPrimary && (
                  <form action={primary}>
                    <input type="hidden" name="customerId" value={customerId} />
                    <input type="hidden" name="id" value={contact.id} />
                    <button type="submit" disabled={promoting} className={BUTTON}>
                      Make primary
                    </button>
                  </form>
                )}
                <form action={remove}>
                  <input type="hidden" name="customerId" value={customerId} />
                  <input type="hidden" name="id" value={contact.id} />
                  <button type="submit" disabled={removing} className={BUTTON}>
                    {removing ? "Removing" : "Remove"}
                  </button>
                </form>
              </span>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form action={add} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-steel-200 p-3">
          <input type="hidden" name="customerId" value={customerId} />
          <div>
            <label htmlFor="c-name" className="block text-xs text-ink-500">Name</label>
            <input id="c-name" name="name" required className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="c-title" className="block text-xs text-ink-500">Role, if any</label>
            <input id="c-title" name="title" placeholder="Tenant, site manager"
                   className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="c-phone" className="block text-xs text-ink-500">Phone</label>
            <input id="c-phone" name="phone" type="tel" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="c-email" className="block text-xs text-ink-500">Email</label>
            <input id="c-email" name="email" type="email" className={`mt-1 ${FIELD}`} />
          </div>
          <div>
            <label htmlFor="c-property" className="block text-xs text-ink-500">Where</label>
            <select id="c-property" name="propertyId" className={`mt-1 ${FIELD}`} defaultValue="">
              {/*
                Empty by default. A contact on the customer covers every
                address; picking one means this person is only about that
                door, which is the more specific claim and so the one somebody
                should have to make.
              */}
              <option value="">Everything this customer has</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>{property.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="c-channel" className="block text-xs text-ink-500">Prefers</label>
            <select id="c-channel" name="preferredChannel" className={`mt-1 ${FIELD}`}>
              <option value="sms">Text</option>
              <option value="email">Email</option>
              <option value="voice">A call</option>
            </select>
          </div>
          <button type="submit" disabled={adding} className={BUTTON}>
            {adding ? "Adding" : "Add"}
          </button>
        </form>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
