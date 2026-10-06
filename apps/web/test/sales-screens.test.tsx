import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalView, type ProposalData } from "../src/components/Proposal";
import { Deliveries } from "../src/app/(app)/estimates/[id]/Panels";
import { PlanFields } from "../src/app/(app)/agreements/plans/PlanFields";
import { planFromForm } from "../src/lib/plan-form";

/**
 * THE SELL PATH ON A SCREEN: the proposal a customer prints, what became of
 * each send, and the plan form an owner fills in.
 */
const line = (over: Partial<ProposalData["options"][number]["lines"][number]> = {}) => ({
  id: "l", name: "Condenser", description: null, quantity: "1.0000", unitPrice: "3400.0000",
  lineTotal: "3400.0000", discountAmount: "0", memberDiscountAmount: "0", memberPlan: null,
  isOptional: false, isSelected: false, ...over,
});

const proposal = (over: Partial<ProposalData> = {}): ProposalData => ({
  company: { name: "Ridgeline Air", legalName: null, color: "#0f766e", on: "#ffffff", text: "#0f766e", hasLogo: true, version: 1, timezone: "America/Chicago" },
  number: 1042, title: "Cooling", status: "sent", issuedOn: "2026-06-01", expiresOn: "2026-07-01",
  decidedAt: null, signerName: null, selectedOptionId: null,
  customerName: "Nina Patel", propertyAddress: "88 Ridge Rd, Austin, TX 78704",
  terms: "Prices hold for 30 days.\nLabour warranted one year.",
  options: [
    {
      id: "better", name: "New condenser", description: null, tier: "Better", isRecommended: true,
      subtotal: "3400.0000", discountTotal: "0.0000", taxTotal: "280.5000", total: "3680.5000", optionalTotal: "289.0000",
      lines: [line(), line({ id: "s", name: "Surge protector", lineTotal: "289.0000", isOptional: true })],
    },
    {
      id: "good", name: "Repair", description: null, tier: "Good", isRecommended: false,
      subtotal: "180.0000", discountTotal: "89.0000", taxTotal: "0.0000", total: "91.0000", optionalTotal: "0",
      lines: [
        line({ id: "d", name: "Diagnostic", unitPrice: "89.0000", lineTotal: "0.0000", discountAmount: "89.0000", memberDiscountAmount: "89.0000", memberPlan: "Comfort Club" }),
        line({ id: "m", name: "Capacitor", unitPrice: "91.0000", lineTotal: "91.0000" }),
      ],
    },
  ],
  ...over,
});

describe("the proposal", () => {
  it("carries the company, the customer, the options side by side with their tiers, the terms and a line to sign", () => {
    const html = renderToStaticMarkup(<ProposalView proposal={proposal()} logoSrc="/brand/logo?v=1" timezone="America/Chicago" />);
    expect(html).toContain("Ridgeline Air");
    expect(html).toContain('src="/brand/logo?v=1"');
    expect(html).toContain("--brand:#0f766e");
    expect(html).toContain("Nina Patel");
    expect(html).toContain("Better");
    expect(html).toContain("Recommended");
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("Add if you like");
    expect(html).toContain("Prices hold for 30 days.");
    expect(html).toContain("Signature");
  });

  it("says a waived fee is waived, and by which plan", () => {
    const html = renderToStaticMarkup(<ProposalView proposal={proposal()} logoSrc={null} timezone="UTC" />);
    expect(html).toContain("Waived for members of Comfort Club");
    expect(html).not.toContain("<img");
  });

  it("shows who signed in place of the signature lines once it is approved", () => {
    const html = renderToStaticMarkup(<ProposalView proposal={proposal({
      status: "approved", signerName: "Nina Patel", decidedAt: "2026-06-03T15:00:00.000Z", selectedOptionId: "better",
    })} logoSrc={null} timezone="America/Chicago" />);
    expect(html).toContain("Approved by <span class=\"font-medium\">Nina Patel</span> on June 3, 2026");
    expect(html).toContain("Chosen");
    expect(html).not.toContain("Option chosen");
  });
});

