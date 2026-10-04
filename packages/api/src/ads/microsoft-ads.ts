import { splitRow } from "../marketing/spend-csv";
import {
  failure, jsonOf, registerAdsAdapter, textSetting, PlatformRefusedError, PlatformUnavailableError,
  type AdapterInput, type AdsAdapter, type PulledSpend,
} from "./provider";
import { firstCsvIn } from "./zip";

/**
 * MICROSOFT ADVERTISING, AS A REPORT JOB
 *
 * Google and Meta answer a spend question with rows. Microsoft answers it
 * with a receipt: the report is SUBMITTED, Microsoft prepares it in its own
 * time, it is POLLED until it says Success, and then it is DOWNLOADED from a
 * short lived address as a zip holding one CSV. Three steps, each of which
 * can fail on its own, which is why this platform was the one left out when
 * the others were built.
 *
 * Through the Reporting service's REST interface, with the four headers every
 * Microsoft Advertising request carries: the access token, the developer
 * token, the customer (the manager) and the account the campaigns are in.
 *
 * THE WAIT IS BOUNDED. A report for a contractor's account is ready in
 * seconds, so this polls a handful of times a couple of seconds apart and
 * then gives up with "still being prepared", which the pull records and the
 * next pull, six hours on, asks again. A worker that waited as long as
 * Microsoft liked would hold every other company's texts behind it.
 *
 * The download address is Microsoft's own storage and is fetched with no
 * token at all, because it carries its own signature and a bearer token sent
 * to a storage host is a token sent somewhere it was not meant for.
 */

const DEFAULT_BASE = "https://reporting.api.bingads.microsoft.com/Reporting/v13";
const POLLS = 6;
const POLL_MS = 2_000;

/** Microsoft's error words, from wherever it put them. */
function microsoftMessage(body: unknown): string {
  const value = body as {
    Message?: unknown; message?: unknown;
    OperationErrors?: { Message?: unknown; ErrorCode?: unknown }[];
    BatchErrors?: { Message?: unknown; ErrorCode?: unknown }[];
  };
  const first = [...(value.OperationErrors ?? []), ...(value.BatchErrors ?? [])][0];
  if (first) return [first.ErrorCode, first.Message].filter((p) => typeof p === "string").join(": ");
  const words = value.Message ?? value.message;
  return typeof words === "string" ? words : "";
}

const dateParts = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return { Day: day, Month: month, Year: year };
};

/**
 * A report day as Microsoft writes it. ISO in the current format; month
 * first in the older one, which Microsoft documents as month first whatever
 * the account's locale, so it is read that way rather than guessed at.
 */
function reportDay(raw: string): string | null {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  return us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : null;
}

