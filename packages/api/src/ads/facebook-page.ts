import { ads } from "@opentradesos/core";
import {
  PlatformRefusedError, PlatformUnavailableError, jsonOf, registerAdsAdapter, textSetting,
  type AdapterInput, type AdsAdapter, type PulledReview,
} from "./provider";
import { metaError } from "./meta-lead-ads";

/**
 * A FACEBOOK PAGE'S RATINGS AND RECOMMENDATIONS
 *
 * Read from the Graph API's `/{page}/ratings` edge into the ordinary review
 * table every hour, and a reply written here posted back as a comment from
 * the Page, which is how a Page answers a recommendation on Facebook itself.
 *
 * Meta answers a Page's ratings only to the Page's own token, and only with
 * `pages_read_user_content` granted to an app that has passed Meta's app
 * review for it; posting as the Page needs `pages_manage_engagement`, also
 * reviewed. So the person's sign in reads the Page's token
 * (`/{page}?fields=access_token`), the same way the instant forms adapter
 * does, and everything else is asked with that. Until the app is reviewed,
 * Meta refuses with its own words, and those are what the connection shows.
 *
 * A RATING IS NOT A THING WITH AN ID. What Facebook gives a rating to reply
 * to is the story it made on the Page (`open_graph_story`), so that story's
 * id is the review's external id and the place a reply goes. The rare rating
 * with no story (an old one, or one whose story was removed) is still read,
 * under an id made from who left it and when, and a reply to it is refused
 * in words rather than sent somewhere it cannot land.
 *
 * Stars or a recommendation become a rating through `facebookRating` in
 * core, which says why a yes is five and a no is one.
 */

const DEFAULT_BASE = "https://graph.facebook.com";
const DEFAULT_VERSION = "v21.0";
/** A hundred a page; twenty pages is two thousand ratings, which is a very well known Page. */
const MAX_PAGES = 20;
const FIELDS = [
  "created_time", "has_rating", "has_review", "rating", "recommendation_type", "review_text",
  "reviewer{id,name}", "open_graph_story{id,comments.limit(25){message,created_time,from{id}}}",
].join(",");

/** The id a story-less rating is kept under. Never a story id, so a reply to it is refused. */
const LOOSE_PREFIX = "facebook-rating:";

function createFacebookPage(input: AdapterInput): AdsAdapter {
  const base = (textSetting(input.settings, "baseUrl") ?? DEFAULT_BASE).replace(/\/$/, "");
  const version = textSetting(input.settings, "apiVersion") ?? DEFAULT_VERSION;
  const pageId = textSetting(input.settings, "pageId")?.replace(/\D/g, "") || undefined;
  let pageToken: string | null = null;

  async function call(url: string, token: string, init: { method: string; body?: string } = { method: "GET" }): Promise<unknown> {
    let response;
    try {
      response = await input.transport(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });
    } catch (error) {
      throw new PlatformUnavailableError(`Facebook could not be reached: ${(error as Error).message}`);
    }
    const parsed = await jsonOf(response, "Facebook");
    if (response.status < 200 || response.status >= 300) throw metaError(response.status, parsed);
    return parsed;
  }

  /** The Page's own token, read with the person's, once per adapter. */
  async function page(): Promise<{ id: string; token: string }> {
    if (!pageId) throw new PlatformRefusedError("Enter the id of the Facebook Page whose reviews to read.");
    if (!input.token) throw new PlatformRefusedError("Nobody has signed in with Meta for this Page yet.");
    if (!pageToken) {
      const body = await call(`${base}/${version}/${pageId}?fields=access_token`, await input.token.accessToken()) as { access_token?: unknown };
      if (typeof body.access_token !== "string") {
        throw new PlatformRefusedError(
          "Meta gave no token for that Page. The person who signed in has to be an admin of it, and grant the Page when Meta asks.",
        );
      }
      pageToken = body.access_token;
    }
    return { id: pageId, token: pageToken };
  }

  const dateOf = (value: unknown): Date => {
    const at = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
    return Number.isNaN(at.getTime()) ? new Date() : at;
  };

  return {
    provider: "facebook_page",

    async listReviews(): Promise<PulledReview[]> {
      const { id, token } = await page();
      const out: PulledReview[] = [];
      let after: string | undefined;
      for (let n = 0; n < MAX_PAGES; n++) {
        const query = new URLSearchParams({ fields: FIELDS, limit: "100", ...(after ? { after } : {}) });
        const body = await call(`${base}/${version}/${id}/ratings?${query.toString()}`, token) as {
          data?: Record<string, unknown>[];
          paging?: { cursors?: { after?: unknown }; next?: unknown };
        };
        for (const raw of body.data ?? []) {
          const rating = ads.facebookRating(raw);
          if (rating === null) continue;
          const reviewer = (raw["reviewer"] ?? {}) as { id?: unknown; name?: unknown };
          const story = (raw["open_graph_story"] ?? {}) as {
            id?: unknown;
            comments?: { data?: { message?: unknown; created_time?: unknown; from?: { id?: unknown } }[] };
          };
          const created = dateOf(raw["created_time"]);
          const text = typeof raw["review_text"] === "string" && raw["review_text"].trim() !== ""
            ? raw["review_text"] : ads.facebookVerdict(raw);
          /** The Page's own latest comment on the story is its reply, whoever here or on Facebook wrote it. */
          const fromPage = (story.comments?.data ?? [])
            .filter((c) => String(c.from?.id ?? "") === id && typeof c.message === "string")
            .sort((a, b) => dateOf(b.created_time).getTime() - dateOf(a.created_time).getTime())[0];
          out.push({
            externalId: typeof story.id === "string" && story.id !== ""
              ? story.id
              : `${LOOSE_PREFIX}${String(reviewer.id ?? reviewer.name ?? "someone")}:${created.toISOString()}`,
            authorName: typeof reviewer.name === "string" ? reviewer.name : null,
            rating,
            comment: text,
            createdAt: created,
            updatedAt: created,
            reply: fromPage ? { comment: String(fromPage.message), updatedAt: dateOf(fromPage.created_time) } : null,
          });
        }
        const next = body.paging?.cursors?.after;
        if (!body.paging?.next || typeof next !== "string" || next === "") return out;
        after = next;
      }
      return out;
    },

    async postReply(externalId: string, comment: string) {
      if (externalId.startsWith(LOOSE_PREFIX) || !/^[0-9_]+$/.test(externalId)) {
        throw new PlatformRefusedError(
          "Facebook gave this rating nothing to reply to (it has no post on the Page), so the reply has to be made on Facebook.",
        );
      }
      const { token } = await page();
      await call(`${base}/${version}/${externalId}/comments`, token, {
        method: "POST", body: new URLSearchParams({ message: comment }).toString(),
      });
      return { postedAt: new Date() };
    },
  };
}

registerAdsAdapter("facebook_page", createFacebookPage);
