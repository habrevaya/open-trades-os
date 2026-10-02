import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { belongsTo, keptForm, restoreKept, type KeptField } from "../src/lib/kept-values";
import { attempt, refused } from "../src/lib/actions";

/**
 * EVERY FORM KEEPS WHAT WAS TYPED WHEN IT IS REFUSED
 *
 * React empties a form after its action runs. Sign in was fixed for that one
 * form at a time and the other forty kept doing it, so this holds the whole
 * app to it: every server action's refusal carries what was posted, and
 * every form puts it back. Both halves are checked by reading the source,
 * so a form added tomorrow is held to it without anybody listing it here.
 */

const SRC = join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

/** The object literal starting at `start`, braces balanced. */
function literalAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

describe("every server action hands back what was typed when it refuses", () => {
  const actions = sources.filter((s) => /^["']use server["'];?/m.test(s.text));

  it("finds the server actions", () => {
    expect(actions.length).toBeGreaterThan(30);
  });

  it("builds no refusal of its own that leaves the values behind", () => {
    const bare: string[] = [];
    for (const { path, text } of actions) {
      for (const match of text.matchAll(/\{\s*error\s*:/g)) {
        const literal = literalAt(text, match.index);
        // A type, not a value: `{ error: string }`.
        if (/^\{\s*error\s*:\s*string\s*[;,]?\s*\}$/.test(literal)) continue;
        if (/\bvalues\b/.test(literal)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        bare.push(`${path}:${line} ${literal.replace(/\s+/g, " ").slice(0, 80)}`);
      }
    }
    expect(bare, "return refused(form, message) instead, so the form keeps what was typed").toEqual([]);
  });
});

describe("every form puts the values back", () => {
  it("uses useKeptAction rather than useActionState, which leaves the reset to empty the boxes", () => {
    const direct = sources
      .filter((s) => s.path !== join("lib", "use-kept-action.ts"))
      .filter((s) => /\buseActionState\b/.test(s.text))
      .map((s) => s.path);
    expect(direct).toEqual([]);
  });

  it("spreads the form props from useKeptAction onto a form, so the values have somewhere to go", () => {
    const unattached: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/const \[[^\]]*?,\s*(\w+),[^\]]*\]\s*=\s*useKeptAction/g)) {
        const name = match[1]!;
        if (!new RegExp(`\\{\\.\\.\\.${name}\\}`).test(text)) unattached.push(`${path}: ${name}`);
      }
    }
    expect(unattached).toEqual([]);
  });
});

describe("what is kept, and where it goes back", () => {
  it("keeps everything posted, in order, and nothing that names a secret", () => {
    const form = new FormData();
    form.append("summary", "No cooling upstairs");
    form.append("technicianIds", "a");
    form.append("technicianIds", "b");
    form.append("description", "");
    form.append("password", "correct horse battery staple");
    form.append("secretRef", "sk_pasted_here");
    form.append("apiKey", "whatever");
    form.append("$ACTION_ID_abc", "");
    form.append("photo", new Blob(["x"]), "x.jpg");
    expect(keptForm(form)).toEqual({
      summary: ["No cooling upstairs"], technicianIds: ["a", "b"], description: [""],
    });
  });

  it("refused and attempt both hand the values back", async () => {
    const form = new FormData();
    form.set("amount", "500.00");
    expect(refused(form, "Too much")).toEqual({ error: "Too much", values: { amount: ["500.00"] } });

    const conflict = Object.assign(new Error("This invoice is void."), { name: "ConflictError" });
    await expect(attempt(form, async () => { throw conflict; }))
      .resolves.toEqual({ error: "This invoice is void.", values: { amount: ["500.00"] } });
  });

  it("puts text back in order, ticks what was ticked, and leaves hidden fields alone", () => {
    const fields: KeptField[] = [
      { name: "id", type: "hidden", value: "row-1" },
      { name: "line", type: "text", value: "" },
      { name: "line", type: "text", value: "" },
      { name: "note", type: "textarea", value: "" },
      { name: "tech", type: "checkbox", value: "a", checked: false },
      { name: "tech", type: "checkbox", value: "b", checked: true },
      { name: "method", type: "select-one", value: "cash" },
      { name: "untouched", type: "text", value: "as it was" },
    ];
    restoreKept(fields, {
      id: ["row-2"], line: ["Diagnostic", "Capacitor"], note: ["Gate code 4411"], tech: ["a"], method: ["check"],
    });
    expect(fields.map((f) => f.type === "checkbox" ? f.checked : f.value)).toEqual([
      "row-1", "Diagnostic", "Capacitor", "Gate code 4411", true, false, "check", "as it was",
    ]);
  });

  it("only goes back into the form that was sent, when one action drives a form on every row", () => {
    const row = (id: string): KeptField[] => [{ name: "id", type: "hidden", value: id }, { name: "qty", type: "text", value: "" }];
    expect(belongsTo(row("row-1"), { id: ["row-1"], qty: ["3"] })).toBe(true);
    expect(belongsTo(row("row-2"), { id: ["row-1"], qty: ["3"] })).toBe(false);
  });
});
