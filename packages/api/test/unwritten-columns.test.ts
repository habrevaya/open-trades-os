import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A COLUMN A QUERY DEPENDS ON IS A COLUMN SOMETHING WRITES
 *
 * The defect this file exists for, stated once:
 *
 *   `agreement_visit.skipped_on` was in the first migrations. The owed report
 *   filtered on it. The booking guard refused on it, by name. A comment
 *   described skipping as a thing the product did. Nothing wrote it, ever.
 *
 * Every part of that reads as a working feature. The filter is real SQL, the
 * refusal is a real error message, the column exists in the database. The
 * only thing missing is the one line that sets it, and the symptom is not an
 * error: it is a member who cannot skip a visit, a report with permanent
 * residents, and an error message naming a state nothing can reach.
 *
 * Nothing catches this. Not types, not the database, not the tests, because
 * a test for a feature nobody built is a test nobody wrote.
 *
 * WHAT THIS CHECKS. Every `schema.table.column` the service layer mentions
 * inside a query, against every column it writes in a `.set({...})` or
 * `.values({...})`. A column depended on and never written is reported.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: columns that are merely SELECTED.
 * Reading a column nothing writes gives you a null, which is honest and
 * usually harmless. It is DEPENDING on one, in a filter or an order or a
 * conflict target, that produces a query whose answer is fixed before it
 * runs.
 *
 * The allow list below is the interesting part of the file. An entry there is
 * a decision somebody made with a reason attached, not a gap. It is meant to
 * stay short, and to be read when it grows.
 */
const API_SRC = join(import.meta.dirname, "../src");
const SCHEMA_SRC = join(import.meta.dirname, "../../db/src/schema");

/**
 * Columns depended on and written by nothing, where that is correct.
 *
 * Each entry says WHO writes it instead, because "the database does" and
 * "nobody does" look identical from in here and only one of them is fine.
 *
 * Columns with a default, and the id and timestamp columns every table
 * carries, are excluded structurally rather than listed: the database writes
 * those, and a list of three hundred of them would hide the two that matter.
 */
const WRITTEN_ELSEWHERE = new Map<string, string>([]);

/**
 * SOFT DELETE THAT IS NOT OFFERED.
 *
 * Twenty six tables filter `deleted_at is null` on every read and six can
 * ever set it. That is ONE finding repeated twenty nine times, not twenty
 * six findings, so it is held as a group rather than as a list of entries
 * with invented reasons: a table here is one you cannot delete a row from,
 * and the filter on its reads is decoration until something writes the
 * column.
 *
 * Some of these are correct and will stay. An invoice is voided, not deleted,
 * and the column exists because every table carries it. Others are plainly
 * missing: a company that mis-keys a customer, a property or a vendor has no
 * way to remove it and will edit the row into something else instead, which
 * is how a CRM ends up with a customer called "DO NOT USE".
 *
 * The COUNT is asserted, so a twenty seventh table cannot join quietly. Deciding
 * which of these get a delete is product work; letting the number drift
 * without anybody noticing is not.
 */
const SOFT_DELETE_NOT_OFFERED = 26;


/**
 * THE SHARP ONES, each a query whose answer is fixed before it runs.
 *
 * Every entry says what it costs, because a list of column names is a list
 * somebody scrolls past. This is meant to empty, and a test above fails when
 * an entry is fixed and not removed.
 */
const KNOWN_GAPS = new Map<string, string>([
  ["phoneNumber.attributionSource",
    "A tracking number cannot be told what campaign it belongs to, so call attribution resolves to nothing."],
  ["phoneNumber.releasedAt",
    "A number cannot be released. Sending picks the newest registered number and would keep picking one that has gone back to the carrier."],
  ["reviewRequest.sendAt",
    "A review request cannot be scheduled, only sent now, so the policy's delay after a visit is unreachable."],
  ["wageScale.effectiveFrom",
    "A wage scale cannot be created through the service layer, so labour cost resolves against nothing."],
  ["wageScale.effectiveTo", "Same row."],
]);

type Dep = { table: string; column: string; where: string };

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
 * The table a drizzle chain is about.
 *
 * `tx.update(schema.agreementVisit).set({...})` and
 * `tx.insert(schema.rateCard).values({...})`: the object literal is on one
 * call and the table is on the one before it, so this walks back down the
 * chain until it finds an `update`, `insert` or `into` with a
 * `schema.something` argument.
 */
