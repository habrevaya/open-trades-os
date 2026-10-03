# Connecting a phone number

The product decides what to send and whether it may be sent. A provider
adapter hands it to a carrier. The two are separated so a contractor can point
this at whichever carrier they already pay, and can leave.

Twilio ships in the box. An adapter is roughly eighty lines: send, verify a
webhook, parse what arrives.

## What the provider is not asked

**Consent.** The decision is made in `@opentradesos/core` before a provider is
chosen, against the consent rows and the suppression list, at send time rather
than when the workflow was written. A carrier's own opt out handling is a
courtesy and not a compliance position: it does not know about the consent a
customer gave on a form in 2024, and it does not know your quiet hours.

**Threading.** Providers thread by number pair, which splits a conversation
the moment you send from a pool or a customer moves house. Threads here are
keyed on the customer's address.

## Connecting Twilio

1. Add the number in the product, in E.164, and mark it registered once your
   A2P 10DLC campaign is approved. An unregistered send is not merely
   rejected: it counts against the sender.
2. Connect Twilio on **Settings → Integrations** (or `POST /v1/connectors/twilio`
   through the API) with the account SID and, optionally, a messaging service:

   ```json
   { "accountSid": "AC...", "messagingServiceSid": "MG..." }
   ```

   `messagingServiceSid` is optional. Without it, sends go from the number on
   the message.
3. Put the auth token where your deployment keeps secrets and give the
   connection its name as the credential. The token never goes in the
   database.
4. A webhook token is minted for the connection the first time it is
   connected, and the screen shows the webhook address it makes. It is never
   replaced by an edit, because the carrier is already calling it. (A token
   set by hand in `settings.webhookToken` must be at least 32 characters;
   anything shorter is refused, so a weak one means no webhooks rather than an
   open endpoint.)
5. Set `PUBLIC_URL` to the address the carrier reaches you on. The signature is
   computed over it.
6. Point Twilio's inbound and status callbacks at:

   ```
   https://your-host/api/webhooks/messaging/<webhookToken>
   ```

One endpoint serves every provider, because what differs between them is
parsing and signing and both are the adapter's job.

The same connection answers calls to tracking numbers bought on the settings
screen; `docs/self-hosting/voice.md` covers that side.

The token in the path is what identifies the tenant. Not the `To` number: a
company's phone number is printed on their truck, and routing on it would let
anyone aim a forged message at a tenant they picked. Not a header or a query
parameter either, since both are things the caller chooses. The token is a
secret the carrier must already hold, and it is inside the URL the signature
covers, so it cannot be moved to a URL an attacker controls.

## Secrets are names, for every provider

Every secret a connection needs is a name in your deployment's secret store:
the main credential is `credentialRef`, and a provider that needs a second one
takes a second name in a setting ending in `Ref`. Resend's webhook signing
secret is `webhookSecretRef`; Stripe's is `webhookSecretRef` too. The settings
a provider may store are declared in `packages/core/src/connectors/settings.ts`,
and a connect call carrying anything else is refused, as is a name that is
plainly the secret itself (`whsec_...`, `sk_live_...`).

An earlier version stored Resend's signing secret itself in
`settings.webhookSecret`. An install that has one keeps verifying with it, logs
a deprecation warning, and shows a notice on **Settings → Integrations**. Put
the value in your secret store and enter its name there; the stored copy is
deleted in the same write. Nothing can store a new one.

The webhook token in the path is the one secret-looking value kept in
`settings`, on purpose: it is looked up before the tenant is known, and it
does not authenticate anything by itself, because every request is still
checked against a signature made with a secret that is in the store.

## The webhook signature is not optional

Every provider must implement `verify`, and the inbound path checks it before
it parses, let alone acts.

An unverified endpoint lets anyone on the internet:

- forge a `STOP` from a customer, and the suppression list is deliberately
  hard to undo
- forge a message into a conversation an operator will read and act on
- forge a delivery receipt saying a text arrived when it did not

The URL passed to `verify` must be the one you configured with the carrier,
including scheme, host and query string. Behind a load balancer the request
often arrives as `http` on an internal hostname, so pass your public URL
rather than reconstructing it from headers, which an attacker can set.

## Sending

Nothing sends synchronously. A workflow writes a message with status `queued`
and stops there, because a step that claimed to have sent something it had
only written to a table would make the whole log untrustworthy. The
[worker](./worker.md) hands it to the carrier.

The row is claimed before the carrier is called, with a conditional update, so
two workers cannot both take it and a process that dies mid-send leaves a row
visibly stuck in `sending` rather than one that quietly goes out again. A
customer receiving the same reminder three times is the failure an operator
hears about.

A retryable failure (rate limit, carrier outage) goes back to `queued`. A
permanent one (invalid number) stays `failed`, because retrying a disconnected
number forever is how a queue stops being a queue.

`sent` means the carrier accepted it. `delivered` means a receipt said so.
Receipts arrive out of order and a later `sent` never moves a `delivered`
message backwards.

## Replies to email

Customers replying to an invoice or an estimate reach the inbox when the email
provider receives mail as well as sending it. With Resend:

1. Add a receiving domain in Resend (a subdomain such as
   `replies.yourcompany.com`, with the MX record Resend gives you).
2. Enter that domain as "Domain Resend receives replies on" on the Resend
   connection under Settings, Integrations.
3. Subscribe the webhook you already pointed at this installation to
   `email.received` as well as the delivery events.

Every email then carries `reply+TOKEN@` that domain as its Reply-To, the token
being the thread's own, and a reply lands in that thread. The webhook is signed
with the same secret as delivery callbacks; without that secret nothing comes
in. Resend's webhook carries only the envelope, so the words are fetched from
its received emails API with the connection's API key. Plain SMTP cannot
receive, so replies to mail sent that way go to the From mailbox as before.

## Pictures

A picture texted in is fetched from Twilio with the account's credentials and
kept in this installation's file store. A picture sent from the inbox is
fetched BY Twilio from `PUBLIC_URL` under the messaging webhook path, so
`PUBLIC_URL` must be reachable from the internet for pictures to go out, as it
must for webhooks to come in. Each picture's address carries a random key of
its own and answers for a week.

## Writing an adapter

Implement `MessagingProvider` and call `registerProvider` at module scope.
Nothing in the send path imports a carrier by name, so a deployment that uses
your adapter never loads Twilio's.

```ts
registerProvider("my-carrier", (settings, secret) => ({
  name: "my-carrier",
  async send(message) { /* ... */ },
  verify(request) { /* constant time, over the raw body */ },
  parseInbound(request) { /* ... */ },
  parseDelivery(request) { /* ... */ },
}));
```

Two things to get right, because both fail silently:

- **Verify over the raw body.** Re-serializing a parsed body changes byte
  order and breaks every signature, and the usual fix for that is to stop
  checking.
- **Compare in constant time.** A byte-at-a-time string compare leaks the
  signature through timing.
