import { describe, it, expect } from "vitest";
import { checkReviewWording, REVIEW_WORDING_PLACEHOLDERS } from "../src/reviews/index.js";
import { REVIEW_ASK_WORDING, REVIEW_REMINDER_WORDING } from "../src/automation/index.js";

/**
 * THE WORDS OF A REVIEW MESSAGE, AS A PERSON TYPES THEM
 *
 * The reminder's words are the company's to change now, so the rules the
 * shipped words were held to by tests become a check on what is typed: only
 * the ask's placeholders, the link in the text and the email, and nothing
 * offered for a review or stars asked for.
 */
const words = (change: Partial<{ sms: string; emailSubject: string; emailBody: string }> = {}) => ({
  sms: "Hi {{ customer.name }}, a reminder from {{ organization.name }}: {{ review.url }}",
  emailSubject: "A reminder from {{ organization.name }}",
  emailBody: "Hi {{ customer.name }},\n\nIf you have a minute: {{ review.url }}\n\n{{ organization.name }}",
  ...change,
});

describe("the words of a review message", () => {
  it("passes the words we ship, for the ask and the reminder", () => {
    expect(checkReviewWording({ ...REVIEW_ASK_WORDING })).toEqual({ ok: true });
    expect(checkReviewWording({ ...REVIEW_REMINDER_WORDING })).toEqual({ ok: true });
    expect(checkReviewWording(words())).toEqual({ ok: true });
  });

  it("takes only the ask's placeholders, and names one it cannot fill", () => {
    expect(REVIEW_WORDING_PLACEHOLDERS).toEqual(["customer.name", "organization.name", "review.url"]);
    expect(checkReviewWording(words({ sms: "Hi {{ customer.firstName }}: {{ review.url }}" })))
      .toEqual({ ok: false, reason: expect.stringContaining("The text uses {{ customer.firstName }}") });
    expect(checkReviewWording(words({ emailSubject: "About {{ job.number }}" })))
      .toEqual({ ok: false, reason: expect.stringContaining("The email's subject uses {{ job.number }}") });
    // Spacing inside the braces does not matter, as when the message is filled in.
    expect(checkReviewWording(words({ sms: "Hi {{customer.name}}: {{review.url}}" }))).toEqual({ ok: true });
  });

  it("needs the link in the text and the email, and not in the subject", () => {
    expect(checkReviewWording(words({ sms: "Hi {{ customer.name }}, please review us." })))
      .toEqual({ ok: false, reason: "The text has no {{ review.url }}, so the customer would have no link to leave a review." });
    expect(checkReviewWording(words({ emailBody: "Hi, please review us." })))
      .toEqual({ ok: false, reason: expect.stringContaining("The email has no {{ review.url }}") });
  });

  it("refuses anything offered for a review, and a nudge toward a number of stars", () => {
    for (const sms of [
      "Leave a review for 10% off your next visit: {{ review.url }}",
      "Review us and get a $20 gift card: {{ review.url }}",
      "Reviewers are entered in our raffle: {{ review.url }}",
    ]) {
      expect(checkReviewWording(words({ sms }))).toEqual({ ok: false, reason: expect.stringContaining("offers something") });
    }
    for (const sms of [
      "A 5 star review would mean the world: {{ review.url }}",
      "Five-star reviews help us most: {{ review.url }}",
    ]) {
      expect(checkReviewWording(words({ sms }))).toEqual({ ok: false, reason: expect.stringContaining("number of stars") });
    }
    // Ordinary words that merely look close are fine.
    expect(checkReviewWording(words({ emailBody: "Feel free to reply with anything that was not right. {{ review.url }}" })))
      .toEqual({ ok: true });
  });

  it("refuses an empty part, and one too long to send", () => {
    expect(checkReviewWording(words({ emailSubject: "  " })))
      .toEqual({ ok: false, reason: "The email's subject is empty. Write something, or put back the words we ship." });
    expect(checkReviewWording(words({ sms: `${"a".repeat(700)} {{ review.url }}` })))
      .toEqual({ ok: false, reason: expect.stringContaining("Keep it to 640") });
  });
});
