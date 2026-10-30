import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as files from "../src/services/files";
import * as notices from "../src/services/staff-notices";
import * as portalFiles from "../src/services/portal-files";
import * as portalSignIn from "../src/services/portal-sign-in";
import * as tasks from "../src/services/tasks";
import * as uploads from "../src/services/customer-uploads";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A CUSTOMER'S UPLOAD FROM THE PORTAL IS NOTICED (M05)
 *
 * A photo or a PDF sent to a job from the customer's account raises one office
 * task a day for the job (however many files that day), tells the job's
 * technicians through the staff notice path once a day, and shows as new on
 * the job until somebody opens it; when everything sent has been opened, the
 * task is finished.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("pun:org");
const OWNER = fixtureId("pun:owner");
const RAY = fixtureId("pun:ray");
const SAM = fixtureId("pun:sam");
const RUN = Date.now().toString(36);
const NINA = `nina.${RUN}@pun.test`;
const SLUG = "portal-upload-noticed-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const person = (userId: string, technicianId: string): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles: ["technician"], technicianId }, db: db(),
});
let rayTech = "";
let samTech = "";
let nina = { id: "", propertyId: "" };
let token = "";
let jobNumber = 7100;
let ipSeq = 0;

const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, marker, RUN.length]).toString("base64");
const pdf = (marker: string) => Buffer.from(`%PDF-1.4\n% ${marker} ${RUN}\n%%EOF\n`).toString("base64");

async function technician(userId: string, name: string): Promise<string> {
  const email = `${name.split(" ")[0]!.toLowerCase()}.${RUN}@pun.test`;
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${email}, ${name})`;
  const [m] = await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw`insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id as string;
}

