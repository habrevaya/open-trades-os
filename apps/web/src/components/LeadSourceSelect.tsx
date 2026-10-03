/**
 * WHERE THE WORK CAME FROM, AS A CHOICE RATHER THAN A TEXT BOX
 *
 * One select, the company's channels as groups and each channel's live
 * tracking campaigns inside it, so a CSR picks "Google Ads, Spring AC tune
 * up" or just "Google Ads" and never types "google". The value carries which
 * of the two it is (`channel:<id>` or `campaign:<id>`), and `sourceFrom` in
 * `lib/lead-source.ts` reads it back on the server, where the service checks
 * it against the channel list again.
 *
 * Not a client component: it has no state, so a server page can render it and
 * a client form can contain it.
 */
export interface SourceOption {
  id: string;
  name: string;
  archived?: boolean;
  campaigns: { id: string; name: string }[];
}

export function LeadSourceSelect({
  options, required = false, defaultValue = "", label = "Where they came from", name = "source", help, id,
}: {
  options: readonly SourceOption[];
  required?: boolean;
  defaultValue?: string;
  label?: string;
  name?: string;
  help?: string;
  /** Needed only where two selects on one page share a name. */
  id?: string;
}) {
  /**
   * Labelled by id rather than by wrapping. A label around a select takes
   * every option's text into the select's name, so a screen reader read out
   * the whole channel list and a channel called "Email" made this the field
   * called Email.
   */
  const selectId = id ?? `lead-source-${name}`;
  return (
    <div>
      <label htmlFor={selectId} className="block text-sm font-medium text-ink-700">{label}</label>
      <select id={selectId} name={name} required={required} defaultValue={defaultValue}
              className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
        <option value="">{required ? "Choose one" : "Not known yet"}</option>
        {options.map((channel) => (
          <optgroup key={channel.id} label={channel.name}>
            <option value={`channel:${channel.id}`}>{channel.name}</option>
            {channel.campaigns.map((campaign) => (
              <option key={campaign.id} value={`campaign:${campaign.id}`}>
                {channel.name}: {campaign.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {help ? <span className="mt-1 block text-xs text-ink-500">{help}</span> : null}
    </div>
  );
}
