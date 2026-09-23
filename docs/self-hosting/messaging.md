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
2. Create an `integration_connection` with capability `messaging`, provider
   `twilio`, status `connected`, and `settings`:

   ```json
   { "accountSid": "AC...", "messagingServiceSid": "MG..." }
   ```

   `messagingServiceSid` is optional. Without it, sends go from the number on
   the message.
3. Put the auth token where your deployment keeps secrets and set
   `credentialRef` to its name. The token never goes in the database.
4. Point Twilio's inbound and status callbacks at your webhook endpoint.

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
