import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms, voice, type telephony } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";

/**
 * PHONE MENUS, RING GROUPS AND WHO ANSWERS
 *
 * What a company sets up so its own number answers like an office: "press 1
 * for service, 2 for billing", a group of phones that ring together or in
 * turn, and the number each person answers the company's calls on. The
 * carrier's side of a call (what is said, who is rung) is `voice.ts`; this
 * file is what those are, saved and checked.
 *
 * EVERY SAVE IS CHECKED AGAINST WHAT EXISTS, by core's `checkMenu` and
 * `checkRingGroup` with a directory read in the same transaction. A menu
 * pointing at a ring group somebody deleted rings nothing at two in the
 * morning, and the only person who finds out is the customer. So a delete
 * that something still points at is refused, naming what points at it, and
 * a call that reaches a destination deleted anyway (by a race, or by hand in
 * the database) goes to voicemail with the reason written on the call.
 *
 * ON PERMISSIONS. Reading these is `settings:read` and changing them is
 * `settings:write`, the same as how a number rings: where the company's
 * calls go is a standing decision about the company, made by whoever runs
 * it, not by whoever answers the phone.
 */

type Destination = telephony.RoutingDestination;

/* -------------------------------------------------------------- directory */

/**
 * Everything a destination can name, read once for a save or a call.
 *
 * People come through `app.organization_people()`, because the user table's
 * own policy shows a user their own row and nothing else; their numbers come
 * from `answering_phone`, which is the company's record of where it rings
 * them rather than anything on their account.
 */
export async function directoryFor(tx: Database, organizationId: string): Promise<voice.Directory> {
  const menus = await tx.select({ id: schema.phoneMenu.id, name: schema.phoneMenu.name })
    .from(schema.phoneMenu).where(eq(schema.phoneMenu.organizationId, organizationId));
  const groups = await tx.select({ id: schema.ringGroup.id, name: schema.ringGroup.name })
    .from(schema.ringGroup).where(eq(schema.ringGroup.organizationId, organizationId));
  const units = await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
    .from(schema.businessUnit)
    .where(and(eq(schema.businessUnit.organizationId, organizationId), eq(schema.businessUnit.active, true)));
  const people = await peopleOf(tx, organizationId);

  return {
    menus: new Map(menus.map((m) => [m.id, m.name])),
    ringGroups: new Map(groups.map((g) => [g.id, g.name])),
    people: new Map(people.map((p) => [p.userId, { name: p.name, phone: p.phone }])),
    rotas: new Map(units.map((u) => [u.id, u.name])),
  };
}

export interface Person {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
}

/** Active members of the company, with the number calls ring them on. */
async function peopleOf(tx: Database, organizationId: string): Promise<Person[]> {
  const rows = await tx.execute<{ user_id: string; name: string | null; email: string; active: boolean }>(sql`
    select p.user_id, p.name, p.email, m.active
    from app.organization_people() p
    join public.membership m on m.id = p.membership_id
    where m.active
  `);
  const phones = await tx.select({ userId: schema.answeringPhone.userId, e164: schema.answeringPhone.e164 })
    .from(schema.answeringPhone).where(eq(schema.answeringPhone.organizationId, organizationId));
  const byUser = new Map(phones.map((p) => [p.userId, p.e164]));
  return rows
    .map((row) => ({
      userId: row.user_id,
      name: row.name?.trim() || row.email,
      email: row.email,
      phone: byUser.get(row.user_id) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ menus */

export interface MenuView {
  id: string;
  name: string;
  greeting: string;
  options: { key: string; label: string; to: Destination }[];
  noInputTo: Destination;
  afterHoursTo: Destination | null;
  timeoutSeconds: number;
  /** What the caller hears, assembled exactly as the call will say it. */
  prompt: string;
  /** The numbers this menu answers. */
  numbers: { id: string; e164: string; label: string | null }[];
}

const menuOf = (row: typeof schema.phoneMenu.$inferSelect): voice.PhoneMenu => ({
  id: row.id,
  name: row.name,
  greeting: row.greeting,
  options: row.options as voice.MenuOption[],
  noInputTo: row.noInputTo as Destination,
  afterHoursTo: (row.afterHoursTo ?? null) as Destination | null,
  timeoutSeconds: row.timeoutSeconds,
});

async function numbersByMenu(tx: Database) {
  const rows = await tx.select({
    id: schema.phoneNumber.id, e164: schema.phoneNumber.e164, label: schema.phoneNumber.label,
    menuId: schema.phoneNumber.menuId,
  }).from(schema.phoneNumber)
    .where(and(sql`${schema.phoneNumber.menuId} is not null`, sql`${schema.phoneNumber.releasedAt} is null`));
  const by = new Map<string, { id: string; e164: string; label: string | null }[]>();
  for (const row of rows) {
    const list = by.get(row.menuId!) ?? [];
    list.push({ id: row.id, e164: row.e164, label: row.label });
    by.set(row.menuId!, list);
  }
  return by;
}

const viewOf = (menu: voice.PhoneMenu, numbers: MenuView["numbers"]): MenuView => ({
  ...menu,
  options: [...menu.options],
  prompt: voice.menuPrompt(menu),
  numbers,
});

export async function listMenus(ctx: ServiceContext): Promise<MenuView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.phoneMenu)
      .where(eq(schema.phoneMenu.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.phoneMenu.name));
    const numbers = await numbersByMenu(tx);
    return rows.map((row) => viewOf(menuOf(row), numbers.get(row.id) ?? []));
  });
}

