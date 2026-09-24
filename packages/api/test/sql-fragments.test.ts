import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A SUBQUERY IN A SELECT LIST LOSES ITS TABLE NAMES
 *
 * Interpolating a column into a `sql` template does not always render the
 * same thing, and that is the whole trap.
 *
 * In a `where`, drizzle qualifies: `${schema.customer.id}` comes out as
 * `"customer"."id"`, so a correlated subquery written that way is correct
 * and three in this codebase are.
 *
 * In a `select({ ... })` projection it does not. The same interpolation
 * comes out as the BARE `"id"`, because a select list is where drizzle
 * strips table prefixes to build its aliases. Inside a subquery in that
 * position, a bare name resolves against the INNER table:
 *
 *   sql`(select count(*) from ${schema.rateCardLine}
 *        where ${schema.rateCardLine.rateCardId} = ${schema.rateCard.id})`
 *
 * renders `where "rate_card_id" = "id"`, which Postgres reads as
 * `rate_card_line.rate_card_id = rate_card_line.id`. Valid SQL, no warning,
 * never true.
 *
 * The count comes back zero for every row, and zero is a plausible answer.
 * It shipped twice here within an hour: a tracking number's call count,
 * reading as "this campaign has produced nothing", and a rate card's line
 * count, which made the contracts screen warn that every contract in the
 * company had an empty rate card.
 *
 * Nothing else catches it. The types are satisfied, the query runs, and a
 * test catches it only if somebody asserted a NON ZERO count, which is
 * exactly the assertion people leave out.
 *
 * So the rule is narrow and matches the failure: inside a `.select({...})`,
 * a `sql` fragment that opens a subquery must write its identifiers out
 * rather than interpolate a column.
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

/** A fragment containing a nested SELECT, which is where bare names stop being safe. */
const opensSubquery = (body: string) => /\(\s*(?:\n\s*)?select\b/i.test(body);

/** `sql` or `sql<number>` tagging a template literal. */
function isSqlTag(node: ts.Node): node is ts.TaggedTemplateExpression {
  if (!ts.isTaggedTemplateExpression(node)) return false;
  const tag = node.tag;
  if (ts.isIdentifier(tag)) return tag.text === "sql";
  if (ts.isExpressionWithTypeArguments(tag) && ts.isIdentifier(tag.expression)) {
    return tag.expression.text === "sql";
  }
  return false;
}

interface Fragment { path: string; line: number; body: string; inSelectList: boolean }

function scan(): Fragment[] {
  const found: Fragment[] = [];

  for (const path of sources(API_SRC)) {
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    const relative = path.slice(API_SRC.length + 1);

    const visit = (node: ts.Node, inSelectList: boolean) => {
      let selectList = inSelectList;

      /** The object literal argument of a `.select(...)` call, and nothing else. */
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "select") {
        for (const argument of node.arguments) {
          if (ts.isObjectLiteralExpression(argument)) visit(argument, true);
          else visit(argument, inSelectList);
        }
        visit(node.expression, inSelectList);
        return;
      }

      if (isSqlTag(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push({
          path: relative, line: line + 1, inSelectList: selectList,
          body: node.template.getText(file),
        });
      }

      ts.forEachChild(node, (child) => visit(child, selectList));
    };

    visit(file, false);
  }

  return found;
}

describe("sql fragments", () => {
  const all = scan();

  it("finds the fragments at all", () => {
    /**
     * The vacuous case. A scanner that matched nothing reports no broken
     * subqueries, which is the same clean bill of health the defect itself
     * produces.
     */
    expect(all.length).toBeGreaterThan(20);
  });

  it("can tell a select list from a where clause", () => {
    /**
     * Both halves, because the check below is the intersection of them. If
     * either never matched it would pass over a file full of the defect.
     */
    expect(all.filter((f) => f.inSelectList).length).toBeGreaterThan(0);
    expect(all.filter((f) => opensSubquery(f.body)).length).toBeGreaterThan(0);
  });

  it("does not interpolate a column into a subquery in a select list", () => {
    const bad = all
      .filter((f) => f.inSelectList && opensSubquery(f.body)
        && /\$\{\s*schema\.\w+\.\w+\s*\}/.test(f.body))
      .map((f) => `${f.path}:${f.line}`);

    /**
     * Fix by writing the identifiers: `from "rate_card_line" l where
     * l.rate_card_id = "rate_card"."id"`. Interpolate values, never columns.
     */
    expect(bad, "a correlated subquery whose join condition compares a table to itself").toEqual([]);
  });
});
