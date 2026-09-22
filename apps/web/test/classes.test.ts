import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { colors } from "@opentradesos/ui";

/**
 * TAILWIND CLASS NAMES THAT DO NOT EXIST
 *
 * The worst failure mode in this stack, because it is completely silent.
 * Tailwind generates CSS for the classes it finds; a class it does not
 * recognise produces no rule, no warning and no build error. The element just
 * renders unstyled, and unstyled usually still looks fine.
 *
 * This was not hypothetical. The dispatch board and both customer-facing
 * portal screens were written with `bg-alert-100` and `text-alert-700`, which
 * are not in the preset. Every error message and every late badge rendered as
 * plain black text on white, through a typecheck, a lint and a build, and it
 * was only caught by looking at a screenshot.
 */

const PALETTES = ["ink", "steel", "blue", "red", "amber", "green", "purple", "canvas"] as const;

/** The shades the preset actually defines, derived from the tokens. */
function knownShades(): Map<string, Set<string>> {
  const byPalette = new Map<string, Set<string>>();

  for (const key of Object.keys(colors)) {
    // tokens are named like ink900, blue600, redTint, canvasRaised
    const match = /^([a-z]+)([0-9]{3}|Tint|Raised)?$/.exec(key);
    if (!match) continue;
    const [, palette, shade] = match;
    const set = byPalette.get(palette!) ?? new Set<string>();
    set.add(shade ? shade.toLowerCase() : "DEFAULT");
    byPalette.set(palette!, set);
  }
  return byPalette;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(process.cwd(), "src"));
  return out;
}

describe("colour classes", () => {
  const known = knownShades();

  it("has files to check", () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it("names a palette the preset defines", () => {
    const valid = new Set<string>(PALETTES);
    const bad: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /\b(?:bg|text|border|ring|fill|stroke|from|to|via)-([a-z]+)-([a-z0-9]+)\b/g,
      )) {
        const [whole, palette] = m;
        // Tailwind's own built-in palettes are fine; what is not fine is a
        // palette this project invented and never defined.
        const builtin = ["white", "black", "transparent", "current", "inherit", "slate", "gray", "zinc"];
        if (builtin.includes(palette!)) continue;
        if (!valid.has(palette!)) bad.push(`${file.split("/src/")[1]}: ${whole}`);
      }
    }

    expect(bad, `Unknown colour palette: ${bad.join("; ")}`).toEqual([]);
  });

  it("names a shade the preset defines", () => {
    const bad: string[] = [];

    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /\b(?:bg|text|border|ring|fill|stroke)-(ink|steel|blue|red|amber|green|purple|canvas)-([a-z0-9]+)\b/g,
      )) {
        const [whole, palette, shade] = m;
        const shades = known.get(palette!);
        if (!shades) continue;
        if (!shades.has(shade!.toLowerCase())) {
          bad.push(`${file.split("/src/")[1]}: ${whole} (have: ${[...shades].sort().join(", ")})`);
        }
      }
    }

    expect(bad, `Undefined shade: ${bad.join("; ")}`).toEqual([]);
  });
});
