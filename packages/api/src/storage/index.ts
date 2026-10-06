import { s3Client, type S3Client } from "./s3";

export { s3Client, S3Error, sign, uriEncode, PART_BYTES, type S3Client, type S3Config, type Upload, type ListedObject } from "./s3";

/**
 * WHERE THIS DEPLOYMENT KEEPS FILES
 *
 * Postgres unless told otherwise, which is right for a contractor self hosting
 * with a few gigabytes of photographs: one database to back up, nothing else to
 * stand up. A deployment with a terabyte sets `FILE_STORAGE=s3` and a bucket,
 * and new files go there.
 *
 * Chosen per deployment rather than per company, because it is a decision
 * about the machine and the bill, not about the business, and a hosted
 * deployment that let each company choose would be running two storage
 * systems for every one it meant to.
 *
 * WHERE NEW FILES GO AND WHERE OLD ONES ARE READ FROM ARE DIFFERENT QUESTIONS.
 * `FILE_STORAGE` decides the first. The second is answered by each row, which
 * says where its own bytes are, so the bucket's settings are needed whenever
 * any row is in it, including after a deployment moves back to Postgres and
 * while the move is still going.
 *
 *   FILE_STORAGE                        postgres (the default) or s3
 *   FILE_STORAGE_S3_ENDPOINT            https://s3.us-east-1.amazonaws.com, or a MinIO or R2 address
 *   FILE_STORAGE_S3_BUCKET              the bucket
 *   FILE_STORAGE_S3_REGION              defaults to us-east-1
 *   FILE_STORAGE_S3_PREFIX              a folder inside the bucket, defaults to none
 *   FILE_STORAGE_S3_ACCESS_KEY_ID       the key id
 *   FILE_STORAGE_S3_SECRET_ACCESS_KEY   the secret key
 *   FILE_STORAGE_S3_PATH_STYLE          true (the default) or false for bucket.endpoint addresses
 */

export interface FileBucket {
  client: S3Client;
  /** Put in front of every storage key to make the object's name. */
  prefix: string;
}

export interface FileStorage {
  /** Where a file stored now goes. */
  writeTo: "postgres" | "object";
  /** The bucket, when one is configured, whichever way new files go. */
  bucket: FileBucket | null;
}

/** A deployment asked for something its settings cannot give. Said plainly, at the moment it matters. */
export class FileStorageNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStorageNotConfiguredError";
  }
}

export function fileStorageFromEnv(env: Record<string, string | undefined> = process.env): FileStorage {
  const mode = (env["FILE_STORAGE"] || "postgres").toLowerCase();
  if (mode !== "postgres" && mode !== "s3") {
    throw new FileStorageNotConfiguredError(`FILE_STORAGE is "${env["FILE_STORAGE"]}". It is postgres or s3.`);
  }
  const endpoint = env["FILE_STORAGE_S3_ENDPOINT"];
  const bucketName = env["FILE_STORAGE_S3_BUCKET"];
  const accessKeyId = env["FILE_STORAGE_S3_ACCESS_KEY_ID"];
  const secretAccessKey = env["FILE_STORAGE_S3_SECRET_ACCESS_KEY"];
  const named = [endpoint, bucketName, accessKeyId, secretAccessKey].filter(Boolean).length;

  let bucket: FileBucket | null = null;
  if (named === 4) {
    bucket = {
      client: s3Client({
        endpoint: endpoint!, bucket: bucketName!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!,
        region: env["FILE_STORAGE_S3_REGION"] || "us-east-1",
        pathStyle: (env["FILE_STORAGE_S3_PATH_STYLE"] ?? "true").toLowerCase() !== "false",
      }),
      prefix: normalisePrefix(env["FILE_STORAGE_S3_PREFIX"] ?? ""),
    };
  } else if (named > 0 || mode === "s3") {
    /**
     * Half a configuration is refused rather than quietly ignored. Falling back
     * to Postgres would keep uploads working while the operator believed their
     * photographs were in the bucket, and the database would fill up instead.
     */
    throw new FileStorageNotConfiguredError(
      "File storage in a bucket needs FILE_STORAGE_S3_ENDPOINT, FILE_STORAGE_S3_BUCKET, "
      + "FILE_STORAGE_S3_ACCESS_KEY_ID and FILE_STORAGE_S3_SECRET_ACCESS_KEY, all four.",
    );
  }
  return { writeTo: mode === "s3" ? "object" : "postgres", bucket };
}

const normalisePrefix = (prefix: string) =>
  prefix === "" ? "" : `${prefix.replace(/^\/+/, "").replace(/\/+$/, "")}/`;

let override: FileStorage | null = null;
let fromEnv: FileStorage | null = null;

/**
 * The deployment's file storage. Read from the environment once, on first use,
 * so a misconfiguration fails the first upload with its reason rather than the
 * process start, which is where nobody looks.
 */
export function fileStorage(): FileStorage {
  if (override) return override;
  fromEnv ??= fileStorageFromEnv();
  return fromEnv;
}

/** For tests and the move command: use this storage instead of the environment's. Null puts it back. */
export function useFileStorage(storage: FileStorage | null): void {
  override = storage;
}
