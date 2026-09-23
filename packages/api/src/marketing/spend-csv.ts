import { marketing as mk } from "@opentradesos/core";
import { registerSpendSource, type SpendSource, type SpendDay, type SpendParse } from "./provider";

/**
 * AD SPEND FROM A CSV
 *
 * The first spend connector, and not a stopgap. It works on the day somebody
 * installs this: no OAuth consent screen, no developer token, no application
 * review that takes six weeks and can be refused. Every ads platform exports
 * a daily CSV and every contractor already knows how to download one.
 *
 * It is also the ONLY way the offline half of a trades company's marketing
 * ever gets measured. A yard sign order, a radio buy, a sponsorship of the
 * under-elevens: no API will ever report those, and a product whose spend
 * report only understands what an ad platform tells it will always show a
 * company spending less than it does.
 *
 * WHAT MAKES THIS HARDER THAN IT LOOKS
 *
 * A real export from a contractor is not a clean file. It has a totals row
 * at the bottom, a currency symbol in the amount, thousands separators, a
 * date in whatever format the account's locale uses, and a campaign that was
 * renamed halfway through the month. Every one of those is handled below,
 * and every one of them is a line somebody would otherwise have to clean by
 * hand every month until they stopped bothering.
 *
 * A LINE IS SKIPPED, NOT GUESSED. Where this cannot read a row it reports
 * the line number and why, and imports the rest. It never coerces an
 * unreadable amount to zero: a zero is a claim that a campaign cost nothing,
 * which is the one number in a marketing report nobody questions and the one
 * that makes a channel look free.
 */

/**
 * The columns, and every spelling the platforms use.
 *
 * Matched case insensitively with punctuation stripped, because "Cost",
 * "cost", "Cost (USD)" and "Amount spent (USD)" are the same column from
 * four accounts and a contractor should not have to rename headers.
 */
const COLUMNS: Record<string, string[]> = {
  campaign: ["campaign", "campaignname", "adset", "adsetname", "adgroup", "campaigns"],
  date: ["date", "day", "reportingstarts", "reportingdate"],
  amount: ["cost", "spend", "amount", "amountspent", "amountspentusd", "costusd", "totalcost"],
  impressions: ["impressions", "impr", "imprs"],
  clicks: ["clicks", "linkclicks", "click"],
};

const normaliseHeader = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A CSV row, respecting quotes.
 *
 * Hand rolled rather than handed to a library for one reason: a campaign
 * name with a comma in it is completely ordinary ("Austin, TX - AC Repair"),
 * and splitting on commas turns that one row into a silent column shift
 * where the date lands in the amount. That failure imports a number under
 * the wrong campaign rather than failing, which is the worst way for this to
 * be wrong.
 */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"') {
        /** A doubled quote inside a quoted field is one literal quote. */
        if (line[i + 1] === '"') { current += '"'; i += 1; } else { quoted = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out;
}

/**
 * An amount, from whatever the export wrote.
 *
 * Strips a currency symbol and thousands separators, and refuses anything
 * left over. The refusal matters: "1.234,56" is one thousand two hundred in
 * a European export and one point two in an American one, and a parser that
 * guessed would be wrong by a factor of a thousand in whichever direction
 * nobody checked.
 */
function parseAmount(raw: string): string | null {
  const text = raw.trim().replace(/^[$£€]\s*/, "").replace(/,(?=\d{3}\b)/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return text;
}

/**
 * A date, from the three shapes these exports use.
 *
 * ISO first because it is unambiguous. The American ordering is accepted
 * because Google and Meta both emit it for a US account, and it is
 * distinguished from the European one ONLY where the day exceeds twelve.
 * Where it does not, this returns null rather than picking: 03/04/2026 is
 * two different days and a report silently off by a month is worse than one
 * that asks.
 */
function parseDate(raw: string): string | null {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const slashed = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const year = slashed[3]!;
    if (second > 12 && first <= 12) {
      return `${year}-${String(first).padStart(2, "0")}-${String(second).padStart(2, "0")}`;
    }
    if (first > 12 && second <= 12) {
      return `${year}-${String(second).padStart(2, "0")}-${String(first).padStart(2, "0")}`;
    }
    return null;
  }

  /** "Mar 1, 2026" and "1 Mar 2026", which some exports use for a summary row. */
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed) && /[A-Za-z]{3}/.test(text)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

