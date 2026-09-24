import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { events } from "@opentradesos/core";
import { schema } from "@opentradesos/db";

/**
 * AN EVENT A WORKFLOW CAN SUBSCRIBE TO IS AN EVENT SOMETHING EMITS
 *
 * Two lists had to agree and nothing made them: the names emitted, and the
 * names the builder offered. The builder offered fourteen. Exactly ONE was
 * ever emitted anywhere in the product.
 *
 * So a company building "when an invoice is paid, text the customer a review
 * request" got a workflow that saved, enabled, showed in the list with a
 * green dot, and never ran once. There is no error to see and no log line to
 * find, because a subscription that matches nothing is indistinguishable
 * from a quiet month.
 *
 * It failed the other way too. Five events the product did emit, all about
 * agreements, were missing from the builder, so the one part of the product
 * with a working event stream could not be automated at all.
 *
 * `emit` is now typed against the catalogue, which makes an invented name a
 * compile error. This file covers what a type cannot: a catalogue entry
 * claiming to be emitted that nothing emits, and an emitter the catalogue
 * has not heard of.
 */
const API_SRC = join(import.meta.dirname, "../src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Every name passed to `emit`, including the ones built from a template.
 *
 * `job.${status}` is one call producing nine names, and reading it as a
 * literal would report eight of them as unemitted. The status list comes
 * from the enum rather than from the template, because that is what the
 * expression actually ranges over.
 */
function emitted(): Set<string> {
  const found = new Set<string>();

  for (const path of sources(API_SRC)) {
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === "emit") {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            if (!ts.isIdentifier(property.name) || property.name.text !== "name") continue;

            let value: ts.Node = property.initializer;
            if (ts.isAsExpression(value)) value = value.expression;

            if (ts.isStringLiteral(value)) { found.add(value.text); continue; }

            if (ts.isTemplateExpression(value)) {
              const head = value.head.text;
              /**
               * `job.${input.status}`: one call, one name per status. The
               * enum is the range, and a status added to the database
               * without a catalogue line fails the check below rather than
               * becoming an event nobody can subscribe to.
               */
              if (head === "job.") {
                for (const status of schema.jobStatus.enumValues) found.add(`job.${status}`);
              }
              continue;
            }

            /**
             * `shape.eventName`, from the dwell shapes. Resolved by reading
             * the shapes rather than guessed, so the check does not quietly
             * stop covering them.
             */
            if (ts.isPropertyAccessExpression(value) && value.name.text === "eventName") {
              for (const name of dwellEventNames()) found.add(name);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  return found;
}

function dwellEventNames(): string[] {
  const text = readFileSync(join(API_SRC, "services/workflow-dwell.ts"), "utf8");
  return [...text.matchAll(/eventName:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the event catalogue", () => {
  const fired = emitted();

  it("finds the emitters at all", () => {
    /**
     * The vacuous case. A walker that matched nothing would report every
     * catalogue entry as unemitted, or nothing as missing, depending which
     * way round you read it. Both are the same clean bill of health the
     * defect itself produces.
     */
    expect(fired.size).toBeGreaterThan(15);
    expect(fired).toContain("job.completed");
    expect(fired).toContain("invoice.paid");
  });

  it("emits everything it says it emits", () => {
    const claimed = events.EVENT_NAMES.filter((name) => events.EVENTS[name].emitted);
    const lying = claimed.filter((name) => !fired.has(name));

    /**
     * An entry marked emitted that nothing emits is offered in the builder
     * and produces exactly the silent workflow this catalogue exists to
     * prevent. Fix it by emitting the event, or by setting `emitted: false`
     * with an `owedBy` saying which module will.
     */
    expect(lying, "claims to be emitted and is not").toEqual([]);
  });

  it("knows about everything that is emitted", () => {
    const unknown = [...fired].filter((name) => !events.isEventName(name));
    /**
     * The other direction. An emitter the catalogue has not heard of writes
     * an event no workflow can be built on, which is the same silence
     * arriving from the opposite side.
     */
    expect(unknown, "emitted and not in the catalogue").toEqual([]);
  });

  it("explains every event it does not emit", () => {
    const owedWithoutReason = events.EVENT_NAMES
      .filter((name) => !events.EVENTS[name].emitted && !events.EVENTS[name].owedBy);
    expect(owedWithoutReason, "not emitted and no reason given").toEqual([]);
  });

  it("offers a workflow only what can fire", () => {
    const offered = events.SUBSCRIBABLE;
    expect(offered.length).toBeGreaterThan(10);
    for (const name of offered) {
      expect(fired.has(name), `${name} is offered and never emitted`).toBe(true);
    }
  });

  it("covers every job status, since the name is built from the enum", () => {
    /**
     * `job.${input.status}` ranges over the enum, so a status added to the
     * database without a catalogue line becomes an event nobody can
     * subscribe to. Checked here rather than left to the compiler, which
     * only sees the template.
     */
    const missing = schema.jobStatus.enumValues
      .filter((status) => !events.isEventName(`job.${status}`));
    expect(missing, "a job status with no event in the catalogue").toEqual([]);
  });

  it("names events as facts in the past tense", () => {
    /**
     * A workflow author reads these as the sentence they complete: "when an
     * invoice is paid, ...". A name that is not a completed fact produces
     * automations that fire at a moment nobody can describe.
     */
    const bad = events.EVENT_NAMES.filter((name) => {
      const [entity, ...rest] = name.split(".");
      return !entity || rest.length !== 1 || rest[0] === "" || /[A-Z]/.test(name);
    });
    expect(bad, "not shaped entity.past_tense_fact").toEqual([]);
  });
});
