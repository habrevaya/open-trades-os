/**
 * A lead source picked on a form, back into the two ids the services take.
 *
 * `LeadSourceSelect` posts `channel:<id>` or `campaign:<id>`, or nothing. A
 * value of any other shape is dropped rather than guessed at: the service then
 * sees no choice, which is either fine or refused in words when the company
 * requires one.
 */
export function sourceFrom(form: FormData, name = "source"): { channelId?: string; campaignId?: string } {
  const raw = form.get(name);
  if (typeof raw !== "string") return {};
  const [kind, id] = raw.split(":");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return {};
  if (kind === "campaign") return { campaignId: id };
  if (kind === "channel") return { channelId: id };
  return {};
}

/** What a record's current source is, as the select's value. */
export function sourceValue(record: { channelId?: string | null; acquisitionCampaignId?: string | null }): string {
  if (record.acquisitionCampaignId) return `campaign:${record.acquisitionCampaignId}`;
  if (record.channelId) return `channel:${record.channelId}`;
  return "";
}