export async function getMenu(ctx: ServiceContext, id: string): Promise<MenuView> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const row = await menuRow(tx, ctx.actor.organizationId, id);
    if (!row) throw new NotFoundError("Phone menu");
    const numbers = await numbersByMenu(tx);
    return viewOf(menuOf(row), numbers.get(row.id) ?? []);
  });
}

/** One menu, as the webhook reads it mid call. Null when it has been deleted. */
export async function menuRow(tx: Database, organizationId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx.select().from(schema.phoneMenu)
    .where(and(eq(schema.phoneMenu.organizationId, organizationId), eq(schema.phoneMenu.id, id))).limit(1);
  return row ?? null;
}

export async function loadMenu(tx: Database, organizationId: string, id: string): Promise<voice.PhoneMenu | null> {
  const row = await menuRow(tx, organizationId, id);
  return row ? menuOf(row) : null;
}

export interface MenuInput {
  name: string;
  greeting: string;
  options: { key: string; label: string; to: Destination }[];
  noInputTo: Destination;
  afterHoursTo?: Destination | null | undefined;
  timeoutSeconds?: number | undefined;
}

/** The voicemail box is one box today, whatever a caller sent. */
const normal = (to: Destination): Destination => to.kind === "voicemail" ? { kind: "voicemail", box: "main" } : to;

function proposed(id: string, input: MenuInput): voice.PhoneMenu {
  return {
    id,
    name: input.name.trim(),
    greeting: input.greeting.trim(),
    options: input.options.map((o) => ({ key: o.key.trim(), label: o.label.trim(), to: normal(o.to) })),
    noInputTo: normal(input.noInputTo),
    afterHoursTo: input.afterHoursTo ? normal(input.afterHoursTo) : null,
    timeoutSeconds: input.timeoutSeconds ?? 6,
  };
}

/**
 * Save a menu, new or changed.
 *
 * The id is chosen before the check rather than by the insert, so a new
 * menu whose "repeat" option points at itself is checked against itself:
 * the directory the check reads has the menu in it by name.
 */