function tableOfChain(node: ts.CallExpression): string | null {
  let current: ts.Node = node;
  for (let depth = 0; depth < 12; depth += 1) {
    if (!ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current)) { current = current.expression; continue; }
      return null;
    }
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === "update" || method === "insert" || method === "into") {
        const arg = current.arguments[0];
        if (arg && ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression)
            && arg.expression.text === "schema") {
          return arg.name.text;
        }
        return null;
      }
      current = callee.expression;
      continue;
    }
    return null;
  }
  return null;
}

/** Top level keys of an object literal, including shorthand and spread-free ones. */
function keysOf(node: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = property.name;
      if (ts.isIdentifier(name)) keys.push(name.text);
      else if (ts.isStringLiteral(name)) keys.push(name.text);
    }
  }
  return keys;
}

/**
 * WHICH COLUMNS THE DATABASE WRITES BY ITSELF.
 *
 * `pk()` defaults, `...timestamps`, and anything carrying `.default(...)`,
 * `.defaultNow()` or `.defaultRandom()`. Excluding those structurally rather
 * than by a list is the difference between a check with two findings and a
 * list of three hundred where nobody would look.
 *
 * A NOT NULL column with no default is excluded too, for a different reason:
 * it cannot be missing from an insert, because the insert would fail. If
 * nothing writes it, nothing inserts that table at all, which is a different
 * problem and not one a column level check should report three hundred times.
 *
 * What is left is exactly the dangerous shape: NULLABLE, NO DEFAULT,
 * depended on by a query. That is `agreement_visit.skipped_on`: a filter and
 * a guard over a column whose value is always null because nothing sets it.
 */
