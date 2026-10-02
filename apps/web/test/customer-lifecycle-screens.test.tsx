import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Lifecycle, candidateLabel } from "../src/app/(app)/customers/[id]/Lifecycle";

const noop = async () => null;

const props = {
  removeAction: noop,
  mergeAction: noop,
  id: "c1",
  name: "Robert Smith",
  deletable: true,
  blockedBy: [] as { label: string; n: number }[],
  wouldRemove: [] as { label: string; n: number }[],
  candidates: [] as { id: string; name: string; because: string }[],
};

/**
 * M03's REMOVE AND MERGE, AND THE CANDIDATE LIST THAT WAS WHOEVER CAME FIRST
 *
 * The screen existed. What it offered as things to merge into was
 * `customers.list({ limit: 50 })`: whichever fifty records came back first. The
 * real duplicate is usually not among them, and a dropdown of fifty unrelated
 * people is a dropdown somebody picks the wrong entry from. A merge is
 * irreversible in practice, so joining two different people is the one mistake
 * this control must not make easy.
 */
describe("removing or merging a customer", () => {
  it("offers the reason beside each candidate", () => {
    /**
     * The reason is in the label, not behind a hover. "Same phone number" is what
     * makes somebody confident, and a bare list of names is a list they have to
     * verify somewhere else. Checked on the label rather than on the markup
     * because the form is behind a toggle, and a destructive control that is open
     * by default is one somebody submits by accident.
     */
    expect(candidateLabel({ name: "Bob Smith", because: "Same phone number" }))
      .toBe("Bob Smith: Same phone number");
    expect(candidateLabel({ name: "Smith, Robert", because: "Similar name" }))
      .toBe("Smith, Robert: Similar name");
  });

  it("counts the candidates on the button, so nobody opens an empty form", () => {
    const html = renderToStaticMarkup(
      <Lifecycle
        {...props}
        candidates={[
          { id: "c2", name: "Bob Smith", because: "Same phone number" },
          { id: "c3", name: "Smith, Robert", because: "Similar name" },
        ]}
      />,
    );
    expect(html).toContain("Merge a duplicate into this one (2)");
  });

  it("says nothing matches rather than hiding the control", () => {
    /**
     * An absent button reads as a permission somebody does not have. The truth is
     * more useful and is a different sentence.
     */
    const html = renderToStaticMarkup(<Lifecycle {...props} candidates={[]} />);
    expect(html).toContain("No other record shares this phone number or email");
    expect(html).not.toContain("Merge a duplicate");
  });

  it("names what is in the way instead of a disabled delete button", () => {
    const html = renderToStaticMarkup(
      <Lifecycle
        {...props}
        deletable={false}
        blockedBy={[{ label: "invoices", n: 3 }, { label: "payments", n: 1 }]}
      />,
    );
    expect(html).toContain("3 invoices, 1 payments");
    expect(html).toContain("money that has moved has to stay explicable");
    expect(html).toContain("merge them into the real record instead");
    expect(html).not.toContain("Remove this record");
  });

  it("offers the removal when nothing financial points at them", () => {
    const html = renderToStaticMarkup(<Lifecycle {...props} deletable />);
    expect(html).toContain("Remove this record");
  });

  it("names the person being merged INTO on the button, because the two directions are opposites", () => {
    /**
     * "Merge X into this one" and "merge this one into X" are opposite operations,
     * and a control labelled just "merge" makes somebody guess which. The button
     * that opens the form carries the direction; the form inside names the field.
     */
    const html = renderToStaticMarkup(
      <Lifecycle {...props} candidates={[{ id: "c2", name: "Bob Smith", because: "Same phone number" }]} />,
    );
    expect(html).toContain("Merge a duplicate into this one");
  });
});