export async function saveMenu(ctx: ServiceContext, input: MenuInput & { id?: string | undefined }): Promise<MenuView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const creating = !input.id;
    if (creating) {
      const again = await replayed<{ id: string }>(tx, ctx, "phone_menu");
      if (again) {
        const row = await menuRow(tx, ctx.actor.organizationId, again.id);
        if (row) return viewOf(menuOf(row), (await numbersByMenu(tx)).get(row.id) ?? []);
      }
    }
    const id = input.id ?? randomUUID();
    const before = creating ? null : await menuRow(tx, ctx.actor.organizationId, id);
    if (!creating && !before) throw new NotFoundError("Phone menu");

    const menu = proposed(id, input);
    const directory = await directoryFor(tx, ctx.actor.organizationId);
    (directory.menus as Map<string, string>).set(id, menu.name || "this");
    const verdict = voice.checkMenu(menu, directory);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const values = {
      name: menu.name, greeting: menu.greeting, options: menu.options as never,
      noInputTo: menu.noInputTo as never, afterHoursTo: menu.afterHoursTo as never,
      timeoutSeconds: menu.timeoutSeconds,
    };
    const [row] = creating
      ? await tx.insert(schema.phoneMenu).values({ id, organizationId: ctx.actor.organizationId, ...values }).returning()
      : await tx.update(schema.phoneMenu).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.phoneMenu.id, id)).returning();

    await audit(tx, ctx, creating ? "phone_menu.created" : "phone_menu.changed", "phone_menu", id, before, row!);
    if (creating) await remember(tx, ctx, "phone_menu", id, { id });
    return viewOf(menuOf(row!), (await numbersByMenu(tx)).get(id) ?? []);
  });
}

/**
 * What points at a menu or a ring group, in words, for a delete that would
 * strand it.
 */
async function usedBy(tx: Database, organizationId: string, target: Destination): Promise<string[]> {
  const same = (to: Destination | null | undefined) => {
    if (!to) return false;
    if (target.kind === "ivr") return to.kind === "ivr" && to.menu === target.menu;
    if (target.kind === "ring_group") return to.kind === "ring_group" && to.id === target.id;
    return false;
  };
  const found: string[] = [];
  const menus = await tx.select().from(schema.phoneMenu).where(eq(schema.phoneMenu.organizationId, organizationId));
  for (const row of menus) {
    const menu = menuOf(row);
    if (target.kind === "ivr" && menu.id === target.menu) continue;
    if (menu.options.some((o) => same(o.to)) || same(menu.noInputTo) || same(menu.afterHoursTo)) {
      found.push(`the ${menu.name} menu`);
    }
  }
  const groups = await tx.select().from(schema.ringGroup).where(eq(schema.ringGroup.organizationId, organizationId));
  for (const group of groups) {
    if (target.kind === "ring_group" && group.id === target.id) continue;
    if (same(group.noAnswerTo as Destination)) found.push(`the ${group.name} ring group`);
  }
  if (target.kind === "ivr") {
    const numbers = await tx.select({ e164: schema.phoneNumber.e164 }).from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.menuId, target.menu), sql`${schema.phoneNumber.releasedAt} is null`));
    for (const n of numbers) found.push(`the number ${n.e164}`);
  }
  return found;
}

/**
 * Delete a menu. Refused while anything still sends calls to it, naming
 * what, because the alternative is a number that answers with silence.
 */
export async function deleteMenu(ctx: ServiceContext, id: string) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const row = await menuRow(tx, ctx.actor.organizationId, id);
    if (!row) throw new NotFoundError("Phone menu");
    const users = await usedBy(tx, ctx.actor.organizationId, { kind: "ivr", menu: id });
    if (users.length > 0) {
      throw new ConflictError(`Calls still go to this menu from ${users.join(", ")}. Change those first.`);
    }
    await tx.delete(schema.phoneMenu).where(eq(schema.phoneMenu.id, id));
    await audit(tx, ctx, "phone_menu.deleted", "phone_menu", id, row, null);
    return { id, deleted: true as const };
  });
}

/* ------------------------------------------------------------ ring groups */

export interface RingGroupView {
  id: string;
  name: string;
  strategy: voice.RingStrategy;
  ringSeconds: number;
  members: { userId: string | null; e164: string | null; label: string }[];
  noAnswerTo: Destination;
}

const groupOf = (row: typeof schema.ringGroup.$inferSelect): voice.RingGroup => ({
  id: row.id,
  name: row.name,
  strategy: row.strategy as voice.RingStrategy,
  ringSeconds: row.ringSeconds,
  members: row.members,
  noAnswerTo: row.noAnswerTo as Destination,
});

const groupView = (group: voice.RingGroup): RingGroupView => ({
  ...group,
  members: group.members.map((m) => ({ userId: m.userId ?? null, e164: m.e164 ?? null, label: m.label })),
});