describe("what became of each send", () => {
  it("says a refusal in red with the reason, and a delivery plainly", () => {
    const html = renderToStaticMarkup(<Deliveries when={() => "Jun 3"} deliveries={[
      { id: "a", channel: "email", destination: "nina@example.test", state: "delivered", error: null, createdAt: "x" },
      { id: "b", channel: "sms", destination: "+15125550142", state: "refused", error: "They have replied STOP.", createdAt: "x" },
    ]} />);
    expect(html).toContain("by email to nina@example.test");
    expect(html).toContain("delivered");
    expect(html).toContain("text-red-600\">not sent");
    expect(html).toContain("They have replied STOP.");
  });
});

describe("the plan form", () => {
  it("reads a percentage as the fraction the contract takes, months as ticks and benefits one per line", () => {
    const form = new FormData();
    form.set("name", "Comfort Club");
    form.set("price", "$228.00");
    form.set("billingFrequency", "monthly");
    form.set("termMonths", "12");
    form.set("includedVisitsPerTerm", "2");
    form.append("visitAnchorMonths", "10");
    form.append("visitAnchorMonths", "4");
    form.set("discountPercent", "15");
    form.set("waivesDiagnosticFee", "on");
    form.set("benefits", "Two tune ups\n\n No overtime ");
    form.set("autoRenews", "on");
    expect(planFromForm(form)).toEqual({
      name: "Comfort Club", price: "228.00", billingFrequency: "monthly", termMonths: 12,
      includedVisitsPerTerm: 2, visitAnchorMonths: [4, 10], discountRate: "0.15",
      priorityDispatch: false, waivesDiagnosticFee: true, waivesAfterHoursRate: false,
      benefits: ["Two tune ups", "No overtime"], autoRenews: true, renewalNoticeDays: 30,
      discountExclusions: { categoryIds: [], itemIds: [] },
    });
  });

  it("reads what the discount leaves out and the plan's own share of each window", () => {
    const form = new FormData();
    form.set("name", "Gold");
    form.set("price", "300");
    form.append("excludedCategoryIds", "cat-equipment");
    form.append("excludedItemIds", "item-permit");
    form.set("memberHoldPercent", "30");
    expect(planFromForm(form)).toMatchObject({
      discountExclusions: { categoryIds: ["cat-equipment"], itemIds: ["item-permit"] },
      memberHoldPercent: 30,
    });
    /** Blank on an edit puts the plan back on the company's figure. */
    expect(planFromForm(new FormData(), { editing: true })).toMatchObject({ memberHoldPercent: null });
  });

  it("offers the price book's categories and items to leave out, ticking the ones already left out", () => {
    const html = renderToStaticMarkup(<PlanFields
      plan={{ name: "Club", discountExclusions: { categoryIds: ["c1"], itemIds: [] } }}
      book={{ categories: [{ id: "c1", name: "Equipment", depth: 0 }, { id: "c2", name: "Labour", depth: 0 }], items: [] }}
    />);
    expect(html).toContain("Not discounted");
    expect(html).toMatch(/checked="" value="c1"/);
    expect(html).not.toMatch(/checked="" value="c2"/);
  });

  it("clears a code, a description and a visit day when an edit leaves them empty", () => {
    const form = new FormData();
    form.set("name", "Plan");
    form.set("price", "10");
    expect(planFromForm(form, { editing: true })).toMatchObject({ code: "", description: "", visitAnchorDay: null });
  });

  it("says who an edit reaches beside each part of it", () => {
    const html = renderToStaticMarkup(<PlanFields plan={{ name: "Club", discountRate: "0.150000", priorityDispatch: true }} editing />);
    expect(html).toContain('value="15"');
    expect(html).toContain("Reaches new sales only");
    expect(html).toContain("reach every member the moment they are saved");
  });
});
