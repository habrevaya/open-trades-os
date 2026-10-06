import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * AN S3 COMPATIBLE BUCKET IN THIS PROCESS
 *
 * The calls the product makes and nothing else: put, get, head, delete, list,
 * and the three of a multipart upload. Served over real HTTP on a loopback
 * port, so the client's URLs, headers and bodies are exercised as they would be
 * against Amazon or a MinIO.
 *
 * IT CHECKS THE SIGNATURE, with its own implementation of Signature Version 4
 * rather than the client's, so a request the client signs wrongly is refused
 * here the way a real service would refuse it, and the payload hash is checked
 * against the body that actually arrived. A fake that accepted anything would
 * pass a client that works nowhere.
 */

export interface FakeBucket {
  url: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, { body: Buffer; contentType: string; modified: Date }>;
  /** Every request, for a test that wants to see what was asked. */
  requests: { method: string; path: string; query: string }[];
  /** Make the next matching request fail with this status and code. */
  failNext(match: (method: string, key: string) => boolean, status: number, code: string): void;
  /** Make every request answer with what was asked of it, but store something else. Simulates a bucket that corrupts. */
  corruptWrites: boolean;
  close(): Promise<void>;
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const encode = (value: string, keepSlash = false) =>
  [...Buffer.from(value, "utf8")].map((byte) => {
    const ch = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/") ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");

function verify(request: IncomingMessage, body: Buffer, rawPath: string, rawQuery: string, region: string, secret: string, accessKeyId: string): string | null {
  const auth = String(request.headers.authorization ?? "");
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!match) return "AuthorizationHeaderMalformed";
  const [, keyId, day, signedRegion, signedHeaders, signature] = match;
  if (keyId !== accessKeyId) return "InvalidAccessKeyId";
  if (signedRegion !== region) return "AuthorizationHeaderMalformed";
  const payloadHash = String(request.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== sha(body)) return "XAmzContentSHA256Mismatch";
  const amzDate = String(request.headers["x-amz-date"] ?? "");
  const names = signedHeaders!.split(";");
  const canonicalHeaders = names.map((name) => `${name}:${String(request.headers[name] ?? "").trim()}\n`).join("");
  const params = rawQuery === "" ? [] : rawQuery.split("&").map((pair) => {
    const [k, v = ""] = pair.split("=");
    return [encode(decodeURIComponent(k!)), encode(decodeURIComponent(v))] as const;
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [request.method, rawPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day!), region), "s3"), "aws4_request");
  const expected = createHmac("sha256", key).update(toSign).digest("hex");
  return expected === signature ? null : "SignatureDoesNotMatch";
}

const xmlError = (code: string, message = code) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function fakeBucket(options: {
  bucket?: string; region?: string; accessKeyId?: string; secretAccessKey?: string;
} = {}): Promise<FakeBucket> {
  const bucket = options.bucket ?? "test-bucket";
  const region = options.region ?? "us-east-1";
  const accessKeyId = options.accessKeyId ?? "AKIAFAKEFAKEFAKE1234";
  const secretAccessKey = options.secretAccessKey ?? "fake/secret/key/for/tests/only/0123456789";
  const objects: FakeBucket["objects"] = new Map();
  const uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  const requests: FakeBucket["requests"] = [];
  const failures: { match: (method: string, key: string) => boolean; status: number; code: string }[] = [];
  const state = { corruptWrites: false };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const [rawPath = "/", rawQuery = ""] = (request.url ?? "/").split("?");
      requests.push({ method: request.method ?? "", path: rawPath, query: rawQuery });
      const send = (status: number, text = "", headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/xml", ...headers });
        response.end(text);
      };
      const refused = verify(request, body, rawPath, rawQuery, region, secretAccessKey, accessKeyId);
      if (refused) return send(403, xmlError(refused));

      const segments = rawPath.split("/").slice(1);
      if (decodeURIComponent(segments[0] ?? "") !== bucket) return send(404, xmlError("NoSuchBucket"));
      const key = segments.slice(1).map(decodeURIComponent).join("/");
      const query = new URLSearchParams(rawQuery);

      const failure = failures.findIndex((f) => f.match(request.method ?? "", key));
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        return send(f!.status, xmlError(f!.code));
      }

      const method = request.method;
      if (key === "" && method === "GET" && query.get("list-type") === "2") {
        const prefix = query.get("prefix") ?? "";
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = Number(query.get("continuation-token") ?? 0);
        const page = all.slice(start, start + 2);
        const more = start + 2 < all.length;
        const contents = page.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>${objects.get(k)!.modified.toISOString()}</LastModified></Contents>`).join("");
        return send(200, `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${contents}${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`);
      }
      if (method === "POST" && query.has("uploads")) {
        const id = `upload-${uploads.size + 1}-${Date.now()}`;
        uploads.set(id, { key, contentType: String(request.headers["content-type"] ?? ""), parts: new Map() });
        return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (method === "PUT" && query.has("uploadId")) {
        const upload = uploads.get(query.get("uploadId")!);
        if (!upload) return send(404, xmlError("NoSuchUpload"));
        upload.parts.set(Number(query.get("partNumber")), body);
        return send(200, "", { etag: `"${sha(body).slice(0, 32)}"` });
      }
      if (method === "POST" && query.has("uploadId")) {
        const upload = uploads.get(query.get("uploadId")!);
        if (!upload) return send(404, xmlError("NoSuchUpload"));
        const numbers = [...body.toString("utf8").matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
        const parts = numbers.map((n) => upload.parts.get(n)!);
        for (let i = 0; i < parts.length - 1; i++) {
          if (parts[i]!.length < 5 * 1024 * 1024) return send(200, xmlError("EntityTooSmall"));
        }
        objects.set(upload.key, { body: Buffer.concat(parts), contentType: upload.contentType, modified: new Date() });
        uploads.delete(query.get("uploadId")!);
        return send(200, `<CompleteMultipartUploadResult><Key>${esc(upload.key)}</Key></CompleteMultipartUploadResult>`);
      }
      if (method === "DELETE" && query.has("uploadId")) {
        uploads.delete(query.get("uploadId")!);
        return send(204);
      }
      if (method === "PUT") {
        const stored = state.corruptWrites ? Buffer.concat([body, Buffer.from("x")]) : body;
        objects.set(key, { body: stored, contentType: String(request.headers["content-type"] ?? ""), modified: new Date() });
        return send(200, "", { etag: `"${sha(body).slice(0, 32)}"` });
      }
      if (method === "GET" || method === "HEAD") {
        const object = objects.get(key);
        if (!object) return send(404, method === "HEAD" ? "" : xmlError("NoSuchKey"));
        response.writeHead(200, { "content-type": object.contentType, "content-length": String(object.body.length) });
        return response.end(method === "HEAD" ? undefined : object.body);
      }
      if (method === "DELETE") {
        objects.delete(key);
        return send(204);
      }
      return send(400, xmlError("NotImplemented"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    bucket, accessKeyId, secretAccessKey, objects, requests,
    failNext: (match, status, code) => { failures.push({ match, status, code }); },
    get corruptWrites() { return state.corruptWrites; },
    set corruptWrites(value: boolean) { state.corruptWrites = value; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
