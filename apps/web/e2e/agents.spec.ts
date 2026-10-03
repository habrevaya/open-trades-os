import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq } from "drizzle-orm";
import { test, expect, run } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * THE AI AGENTS, THROUGH THE SCREENS
 *
 * An owner turns the intake agent on in Settings, a text arrives, the office
 * asks the agent to read it from the conversation, and books what it drafted
 * with one click. Then the website chat: turned on in Settings, it appears on
 * the website test page through the ordinary snippet, says it is automated,
 * and takes a booking request in a real window.
 *
 * The model is the one thing faked, at its edge only: the company's Anthropic
 * connection is pointed at a local server that speaks the Messages API, the
 * same way the Stripe and Twilio specs point those adapters at theirs.
 * Everything between the screen and that server is the product.
 */

interface FakeModel { baseUrl: string; asked: string[][]; close(): Promise<void> }

const WINDOW = /"bookableServiceId": "([^"]+)",\s*"date": "([^"]+)",\s*"arrivalWindowId": "([^"]+)"/;

function answer(tools: string[], prompt: string): { name: string; input: Record<string, unknown> } {
  const open = WINDOW.exec(prompt);
  if (tools.includes("propose_booking") && open) {
    return {
      name: "propose_booking",
      input: {
        contactName: `Dana E2E ${run}`, phone: "+15125550177",
        address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" },
        problemSummary: "Water heater leaking in the garage.",
        bookableServiceId: open[1], urgency: "soon",
        windows: [{ date: open[2], arrivalWindowId: open[3] }],
      },
    };
  }
  if (tools.includes("create_booking_request")) {
    const said = [...prompt.matchAll(/<customer>\n([\s\S]*?)\n<\/customer>/g)].map((m) => m[1]!);
    const last = said.at(-1) ?? "";
    if (/book/i.test(last) && open) {
      return {
        name: "create_booking_request",
        input: {
          bookableServiceId: open[1], date: open[2], arrivalWindowId: open[3],
          contactName: `Robin E2E ${run}`, phone: "+15125550178",
          address: { line1: "77 Lake Dr", city: "Austin", state: "TX", postalCode: "78705" },
          notes: "Tune up before winter.",
          text: "Done. The office will confirm your booking shortly.",
        },
      };
    }
    return { name: "reply", input: { text: "We can help with that. Would you like to book a visit?" } };
  }
  return { name: "not_a_booking", input: { reason: "The fake had nothing to say." } };
}