function createMicrosoftAds(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const customerId = textSetting(input.settings, "customerId")?.replace(/\D/g, "") || undefined;
  const accountId = textSetting(input.settings, "accountId")?.replace(/\D/g, "") || undefined;
  const developerToken = input.secrets["developerToken"];
  /** Overridable so the tests do not sleep. */
  const wait = typeof input.settings["pollMs"] === "number" ? input.settings["pollMs"] as number : POLL_MS;

  function ready() {
    if (!customerId || !accountId) {
      throw new PlatformRefusedError("Enter the Microsoft Advertising customer id and account id, both from the top of its screen.");
    }
    if (!developerToken) throw new PlatformRefusedError("The Microsoft Advertising developer token is not in the secret store under the name given.");
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Microsoft for this connection yet.");
    return { customerId, accountId, developerToken };
  }

  async function call(path: string, body: Record<string, unknown>): Promise<unknown> {
    const ids = ready();
    const token = await input.token!.accessToken();
    let response;
    try {
      response = await input.transport(`${base}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          DeveloperToken: ids.developerToken,
          CustomerId: ids.customerId,
          CustomerAccountId: ids.accountId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Microsoft Advertising could not be reached: ${(error as Error).message}`);
    }
    const parsed = await jsonOf(response, "Microsoft Advertising");
    if (response.status < 200 || response.status >= 300) {
      throw failure(response.status, "Microsoft Advertising", microsoftMessage(parsed));
    }
    return parsed;
  }

  return {
    provider: "bing_ads",

    async pullSpend(range) {
      const ids = ready();
      /* 1. Submit. */
      const submitted = await call("GenerateReport/Submit", {
        ReportRequest: {
          Type: "CampaignPerformanceReportRequest",
          ReportName: "OpenTradesOS daily spend",
          Format: "Csv",
          FormatVersion: "2.0",
          ExcludeReportHeader: true,
          ExcludeReportFooter: true,
          ExcludeColumnHeaders: false,
          ReturnOnlyCompleteData: false,
          Aggregation: "Daily",
          Columns: ["TimePeriod", "AccountId", "CampaignId", "CampaignName", "Spend", "Impressions", "Clicks", "CurrencyCode"],
          Scope: { AccountIds: [Number(ids.accountId)] },
          Time: { CustomDateRangeStart: dateParts(range.from), CustomDateRangeEnd: dateParts(range.to) },
        },
      }) as { ReportRequestId?: unknown };
      const requestId = submitted.ReportRequestId;
      if (typeof requestId !== "string" || requestId === "") {
        throw new PlatformUnavailableError("Microsoft Advertising took the report request and gave no id to ask after it by.");
      }

      /* 2. Poll, a bounded number of times. */
      let downloadUrl: string | null = null;
      for (let attempt = 0; ; attempt++) {
        const polled = await call("GenerateReport/Poll", { ReportRequestId: requestId }) as {
          ReportRequestStatus?: { Status?: unknown; ReportDownloadUrl?: unknown };
        };
        const status = polled.ReportRequestStatus?.Status;
        if (status === "Success") {
          const url = polled.ReportRequestStatus?.ReportDownloadUrl;
          /** Success with no address is Microsoft's way of saying the range had no data at all. */
          downloadUrl = typeof url === "string" && url !== "" ? url : null;
          break;
        }
        if (status === "Error") {
          throw new PlatformRefusedError("Microsoft Advertising could not prepare the spend report. Its reporting service said Error and gave no reason.");
        }
        if (attempt + 1 >= POLLS) {
          throw new PlatformUnavailableError(
            "Microsoft Advertising is still preparing the spend report. It will be asked for again at the next pull.",
          );
        }
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      if (!downloadUrl) return [];

      /* 3. Download, with no token: the address carries its own signature. */
      let response;
      try {
        response = await input.transport(downloadUrl, { method: "GET", headers: { Accept: "application/zip" } });
      } catch (error) {
        throw new PlatformUnavailableError(`Microsoft's report download could not be reached: ${(error as Error).message}`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw failure(response.status === 403 ? 503 : response.status, "Microsoft's report download", "");
      }
      /** Bytes, never text: a zip read as text is a zip with its high bytes replaced. */
      if (!response.arrayBuffer) throw new PlatformUnavailableError("This deployment's HTTP client cannot read a zipped report.");
      const bytes = Buffer.from(await response.arrayBuffer());
      const csv = firstCsvIn(bytes, "Microsoft Advertising");

      const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
      const header = (lines.shift() ?? "").split(",").map((h) => h.replace(/"/g, "").trim());
      const col = (name: string) => header.indexOf(name);
      const [day, account, campaign, campaignName, spend, impressions, clicks, currency] =
        ["TimePeriod", "AccountId", "CampaignId", "CampaignName", "Spend", "Impressions", "Clicks", "CurrencyCode"].map(col);
      if ([day, campaign, spend].some((i) => i === undefined || i < 0)) {
        throw new PlatformUnavailableError("Microsoft Advertising's report came back without the day, campaign and spend columns.");
      }
      const out: PulledSpend[] = [];
      for (const line of lines) {
        const cells = splitRow(line);
        const when = reportDay(cells[day!] ?? "");
        const amount = (cells[spend!] ?? "").replace(/,/g, "").trim();
        const id = (cells[campaign!] ?? "").trim();
        if (!when || !/^\d+(\.\d+)?$/.test(amount) || id === "") continue;
        if (Number(amount) === 0) continue;
        const [whole, fraction = ""] = amount.split(".");
        const count = (index: number | undefined) => {
          if (index === undefined || index < 0) return null;
          const n = Number((cells[index] ?? "").replace(/,/g, ""));
          return Number.isFinite(n) ? Math.trunc(n) : null;
        };
        out.push({
          accountId: (account !== undefined && account >= 0 ? cells[account] : undefined)?.trim() || ids.accountId,
          campaignId: id,
          campaignName: (campaignName !== undefined && campaignName >= 0 ? cells[campaignName] : undefined)?.trim() || `Campaign ${id}`,
          channelType: null,
          day: when,
          /** Exactly as Microsoft wrote it, cut to four places rather than rounded through a float. */
          amount: `${whole}.${fraction.padEnd(4, "0").slice(0, 4)}`,
          impressions: count(impressions),
          clicks: count(clicks),
          currency: (currency !== undefined && currency >= 0 ? cells[currency] : undefined)?.trim() || "USD",
        });
      }
      return out;
    },
  };
}

registerAdsAdapter("bing_ads", createMicrosoftAds);
