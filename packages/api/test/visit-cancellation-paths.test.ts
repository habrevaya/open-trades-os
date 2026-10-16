import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * EVERY PATH THAT CANCELS A VISIT SAYS WHO ASKED, AND WHEN
 *
 * Cleaning's cancellation rate counts stops the customer called off inside the
 * notice window and leaves out the ones the company called off itself. A
 * visit only knows which when the path that cancelled it said so
 * (`visit.cancelled_by`, `cancelled_at`, `cancel_notice_hours`), and the day a
 * new path writes `status: "cancelled"` without them, its cancellations count
 * as not known and nobody notices: the figure still looks fine.
 *
 * So this reads the service layer. Every `.set({...})` on an update of
 * `schema.visit`, and every `.values({...})` on an insert into it, that can
 * write "cancelled" must also write who: a `cancelledBy` property, or the
 * columns spread from `calledOffFields(...)` in `visit-cancellations.ts`. And
 * no SQL written as text may set a visit cancelled at all.
 *
 * A path that genuinely does not know who (a visit brought in from history
 * that did not say) passes null to `calledOffFields` on purpose, which this
 * accepts: the decision is written where it is made.
 */
const API_SRC = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

interface Write { file: string; line: number; text: string; saysWho: boolean }

/** Every object written to the visit table that can carry "cancelled" as its status. */
function cancellingWrites(): Write[] {
  const found: Write[] = [];
  for (const file of files(API_SRC)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["set", "values"].includes(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(source);
        if (/\b(update|insert)\(schema\.visit\)/.test(receiver)) {
          const argument = node.arguments[0];
          const text = argument?.getText(source) ?? "";
          const status = argument && ts.isObjectLiteralExpression(argument)
            ? argument.properties.find((p) => p.name?.getText(source) === "status")?.getText(source) ?? ""
            : text;
          if (/["']cancelled["']/.test(status)) {
            found.push({
              file: relative(API_SRC, file),
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              text: status,
              saysWho: /\bcancelledBy\b/.test(text) || /\bcalledOffFields\(/.test(text),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("every path that cancels a visit", () => {
  it("says who asked and when, so the cancellation rate can tell a customer from a rain day", () => {
    const writes = cancellingWrites();
    const silent = writes.filter((w) => !w.saysWho).map((w) => `${w.file}:${w.line} ${w.text}`);
    expect(silent, "these write a cancelled visit without saying who asked; spread calledOffFields(...) into them").toEqual([]);

    /**
     * Not vacuous: the scan finds the one place a visit is called off
     * (`callOff`) and the history insert that can write one cancelled. If
     * either moved, this fails before the check above quietly passes on
     * nothing.
     */
    const where = writes.map((w) => w.file);
    expect(where).toContain("services/visit-cancellations.ts");
    expect(where).toContain("services/jobs.ts");
  });

  it("never sets a visit cancelled in SQL written as text, where nothing could check it", () => {
    const offenders: string[] = [];
    for (const file of files(API_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/update\s+(?:public\.)?visit\s+set[\s\S]{0,400}?'cancelled'/gi)) {
        offenders.push(`${relative(API_SRC, file)}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("goes through the helpers from every service that cancels one", () => {
    /** The paths named in `visit-cancellations.ts`, each calling it rather than writing the row itself. */
    const read = (name: string) => readFileSync(join(API_SRC, "services", name), "utf8");
    expect(read("jobs.ts")).toMatch(/callOff\(tx, ctx, visit\.id/);
    expect(read("visit-changes.ts")).toMatch(/callOff\(tx, ctx, visit\.id, \{ by: "customer", askedAt: req\.createdAt \}\)/);
    expect(read("visit-cancellations.ts")).toMatch(/await callOff\(tx, ctx, visit\.id, \{ by: input\.by, askedAt \}\)/);
  });
});
