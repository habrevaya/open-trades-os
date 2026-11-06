import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../src/app/(app)/booking/actions", () => ({ editService: vi.fn() }));
const { EditService } = await import("../src/app/(app)/booking/EditService");

const service = {
  id: "s1", publicName: "Tune up", publicDescription: "One system, checked.", displayPrice: "189.0000",
  depositAmount: null, depositPercent: "0.100000", minNoticeHours: 24, maxAdvanceDays: 60, maxPerWindow: 2, isActive: true,
};

/** CHANGING A SERVICE THE PUBLIC MAY BOOK, ON A SCREEN */
describe("editing a service offered online", () => {
  it("puts back every term as it is now, the percent as a percent", () => {
    const html = renderToStaticMarkup(<EditService service={service} />);
    expect(html).toContain("Edit Tune up");
    expect(html).toContain('value="Tune up"');
    expect(html).toContain('value="189.00"');
    expect(html).toMatch(/name="deposit" checked="" value="percent"/);
    expect(html).toContain('name="depositValue" value="10"');
    expect(html).toMatch(/name="isActive" checked=""/);
  });

  it("says the booking page takes no money, and what switching it off keeps", () => {
    const html = renderToStaticMarkup(<EditService service={{ ...service, depositPercent: null, isActive: false }} />);
    expect(html).toContain("The booking page does not take money.");
    expect(html).toMatch(/name="deposit" checked="" value="none"/);
    expect(html).not.toMatch(/name="isActive" checked=""/);
    expect(html).toContain("Its terms are kept, and bookings already made are not touched.");
  });
});
