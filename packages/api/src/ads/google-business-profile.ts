import { ads } from "@opentradesos/core";
import {
  PlatformRefusedError, PlatformUnavailableError, failure, jsonOf, registerAdsAdapter, textSetting,
  type AdapterInput, type AdsAdapter, type PulledReview,
} from "./provider";

/**
 * GOOGLE BUSINESS PROFILE REVIEWS
 *
 * Reads every review on one listing and posts a reply written here back to
 * it, through the Business Profile API's reviews endpoints (still under
 * `mybusiness.googleapis.com/v4`, where Google left reviews when it split the
 * rest of the API up).
 *
 * Access to this API is its own application to Google, separate from the
 * OAuth client and separate from any Ads approval, and until it is granted
 * Google answers every call with 403. That answer is passed through in
 * Google's words rather than translated into something friendlier and
 * vaguer.
 *
 * A reply posted through the API is still moderated by Google, so a reply
 * that is "posted" here can be missing there for a while, or for good. The
 * next read brings back whatever Google actually shows.
 */

const DEFAULT_BASE = "https://mybusiness.googleapis.com";
/** Fifty a page, which is Google's ceiling, and a listing with a thousand reviews is a big one. */
const MAX_PAGES = 20;

const idOf = (value: string | undefined, prefix: string) =>
  value?.replace(new RegExp(`^${prefix}/`), "").replace(/[^0-9A-Za-z_-]/g, "") || undefined;

function createBusinessProfile(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const accountId = idOf(textSetting(input.settings, "accountId"), "accounts");
  const locationId = idOf(textSetting(input.settings, "locationId"), "locations");

  async function request(url: string, init: { method: string; body?: string }): Promise<unknown> {
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Google for this listing yet.");
    const token = await input.token.accessToken();
    let response;
    try {
      response = await input.transport(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Google Business Profile could not be reached: ${(error as Error).message}`);
    }
    const body = await jsonOf(response, "Google Business Profile");
    if (response.status < 200 || response.status >= 300) {
      const message = (body as { error?: { message?: unknown } }).error?.message;
      throw failure(response.status, "Google Business Profile", typeof message === "string" ? message : "");
    }
    return body;
  }

  return {
    provider: "google_business_profile",

    async listReviews(): Promise<PulledReview[]> {
      if (!accountId || !locationId) {
        throw new PlatformRefusedError("Enter the listing's account id and location id from Google Business Profile.");
      }
      const out: PulledReview[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ pageSize: "50", ...(pageToken ? { pageToken } : {}) });
        const body = await request(
          `${base}/v4/accounts/${accountId}/locations/${locationId}/reviews?${query.toString()}`,
          { method: "GET" },
        ) as { reviews?: Record<string, unknown>[]; nextPageToken?: unknown };
        for (const raw of body.reviews ?? []) {
          const rating = ads.starRating(raw["starRating"]);
          if (typeof raw["name"] !== "string" || rating === null) continue;
          const reviewer = (raw["reviewer"] ?? {}) as { displayName?: unknown; isAnonymous?: unknown };
          const reply = raw["reviewReply"] as { comment?: unknown; updateTime?: unknown } | undefined;
          const created = new Date(String(raw["createTime"] ?? ""));
          const updated = new Date(String(raw["updateTime"] ?? raw["createTime"] ?? ""));
          out.push({
            externalId: raw["name"],
            authorName: reviewer.isAnonymous === true || typeof reviewer.displayName !== "string" ? null : reviewer.displayName,
            rating,
            comment: typeof raw["comment"] === "string" ? raw["comment"] : null,
            createdAt: Number.isNaN(created.getTime()) ? new Date() : created,
            updatedAt: Number.isNaN(updated.getTime()) ? new Date() : updated,
            reply: reply && typeof reply.comment === "string"
              ? { comment: reply.comment, updatedAt: new Date(String(reply.updateTime ?? "")) }
              : null,
          });
        }
        if (typeof body.nextPageToken !== "string" || body.nextPageToken === "") return out;
        pageToken = body.nextPageToken;
      }
      return out;
    },

    async postReply(externalId: string, comment: string) {
      if (!/^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/.test(externalId)) {
        throw new PlatformRefusedError("That review was not read from Google, so there is nothing there to reply to.");
      }
      const body = await request(`${base}/v4/${externalId}/reply`, { method: "PUT", body: JSON.stringify({ comment }) }) as {
        updateTime?: unknown;
      };
      const at = new Date(String(body.updateTime ?? ""));
      return { postedAt: Number.isNaN(at.getTime()) ? new Date() : at };
    },
  };
}

registerAdsAdapter("google_business_profile", createBusinessProfile);