export async function listRingGroups(ctx: ServiceContext): Promise<RingGroupView[]> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.ringGroup)
      .where(eq(schema.ringGroup.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.ringGroup.name));
    return rows.map((row) => groupView(groupOf(row)));
  });
}

export async function loadRingGroup(tx: Database, organizationId: string, id: string): Promise<voice.RingGroup | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx.select().from(schema.ringGroup)
    .where(and(eq(schema.ringGroup.organizationId, organizationId), eq(schema.ringGroup.id, id))).limit(1);
  return row ? groupOf(row) : null;
}

export interface RingGroupInput {
  name: string;
  strategy: voice.RingStrategy;
  ringSeconds?: number | undefined;
  members: { userId?: string | null | undefined; e164?: string | null | undefined; label?: string | undefined }[];
  noAnswerTo: Destination;
}

export async function saveRingGroup(
  ctx: ServiceContext, input: RingGroupInput & { id?: string | undefined },
): Promise<RingGroupView> {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const creating = !input.id;
    if (creating) {
      const again = await replayed<{ id: string }>(tx, ctx, "ring_group");
      if (again) {
        const found = await loadRingGroup(tx, ctx.actor.organizationId, again.id);
        if (found) return groupView(found);
      }
    }
    const id = input.id ?? randomUUID();
    const before = creating ? null : await loadRingGroup(tx, ctx.actor.organizationId, id);
    if (!creating && !before) throw new NotFoundError("Ring group");

    const directory = await directoryFor(tx, ctx.actor.organizationId);
    (directory.ringGroups as Map<string, string>).set(id, input.name.trim() || "this");
    const group: voice.RingGroup = {
      id,
      name: input.name.trim(),
      strategy: input.strategy,
      ringSeconds: input.ringSeconds ?? 20,
      /**
       * A person's label is their name as the company knows it today,
       * written down so a group still reads sensibly in the audit after
       * they have left.
       */
      members: input.members.map((m) => {
        const e164 = m.e164 ? comms.phoneAddress(m.e164) : null;
        const userId = m.userId || null;
        const label = m.label?.trim()
          || (userId ? directory.people.get(userId)?.name : null)
          || e164 || "";
        return { userId, e164, label };
      }),
      noAnswerTo: normal(input.noAnswerTo),
    };
    const verdict = voice.checkRingGroup(group, directory);
    if (!verdict.ok) throw new ConflictError(verdict.reason);

    const values = {
      name: group.name, strategy: group.strategy, ringSeconds: group.ringSeconds,
      members: group.members.map((m) => ({ userId: m.userId ?? null, e164: m.e164 ?? null, label: m.label })),
      noAnswerTo: group.noAnswerTo as never,
    };
    const [row] = creating
      ? await tx.insert(schema.ringGroup).values({ id, organizationId: ctx.actor.organizationId, ...values }).returning()
      : await tx.update(schema.ringGroup).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.ringGroup.id, id)).returning();

    await audit(tx, ctx, creating ? "ring_group.created" : "ring_group.changed", "ring_group", id, before, row!);
    if (creating) await remember(tx, ctx, "ring_group", id, { id });
    return groupView(groupOf(row!));
  });
}

export async function deleteRingGroup(ctx: ServiceContext, id: string) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const group = await loadRingGroup(tx, ctx.actor.organizationId, id);
    if (!group) throw new NotFoundError("Ring group");
    const users = await usedBy(tx, ctx.actor.organizationId, { kind: "ring_group", id });
    if (users.length > 0) {
      throw new ConflictError(`Calls still ring this group from ${users.join(", ")}. Change those first.`);
    }
    await tx.delete(schema.ringGroup).where(eq(schema.ringGroup.id, id));
    await audit(tx, ctx, "ring_group.deleted", "ring_group", id, group, null);
    return { id, deleted: true as const };
  });
}

/* ------------------------------------------------------------ who answers */

export async function listPeople(ctx: ServiceContext): Promise<Person[]> {
  return guardedRead(ctx, "settings:read", (tx) => peopleOf(tx, ctx.actor.organizationId));
}