/** A job with one visit tomorrow, on whoever is named. */
async function aJob(technicianIds: string[]) {
  jobNumber += 1;
  const [job] = await raw`insert into public.job (organization_id, number, customer_id, property_id, summary, status)
    values (${ORG}, ${jobNumber}, ${nina.id}, ${nina.propertyId}, 'No hot water', 'scheduled') returning id`;
  const start = new Date(`${companyToday(1)}T15:00:00Z`);
  const [visit] = await raw`insert into public.visit (organization_id, job_id, status, window_start, window_end)
    values (${ORG}, ${job!.id}, 'scheduled', ${start}, ${new Date(start.getTime() + 7_200_000)}) returning id`;
  for (const id of technicianIds) {
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id) values (${ORG}, ${visit!.id}, ${id})`;
  }
  return { jobId: job!.id as string, visitId: visit!.id as string };
}

const tasksOn = (jobId: string) => raw<{ id: string; title: string; status: string; queue: string | null; outcome: string | null }[]>`
  select id, title, status::text as status, queue, outcome from public.task where organization_id = ${ORG} and entity_id = ${jobId}
  order by created_at`;

const noticesFor = (userId: string) => raw<{ kind: string; title: string; entity_type: string; entity_id: string; href: string }[]>`
  select kind, title, entity_type, entity_id, href from public.staff_notice where organization_id = ${ORG} and user_id = ${userId}
  and kind = 'customer_file' order by created_at`;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Upload Noticed Plumbing", slug: SLUG });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`delete from public.public_rate_limit where key like ${`portal-file:${ORG}:%`}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@pun.test" })})`;
  rayTech = await technician(RAY, "Ray Nunez");
  samTech = await technician(SAM, "Sam Ortiz");
  const c = await customers.create(owner(), {
    type: "residential", name: "Nina Patel", paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {}, email: NINA,
  });
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Birch', 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary) values (${ORG}, ${c.id}, ${p!.id}, true)`;
  nina = { id: c.id, propertyId: p!.id as string };
  await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: NINA }, { ip: `198.51.7.${(ipSeq += 1)}` });
  const [message] = await raw<{ body: string }[]>`select body from public.message where organization_id = ${ORG}
    and to_address = ${NINA} and direction = 'outbound' order by created_at desc limit 1`;
  const code = /\b(\d{6})\b/.exec(message?.body ?? "")?.[1] ?? "";
  const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: NINA, code }, { ip: `198.51.7.${(ipSeq += 1)}` });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  token = verdict.token;
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.public_rate_limit where key like ${`portal-file:${ORG}:%`}`;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("a customer's upload from the portal", () => {
  it("raises one office task a day for the job, however many files, and says how many", async () => {
    const { jobId } = await aJob([rayTech]);
    await portalFiles.add(db(), { token, jobId, fileName: "unit.jpg", contentType: "image/jpeg", bytes: jpeg(1) });
    let raised = await tasksOn(jobId);
    expect(raised).toEqual([expect.objectContaining({ title: `Nina Patel sent a file to job ${jobNumber}`, status: "open", queue: "office" })]);

    await portalFiles.add(db(), { token, jobId, fileName: "plate.jpg", contentType: "image/jpeg", bytes: jpeg(2) });
    await portalFiles.add(db(), { token, jobId, fileName: "warranty.pdf", contentType: "application/pdf", bytes: pdf("w") });
    raised = await tasksOn(jobId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe(`Nina Patel sent 3 files to job ${jobNumber}`);
    const task = await tasks.get(owner(), { id: raised[0]!.id });
    expect(task).toMatchObject({ entityType: "job", entityId: jobId, assigneeUserId: null });
    expect(task.body).toContain("From their account, for the job (No hot water).");

    /** The same bytes again are the file already kept, and raise nothing. */
    await portalFiles.add(db(), { token, jobId, fileName: "unit.jpg", contentType: "image/jpeg", bytes: jpeg(1) });
    expect((await tasksOn(jobId))[0]!.title).toBe(`Nina Patel sent 3 files to job ${jobNumber}`);
    const [day] = await raw`select files, on_day::text as on_day from public.customer_upload_day where job_id = ${jobId}`;
    expect(day).toMatchObject({ files: 3, on_day: companyToday() });
  });

  it("tells the job's technicians once a day, about their own visit, and nobody else", async () => {
    const { jobId, visitId } = await aJob([rayTech]);
    await portalFiles.add(db(), { token, jobId, visitId, fileName: "leak.jpg", contentType: "image/jpeg", bytes: jpeg(10) });
    await portalFiles.add(db(), { token, jobId, visitId, fileName: "leak2.jpg", contentType: "image/jpeg", bytes: jpeg(11) });
    const told = (await noticesFor(RAY)).filter((n) => n.entity_id === visitId);
    expect(told).toEqual([{
      kind: "customer_file", title: `Nina Patel sent a photo for job ${jobNumber}`, entity_type: "visit", entity_id: visitId,
      href: `/my-day?date=${companyToday(1)}`,
    }]);
    expect((await noticesFor(SAM)).filter((n) => n.entity_id === visitId)).toEqual([]);

    /** It is on Ray's bell, opening his day. */
    const bell = await notices.list(person(RAY, rayTech));
    expect(bell.notices.find((n) => n.title === `Nina Patel sent a photo for job ${jobNumber}`)).toMatchObject({
      kindLabel: "A photo or file from a customer", href: `/my-day?date=${companyToday(1)}`,
    });
  });

  it("tells each person on a job's visits still to come, for a file sent to the job", async () => {
    const { jobId, visitId } = await aJob([rayTech, samTech]);
    await portalFiles.add(db(), { token, jobId, fileName: "letter.pdf", contentType: "application/pdf", bytes: pdf("letter") });
    expect((await noticesFor(RAY)).filter((n) => n.entity_id === visitId).map((n) => n.title)).toEqual([`Nina Patel sent a file for job ${jobNumber}`]);
    expect((await noticesFor(SAM)).filter((n) => n.entity_id === visitId)).toHaveLength(1);
  });

  it("shows as new until somebody opens it, and finishes the task once everything sent is opened", async () => {
    const { jobId, visitId } = await aJob([rayTech]);
    const one = await portalFiles.add(db(), { token, jobId, fileName: "a.jpg", contentType: "image/jpeg", bytes: jpeg(20) });
    const two = await portalFiles.add(db(), { token, jobId, visitId, fileName: "b.jpg", contentType: "image/jpeg", bytes: jpeg(21) });
    expect(await uploads.unopenedOnJob(owner(), { jobId })).toBe(2);

    await files.markSeen(owner(), { attachmentId: one.id });
    expect(await uploads.unopenedOnJob(owner(), { jobId })).toBe(1);
    expect((await tasksOn(jobId))[0]!.status).toBe("open");

    await files.markSeen(owner(), { attachmentId: two.id });
    expect(await uploads.unopenedOnJob(owner(), { jobId })).toBe(0);
    expect((await tasksOn(jobId))[0]).toMatchObject({ status: "done", outcome: "Everything the customer sent has been opened." });

    /** Another file the same day, after the task was finished, raises a new one rather than going to a finished task. */
    await portalFiles.add(db(), { token, jobId, fileName: "c.jpg", contentType: "image/jpeg", bytes: jpeg(22) });
    const after = await tasksOn(jobId);
    expect(after.map((t) => [t.status, t.title])).toEqual([
      ["done", `Nina Patel sent 2 files to job ${jobNumber}`],
      ["open", `Nina Patel sent 3 files to job ${jobNumber}`],
    ]);
  });

  it("finishes the task when the customer takes back the only thing waiting to be opened", async () => {
    const { jobId } = await aJob([rayTech]);
    const sent = await portalFiles.add(db(), { token, jobId, fileName: "wrong.pdf", contentType: "application/pdf", bytes: pdf("wrong") });
    expect((await tasksOn(jobId))[0]!.status).toBe("open");
    await portalFiles.remove(db(), { token, id: sent.id });
    expect((await tasksOn(jobId))[0]).toMatchObject({
      status: "done", outcome: "The customer took back what they sent, and nothing else is waiting to be opened.",
    });
    expect(await uploads.unopenedOnJob(owner(), { jobId })).toBe(0);
  });
});
