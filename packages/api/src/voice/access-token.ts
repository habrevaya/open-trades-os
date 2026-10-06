import { createHmac, randomBytes } from "node:crypto";

/**
 * THE BROWSER PHONE'S PASS
 *
 * The carrier's browser library will only register a browser, or let it place
 * a call, with a short lived token signed by an API key on the company's own
 * account. This writes that token: a JSON Web Token with the carrier's own
 * header and a voice grant naming the person's browser identity and the
 * application its calls go through.
 *
 * Written here rather than with the carrier's helper library for the reason
 * the rest of this adapter is written against the HTTP API directly: a self
 * hoster can read every byte that leaves their network, and this is forty
 * lines rather than a dependency.
 *
 * The API key's secret is read from the deployment's secret store by name, at
 * the moment of signing, and is never stored here or sent anywhere: the token
 * carries a signature made with it, not it.
 */

const b64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export interface AccessTokenInput {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  identity: string;
  /** The carrier application outgoing calls are placed through. */
  applicationSid: string;
  /** Whether the browser may be rung. Off for somebody who is only placing calls. */
  incoming: boolean;
  ttlSeconds: number;
  now: Date;
}

export function voiceAccessToken(input: AccessTokenInput): { token: string; expiresAt: Date } {
  const issued = Math.floor(input.now.getTime() / 1000);
  const expires = issued + input.ttlSeconds;
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    /** Unique per token, as the carrier asks: the key and a random tail. */
    jti: `${input.apiKeySid}-${randomBytes(8).toString("hex")}`,
    iss: input.apiKeySid,
    sub: input.accountSid,
    iat: issued,
    nbf: issued,
    exp: expires,
    grants: {
      identity: input.identity,
      voice: {
        ...(input.incoming ? { incoming: { allow: true } } : {}),
        outgoing: { application_sid: input.applicationSid },
      },
    },
  };
  const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", input.apiKeySecret).update(signing).digest("base64url");
  return { token: `${signing}.${signature}`, expiresAt: new Date(expires * 1000) };
}