/** Anthropic's Messages API on localhost: a tool call, worked out from what the agent was told. */
async function fakeModel(): Promise<FakeModel> {
  const asked: string[][] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "POST" && request.url === "/v1/messages") {
        const sent = JSON.parse(body) as {
          model: string; tools?: { name: string }[];
          messages: { content: { type: string; text?: string }[] }[];
        };
        const tools = (sent.tools ?? []).map((t) => t.name);
        asked.push(tools);
        const prompt = sent.messages.flatMap((m) => m.content).map((c) => c.text ?? "").join("\n");
        const call = answer(tools, prompt);
        return json(200, {
          id: `msg_${asked.length}`, model: sent.model, role: "assistant", type: "message",
          content: [{ type: "tool_use", id: `toolu_${asked.length}`, name: call.name, input: call.input }],
          stop_reason: "tool_use", usage: { input_tokens: 420, output_tokens: 60 },
        });
      }
      json(404, { error: { type: "not_found", message: `The fake has no ${request.method} ${request.url}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`, asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function organizationId(): Promise<string> {
  const db = createClient();
  try {
    const [org] = await db.select({ id: schema.organization.id }).from(schema.organization)
      .where(eq(schema.organization.slug, "ridgeline")).limit(1);
    return org!.id;
  } finally {
    await db.$close();
  }
}

/** The company's own model connection, pointed at the fake. */
async function connectModel(baseUrl: string): Promise<void> {
  const db = createClient();
  try {
    const org = await organizationId();
    const settings = { defaultModel: "claude-haiku-4-5", baseUrl };
    await db.insert(schema.integrationConnection).values({
      organizationId: org, capability: "ai_model", provider: "anthropic", status: "connected",
      credentialRef: "E2E_AI_KEY", settings,
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: { status: "connected", credentialRef: "E2E_AI_KEY", settings },
    });
  } finally {
    await db.$close();
  }
}

/** Everything off again, so the specs after this see the company as the seed left it. */
async function disconnectModel(): Promise<void> {
  const db = createClient();
  try {
    const org = await organizationId();
    await db.update(schema.integrationConnection).set({ status: "disconnected" })
      .where(and(eq(schema.integrationConnection.organizationId, org), eq(schema.integrationConnection.capability, "ai_model")));
    await db.delete(schema.aiAgentSetting).where(eq(schema.aiAgentSetting.organizationId, org));
  } finally {
    await db.$close();
  }
}

async function inboundText(from: string, body: string): Promise<string> {
  const db = createClient();
  try {
    const org = await organizationId();
    const [conversation] = await db.insert(schema.conversation).values({
      organizationId: org, channel: "sms", externalAddress: from, status: "open",
      lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 200), unreadCount: 1,
    }).returning({ id: schema.conversation.id });
    await db.insert(schema.message).values({
      organizationId: org, conversationId: conversation!.id, direction: "inbound", channel: "sms",
      fromAddress: from, toAddress: "+15125550100", body, status: "received",
    });
    return conversation!.id;
  } finally {
    await db.$close();
  }
}

/** Turn one agent on from its card on Settings, acting as the owner. */
async function turnOn(owner: Page, label: string): Promise<void> {
  await owner.goto("/settings/agents");
  const card = owner.getByRole("region", { name: label, exact: true });
  await card.getByLabel("On", { exact: true }).check();
  const options = await card.getByLabel("Acts as").locator("option").allTextContents();
  const me = options.find((text) => text.includes("(Owner)"));
  expect(me, "the owner is somebody an agent can act as").toBeTruthy();
  await card.getByLabel("Acts as").selectOption({ label: me! });
  await card.getByRole("button", { name: `Save ${label.toLowerCase()}` }).click();
  await expect(card.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(card.getByText("On", { exact: true }).first()).toBeVisible();
}

test.describe("the AI agents", () => {
  let model: FakeModel;

  test.beforeAll(async () => {
    model = await fakeModel();
    await connectModel(model.baseUrl);
  });
  test.afterAll(async () => {
    await disconnectModel();
    await model.close();
  });

  test("the intake agent drafts a booking from a text and the office books it in one click", async ({ owner }) => {
    await turnOn(owner, "Intake");
    const conversationId = await inboundText(`+1512${String(Date.now()).slice(-7)}`,
      "Hi, water heater is leaking all over the garage. 12 Elm St Austin TX 78701. Dana");

    await owner.goto(`/inbox/${conversationId}`);
    await owner.getByRole("button", { name: "Draft a booking from this" }).click();
    const draft = owner.getByRole("article", { name: `Booking draft for Dana E2E ${run}` });
    await expect(draft).toBeVisible();
    await expect(draft.getByText("Water heater leaking in the garage.")).toBeVisible();
    await expect(draft.getByText("drafted by the intake agent")).toBeVisible();
    expect(model.asked.at(-1)).toEqual(["propose_booking", "not_a_booking"]);

    // It is on the office's list too.
    await owner.goto("/inbox/drafts");
    await expect(owner.getByRole("article", { name: `Booking draft for Dana E2E ${run}` })).toBeVisible();

    // One click from the conversation.
    await owner.goto(`/inbox/${conversationId}`);
    await owner.getByRole("article", { name: `Booking draft for Dana E2E ${run}` })
      .getByRole("button", { name: "Book it" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Booked. The job is on the board." })).toBeVisible();
    await owner.getByRole("link", { name: "Open the job" }).click();
    await expect(owner.getByText("Water heater leaking in the garage.").first()).toBeVisible();

    // And the agent's log says who decided.
    await owner.goto("/settings/agents?agent=intake");
    await expect(owner.getByRole("listitem").filter({ hasText: `Booked Dana E2E ${run}` })).toBeVisible();
  });

  test("the website chat says it is automated and takes a booking request in a real window", async ({ owner }) => {
    await turnOn(owner, "Website and text chat");

    // Through the ordinary snippet, on the page that loads it exactly as a website would.
    await owner.goto("/settings/website/test");
    const button = owner.locator('[data-ot-chat="button"]');
    await expect(button).toBeVisible();
    await button.click();
    const messages = owner.locator('[data-ot-chat="messages"]');
    await expect(messages.locator('[data-ot-chat="message"]').first()).toContainText("automated assistant");

    await owner.locator('[data-ot-chat="input"]').fill("Do you do tune ups?");
    await owner.locator('[data-ot-chat="send"]').click();
    await expect(messages).toContainText("Would you like to book a visit?");

    await owner.locator('[data-ot-chat="input"]').fill(`Yes please book me in, Robin E2E ${run}, 77 Lake Dr Austin TX 78705, 512 555 0178`);
    await owner.locator('[data-ot-chat="send"]').click();
    await expect(messages).toContainText("Done. The office will confirm your booking shortly.");

    const db = createClient();
    try {
      const [request] = await db.select({ status: schema.bookingRequest.status })
        .from(schema.bookingRequest).where(eq(schema.bookingRequest.contactName, `Robin E2E ${run}`)).limit(1);
      expect(request?.status).toBe("pending");
    } finally {
      await db.$close();
    }

    // The office sees the whole chat in the inbox, and books the request in one click.
    await owner.goto("/inbox");
    await expect(owner.getByText("Website chat").first()).toBeVisible();
    await owner.goto("/inbox/drafts");
    await owner.getByRole("listitem", { name: `Booking request from Robin E2E ${run}` })
      .getByRole("button", { name: "Book it" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Booked. The job is on the board." })).toBeVisible();
  });
});
