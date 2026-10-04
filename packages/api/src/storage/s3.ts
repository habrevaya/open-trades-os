import { createHash, createHmac } from "node:crypto";

/**
 * AN S3 COMPATIBLE BUCKET, IN THE FEW CALLS THIS PRODUCT MAKES
 *
 * Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces and a
 * MinIO on the shop's own server all speak the same protocol, so one small
 * client covers every one of them. It is written here rather than taken from
 * the vendor's SDK for the reason the zip reader beside the ad adapters gives:
 * the SDK is tens of megabytes of code a self hoster has to trust, for eight
 * calls whose wire format has not changed in a decade.
 *
 * The calls are put, get, head, delete, list, and the three that write an
 * object too large to hold in memory a part at a time. Every request is signed
 * with Signature Version 4 over its real payload hash, which every compatible
 * service accepts; a payload left unsigned is accepted by some and not others,
 * and "works on Amazon, fails on the shop's MinIO" is the failure a self
 * hosted product cannot afford.
 */

export interface S3Config {
  /** The service's address, scheme and host (and port), no path. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** endpoint/bucket/key when true; bucket.endpoint/key when false. */
  pathStyle: boolean;
  /** Injected so a test can watch the requests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** What the bucket said, in its own words, with the code a caller can act on. */
export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

const EMPTY_HASH = createHash("sha256").update("").digest("hex");
const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as Signature Version 4 wants it: everything but the unreserved set. */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * The Authorization header for one request, by Signature Version 4.
 *
 * Exported for its test, which checks it against the worked example in
 * Amazon's own documentation rather than against this file's idea of itself.
 */
export function sign(input: {
  method: string;
  host: string;
  /** Already encoded, starting with a slash. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}): string {
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value.trim();
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(input.query).sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(input.query[key]!)}`).join("&");
  const canonicalRequest = [
    input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash,
  ].join("\n");

  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** The parts of an XML answer this client reads. A parser would be a dependency for five tags. */
function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? unescapeXml(match[1]!) : null;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The smallest part a multipart upload takes, and the size this client sends.
 * Eight megabytes, so a company's copy is held in memory a part at a time and
 * never whole, and a fifty gigabyte company is about six thousand parts, well
 * inside the ten thousand the protocol allows.
 */
export const PART_BYTES = 8 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface S3Client {
  readonly bucket: string;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** The whole object, or null when there is none. */
  get(key: string): Promise<Uint8Array | null>;
  /** The object as a stream, for one too large to hold, or null when there is none. */
  stream(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number | null } | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<ListedObject[]>;
  /** An object written a part at a time. `done` finishes it; `abort` leaves nothing behind. */
  upload(key: string, contentType?: string): Upload;
}

export interface Upload {
  write(chunk: Uint8Array): Promise<void>;
  done(): Promise<{ size: number }>;
  abort(): Promise<void>;
}

export function s3Client(config: S3Config): S3Client {
  const base = new URL(config.endpoint);
  const doFetch = config.fetch ?? fetch;
  const host = config.pathStyle ? base.host : `${config.bucket}.${base.host}`;
  const pathFor = (key: string) =>
    config.pathStyle ? `/${uriEncode(config.bucket)}/${uriEncode(key, true)}` : `/${uriEncode(key, true)}`;
  const bucketPath = config.pathStyle ? `/${uriEncode(config.bucket)}/` : "/";

  async function request(input: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: Uint8Array | string;
    headers?: Record<string, string>;
    /** Statuses that are an answer rather than a failure, such as 404 on a read. */
    accept?: number[];
  }): Promise<Response> {
    const query = input.query ?? {};
    /** A Buffer either way, which every runtime's fetch takes as a body. */
    const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8")
      : input.body ? Buffer.from(input.body) : undefined;
    const payloadHash = body ? sha256Hex(body) : EMPTY_HASH;
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(input.headers ?? {}),
    };
    const authorization = sign({
      method: input.method, host, path: input.path, query, headers, payloadHash,
      region: config.region, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, amzDate,
    });
    const search = Object.keys(query).sort()
      .map((key) => `${uriEncode(key)}=${uriEncode(query[key]!)}`).join("&");
    const url = `${base.protocol}//${host}${input.path}${search ? `?${search}` : ""}`;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: input.method,
        headers: { ...headers, authorization },
        ...(body ? { body } : {}),
      });
    } catch (error) {
      throw new S3Error(
        `Could not reach ${base.host}: ${(error as Error).message}. Check the endpoint address.`, 0, null,
      );
    }
    if (response.ok || (input.accept ?? []).includes(response.status)) return response;
    throw await failure(response);
  }

  /**
   * What went wrong, said so an owner can fix it. The bucket's own code is
   * kept for a caller to branch on; the message adds what the code usually
   * means, because "SignatureDoesNotMatch" tells nobody that the secret key
   * under that name is the wrong one.
   */
  async function failure(response: Response): Promise<S3Error> {
    const text = await response.text().catch(() => "");
    const code = tag(text, "Code");
    const said = tag(text, "Message");
    const hint: Record<string, string> = {
      AccessDenied: "The key does not have permission for this bucket.",
      InvalidAccessKeyId: "The access key id is not one the service knows.",
      SignatureDoesNotMatch: "The secret key does not match the access key id.",
      NoSuchBucket: "There is no bucket by that name at that address.",
      AuthorizationHeaderMalformed: "The region does not match the bucket's region.",
      PermanentRedirect: "The bucket is in another region, or wants its own address.",
    };
    const message = [
      `${config.bucket} answered ${response.status}${code ? ` ${code}` : ""}.`,
      code && hint[code] ? hint[code] : null,
      said && said !== code ? `It said: ${said}` : null,
    ].filter(Boolean).join(" ");
    return new S3Error(message, response.status, code);
  }

  const client: S3Client = {
    bucket: config.bucket,

    async put(key, body, contentType = "application/octet-stream") {
      await request({ method: "PUT", path: pathFor(key), body, headers: { "content-type": contentType } });
    },

    async get(key) {
      const response = await request({ method: "GET", path: pathFor(key), accept: [404] });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async stream(key) {
      const response = await request({ method: "GET", path: pathFor(key), accept: [404] });
      if (response.status === 404 || !response.body) {
        await response.body?.cancel();
        return null;
      }
      const length = response.headers.get("content-length");
      return { body: response.body, size: length ? Number(length) : null };
    },

    async head(key) {
      const response = await request({ method: "HEAD", path: pathFor(key), accept: [404] });
      if (response.status === 404) return null;
      return { size: Number(response.headers.get("content-length") ?? 0) };
    },

    async delete(key) {
      // Deleting something already gone is success in the protocol and here.
      const response = await request({ method: "DELETE", path: pathFor(key), accept: [404] });
      await response.body?.cancel();
    },

    async list(prefix) {
      const found: ListedObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < 1000; page++) {
        const query: Record<string, string> = { "list-type": "2", prefix };
        if (token) query["continuation-token"] = token;
        const xml = await (await request({ method: "GET", path: bucketPath, query })).text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const block = match[1]!;
          const key = tag(block, "Key");
          if (key === null) continue;
          const modified = tag(block, "LastModified");
          found.push({ key, size: Number(tag(block, "Size") ?? 0), lastModified: modified ? new Date(modified) : null });
        }
        if (tag(xml, "IsTruncated") !== "true") break;
        token = tag(xml, "NextContinuationToken");
        if (!token) break;
      }
      return found;
    },

    upload(key, contentType = "application/zip") {
      let buffered: Buffer[] = [];
      let bufferedBytes = 0;
      let uploadId: string | null = null;
      const parts: { number: number; etag: string }[] = [];
      let total = 0;
      let finished = false;

      async function sendPart(final: boolean): Promise<void> {
        if (bufferedBytes === 0 && !final) return;
        const body = Buffer.concat(buffered, bufferedBytes);
        buffered = [];
        bufferedBytes = 0;
        if (!uploadId) {
          const xml = await (await request({
            method: "POST", path: pathFor(key), query: { uploads: "" }, headers: { "content-type": contentType },
          })).text();
          uploadId = tag(xml, "UploadId");
          if (!uploadId) throw new S3Error(`${config.bucket} did not start the upload.`, 0, null);
        }
        const number = parts.length + 1;
        const response = await request({
          method: "PUT", path: pathFor(key), query: { partNumber: String(number), uploadId }, body,
        });
        const etag = response.headers.get("etag");
        await response.body?.cancel();
        if (!etag) throw new S3Error(`${config.bucket} did not acknowledge part ${number}.`, 0, null);
        parts.push({ number, etag });
      }

      return {
        async write(chunk) {
          if (finished) throw new Error("This upload has already finished.");
          buffered.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          bufferedBytes += chunk.byteLength;
          total += chunk.byteLength;
          if (bufferedBytes >= PART_BYTES) await sendPart(false);
        },

        async done() {
          if (finished) throw new Error("This upload has already finished.");
          finished = true;
          /**
           * Small enough to be one ordinary PUT, which is one request rather
           * than three and leaves nothing half made if it fails.
           */
          if (!uploadId) {
            await client.put(key, Buffer.concat(buffered, bufferedBytes), contentType);
            buffered = [];
            return { size: total };
          }
          await sendPart(true);
          const body = `<CompleteMultipartUpload>${parts
            .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
            .join("")}</CompleteMultipartUpload>`;
          const response = await request({
            method: "POST", path: pathFor(key), query: { uploadId }, body, headers: { "content-type": "application/xml" },
          });
          /**
           * Completing can fail AFTER the 200 has been sent, and the protocol
           * says so in the body. A copy reported as finished that is not in
           * the bucket is the worst outcome a backup can have.
           */
          const text = await response.text();
          if (/<Error>/.test(text)) {
            throw new S3Error(`${config.bucket} could not finish the upload: ${tag(text, "Message") ?? tag(text, "Code") ?? "no reason given"}.`, 200, tag(text, "Code"));
          }
          return { size: total };
        },

        async abort() {
          finished = true;
          buffered = [];
          if (!uploadId) return;
          const response = await request({ method: "DELETE", path: pathFor(key), query: { uploadId }, accept: [404] });
          await response.body?.cancel();
        },
      };
    },
  };
  return client;
}

/** Below this, a part is refused by the protocol unless it is the last. Exported for the fake's checks. */
export const MINIMUM_PART_BYTES = MIN_PART_BYTES;