function selfWriting(): Set<string> {
  const safe = new Set<string>();
  for (const name of readdirSync(SCHEMA_SRC)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(join(SCHEMA_SRC, name), "utf8");
    const file = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);

    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && ts.isCallExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression)
          && node.initializer.expression.text === "pgTable") {
        const table = node.name.text;
        const shape = node.initializer.arguments[1];
        if (shape && ts.isObjectLiteralExpression(shape)) {
          for (const property of shape.properties) {
            /** `...timestamps`: created_at and updated_at, both defaulted. */
            if (ts.isSpreadAssignment(property)) {
              safe.add(`${table}.createdAt`);
              safe.add(`${table}.updatedAt`);
              continue;
            }
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            const column = property.name.text;
            const source = property.initializer.getText(file);
            const defaulted = /\.default(Now|Random)?\(|\.\$default|^pk\(/.test(source);
            const required = /\.notNull\(\)/.test(source);
            if (defaulted || required) safe.add(`${table}.${column}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return safe;
}

/**
 * The drizzle calls that make a column decide something, rather than merely
 * report it. `eq(schema.x.y, ...)` inside one of these is a dependency.
 */
const PREDICATES = new Set([
  "where", "having", "orderBy", "onConflictDoUpdate", "onConflictDoNothing",
  "innerJoin", "leftJoin", "rightJoin", "fullJoin",
]);

function scan() {
  const depended: Dep[] = [];
  const written = new Set<string>();
  /** Every column the schema mentions at all, so a typo cannot pass as coverage. */
  const seen = new Set<string>();

  for (const path of sources(API_SRC)) {
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    const relative = path.slice(API_SRC.length + 1);

    const visit = (node: ts.Node, insidePredicate: boolean) => {
      let predicate = insidePredicate;

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;

        if ((method === "set" || method === "values") && node.arguments.length > 0) {
          const table = tableOfChain(node);
          if (table) {
            for (const argument of node.arguments) {
              const literals = ts.isArrayLiteralExpression(argument)
                ? argument.elements.filter(ts.isObjectLiteralExpression)
                : ts.isObjectLiteralExpression(argument) ? [argument] : [];
              for (const literal of literals) {
                for (const key of keysOf(literal)) written.add(`${table}.${key}`);
              }
              /**
               * `.values(rows.map((r) => ({...})))`. The object literal is
               * inside a callback, so it is not an argument: find any object
               * literal beneath this argument and credit its keys.
               */
              if (!ts.isObjectLiteralExpression(argument) && !ts.isArrayLiteralExpression(argument)) {
                const collect = (inner: ts.Node) => {
                  if (ts.isObjectLiteralExpression(inner)) {
                    for (const key of keysOf(inner)) written.add(`${table}.${key}`);
                  }
                  ts.forEachChild(inner, collect);
                };
                collect(argument);
              }
            }
          }
        }

        /**
         * ONLY THE ARGUMENTS, not the whole call.
         *
         * `db.select({ color: schema.technician.color }).from(t).where(...)`
         * is one expression whose outermost node is the `where`. Marking the
         * entire subtree as predicate context sweeps in the select list of
         * every joined query, and the report fills with columns that are
         * merely displayed. Visit the arguments as predicate context and the
         * callee chain as whatever it already was.
         */
        if (PREDICATES.has(method)) {
          for (const argument of node.arguments) visit(argument, true);
          visit(node.expression, insidePredicate);
          return;
        }
      }

      if (ts.isPropertyAccessExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === "schema") {
        const key = `${node.expression.name.text}.${node.name.text}`;
        seen.add(key);
        if (predicate) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          depended.push({
            table: node.expression.name.text,
            column: node.name.text,
            where: `${relative}:${line + 1}`,
          });
        }
      }

      ts.forEachChild(node, (child) => visit(child, predicate));
    };

    visit(file, false);
  }

  return { depended, written, seen };
}

describe("columns a query depends on", () => {
  const { depended, written, seen } = scan();
  const safe = selfWriting();

  it("finds the service layer at all", () => {
    /**
     * The vacuous case, and the one that matters most here. A walker that
     * matched nothing would report no unwritten columns and read as a clean
     * bill of health, which is the same failure this whole file is about.
     */
    expect(seen.size).toBeGreaterThan(400);
    expect(depended.length).toBeGreaterThan(300);
    expect(written.size).toBeGreaterThan(200);
    /** And the schema was read, or every column would look dangerous. */
    expect(safe.size).toBeGreaterThan(400);
  });

  it("has something written for every one of them", () => {
    const orphans = new Map<string, string>();
    for (const dep of depended) {
      const key = `${dep.table}.${dep.column}`;
      if (written.has(key) || safe.has(key) || WRITTEN_ELSEWHERE.has(key)) continue;
      if (dep.column === "deletedAt") continue;
      if (KNOWN_GAPS.has(key)) continue;
      if (!orphans.has(key)) orphans.set(key, dep.where);
    }

    /**
     * Each line is a query whose answer is decided before it runs. Fix it by
     * writing the column, by dropping the query, or by adding an entry to
     * WRITTEN_ELSEWHERE that names who writes it instead.
     */
    const report = [...orphans].map(([key, where]) => `${key} (depended on at ${where})`).sort();
    expect(report).toEqual([]);
  });

  it("counts the tables with a delete filter and no delete", () => {
    const tables = new Set(
      depended.filter((d) => d.column === "deletedAt" && !written.has(`${d.table}.deletedAt`))
        .map((d) => d.table),
    );
    expect([...tables].sort().length).toBe(SOFT_DELETE_NOT_OFFERED);
  });

  it("does not let a known gap quietly heal or spread", () => {
    /**
     * Both directions. A gap that is fixed should leave this list, and a gap
     * that is listed and no longer reachable is a note about nothing. The
     * list is meant to shrink and a test that only caught growth would let
     * it sit at its opening size forever.
     */
    const open = new Set(
      depended.filter((d) => !written.has(`${d.table}.${d.column}`)
        && !safe.has(`${d.table}.${d.column}`) && d.column !== "deletedAt")
        .map((d) => `${d.table}.${d.column}`),
    );
    const healed = [...KNOWN_GAPS.keys()].filter((key) => !open.has(key));
    expect(healed, "listed as a known gap and now written: delete the entry").toEqual([]);
  });

  it("keeps the allow list honest", () => {
    /**
     * An entry that is no longer depended on anywhere is a rule about
     * nothing, and a list of those is how an allow list becomes a place to
     * put things.
     */
    const dependedKeys = new Set(depended.map((d) => `${d.table}.${d.column}`));
    const stale = [...WRITTEN_ELSEWHERE.keys()].filter((key) => !dependedKeys.has(key));
    expect(stale, "allowed and no longer depended on by anything").toEqual([]);
  });
});