/** Rows that are not data: a blank line, or the totals row at the bottom. */
const isSummaryRow = (cells: string[]): boolean => {
  const first = (cells[0] ?? "").toLowerCase();
  return first.startsWith("total") || first.startsWith("grand total") || first === "";
};

export function csvSpendSource(): SpendSource {
  return {
    name: "spend_csv",

    parse({ text, settings }): SpendParse {
      /**
       * The source is declared by the operator when they set the import up,
       * not sniffed from the file. A Google Ads export does not say it is
       * Google Ads anywhere in it, and guessing from a campaign name would
       * put a company's whole Meta budget under Google the first time
       * somebody named a campaign "google retargeting test".
       */
      const source = String(settings["source"] ?? "");
      if (!(mk.LEAD_SOURCE_KEYS as readonly string[]).includes(source)) {
        return {
          ok: false,
          reason:
            `This import has no lead source set, or one the catalogue does not know ("${source}"). `
            + "Say which channel the file is for: the file itself does not say, and guessing from campaign names puts a whole budget under the wrong channel.",
        };
      }

      const lines = text.split(/\r?\n/);
      const headerLine = lines.findIndex((line) => line.trim() !== "");
      if (headerLine === -1) return { ok: false, reason: "That file is empty." };

      const headers = splitRow(lines[headerLine]!).map(normaliseHeader);
      const indexOf = (field: keyof typeof COLUMNS): number =>
        headers.findIndex((h) => COLUMNS[field]!.includes(h));

      const dateAt = indexOf("date");
      const amountAt = indexOf("amount");
      if (dateAt === -1 || amountAt === -1) {
        return {
          ok: false,
          reason:
            "That file has no date column or no cost column, so there is nothing to import. "
            + `Found: ${headers.filter(Boolean).join(", ") || "nothing"}.`,
        };
      }
      const campaignAt = indexOf("campaign");
      const impressionsAt = indexOf("impressions");
      const clicksAt = indexOf("clicks");

      const rows: SpendDay[] = [];
      const skipped: { line: number; reason: string }[] = [];

      for (let i = headerLine + 1; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (line.trim() === "") continue;

        const cells = splitRow(line);
        /**
         * The totals row is skipped SILENTLY rather than reported, because
         * every export has one and a list of skips that is one entry long
         * every single month trains somebody to ignore the list.
         */
        if (isSummaryRow(cells)) continue;

        const spentOn = parseDate(cells[dateAt] ?? "");
        if (!spentOn) {
          skipped.push({
            line: i + 1,
            reason: `"${cells[dateAt] ?? ""}" is not a date this can read without guessing which number is the month.`,
          });
          continue;
        }

        const amount = parseAmount(cells[amountAt] ?? "");
        if (amount === null) {
          skipped.push({ line: i + 1, reason: `"${cells[amountAt] ?? ""}" is not an amount.` });
          continue;
        }

        const whole = (index: number): number | null => {
          if (index === -1) return null;
          const raw = (cells[index] ?? "").replace(/,/g, "").trim();
          if (raw === "") return null;
          const value = Number(raw);
          return Number.isInteger(value) && value >= 0 ? value : null;
        };

        rows.push({
          source,
          campaign: campaignAt === -1 ? null : (cells[campaignAt] ?? "").trim() || null,
          spentOn,
          amount,
          impressions: whole(impressionsAt),
          clicks: whole(clicksAt),
          externalId: null,
        });
      }

      if (rows.length === 0) {
        return {
          ok: false,
          reason: skipped.length > 0
            ? `Every row in that file was unreadable. The first problem: ${skipped[0]!.reason}`
            : "That file has a header and no rows.",
        };
      }

      return { ok: true, rows, skipped };
    },
  };
}

registerSpendSource("spend_csv", csvSpendSource);