/**
 * The number a person answers the company's calls on, or none.
 *
 * Taking a number away is refused while a menu or group would be left
 * ringing that person with nothing to ring, for the same reason a menu
 * cannot be deleted from under a number.
 */
export async function setAnsweringPhone(ctx: ServiceContext, input: { userId: string; e164: string | null }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const people = await peopleOf(tx, ctx.actor.organizationId);
    const person = people.find((p) => p.userId === input.userId);
    if (!person) throw new NotFoundError("Person");

    if (input.e164 === null || input.e164.trim() === "") {
      const directory = await directoryFor(tx, ctx.actor.organizationId);
      (directory.people as Map<string, { name: string; phone: string | null }>)
        .set(person.userId, { name: person.name, phone: null });
      const menus = await tx.select().from(schema.phoneMenu).where(eq(schema.phoneMenu.organizationId, ctx.actor.organizationId));
      for (const row of menus) {
        const verdict = voice.checkMenu(menuOf(row), directory);
        if (!verdict.ok) {
          throw new ConflictError(`The ${row.name} menu still rings ${person.name}. Change it before taking their number away.`);
        }
      }
      await tx.delete(schema.answeringPhone).where(and(
        eq(schema.answeringPhone.organizationId, ctx.actor.organizationId),
        eq(schema.answeringPhone.userId, input.userId),
      ));
      await audit(tx, ctx, "answering_phone.cleared", "user", input.userId, { e164: person.phone }, null);
      return { ...person, phone: null };
    }

    const e164 = comms.phoneAddress(input.e164);
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      throw new ConflictError(`"${input.e164}" is not a number a phone can dial. Write it like (512) 555-0147 or +15125550147.`);
    }
    await tx.insert(schema.answeringPhone).values({
      organizationId: ctx.actor.organizationId, userId: input.userId, e164,
    }).onConflictDoUpdate({
      target: [schema.answeringPhone.organizationId, schema.answeringPhone.userId],
      set: { e164, updatedAt: new Date() },
    });
    await audit(tx, ctx, "answering_phone.set", "user", input.userId, { e164: person.phone }, { e164 });
    return { ...person, phone: e164 };
  });
}

/* --------------------------------------------------------------- handlers */

const menuInput = (input: {
  name: string; greeting: string; options: { key: string; label: string; to: Destination }[];
  noInputTo: Destination; afterHoursTo?: Destination | null | undefined; timeoutSeconds?: number | undefined;
}): MenuInput => ({
  name: input.name, greeting: input.greeting, options: input.options, noInputTo: input.noInputTo,
  afterHoursTo: input.afterHoursTo ?? null,
  ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
});

export const handlers = {
  listPhoneMenus: async (ctx: ServiceContext) => ({ menus: await listMenus(ctx) }),
  getPhoneMenu: (ctx: ServiceContext, input: { id: string }) => getMenu(ctx, input.id),
  createPhoneMenu: (ctx: ServiceContext, input: Parameters<typeof menuInput>[0]) => saveMenu(ctx, menuInput(input)),
  updatePhoneMenu: (ctx: ServiceContext, input: Parameters<typeof menuInput>[0] & { id: string }) =>
    saveMenu(ctx, { ...menuInput(input), id: input.id }),
  deletePhoneMenu: (ctx: ServiceContext, input: { id: string }) => deleteMenu(ctx, input.id),

  listRingGroups: async (ctx: ServiceContext) => ({ ringGroups: await listRingGroups(ctx) }),
  createRingGroup: (ctx: ServiceContext, input: RingGroupInput) => saveRingGroup(ctx, input),
  updateRingGroup: (ctx: ServiceContext, input: RingGroupInput & { id: string }) => saveRingGroup(ctx, input),
  deleteRingGroup: (ctx: ServiceContext, input: { id: string }) => deleteRingGroup(ctx, input.id),

  listAnsweringPhones: async (ctx: ServiceContext) => ({ people: await listPeople(ctx) }),
  setAnsweringPhone: (ctx: ServiceContext, input: { userId: string; e164: string | null }) =>
    setAnsweringPhone(ctx, input),
} as const;
