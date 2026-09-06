import crypto from "node:crypto";

export type StoredEvidenceObject = {
  key: string;
  contentType: string;
  contentLength: number;
  sha256: string;
  body: Buffer;
};

export type SignedEvidenceAccess = {
  url: string;
  expiresAt: Date;
};

export interface EvidenceObjectStorage {
  readonly bucket: string;
  readonly runtime: "memory" | "s3-compatible";
  putObjectIfAbsent(input: {
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<StoredEvidenceObject>;
  getObject(key: string): Promise<StoredEvidenceObject | null>;
  createSignedGetUrl(key: string, expiresInSeconds: number): Promise<SignedEvidenceAccess>;
  /**
   * Both of these exist only to serve the pending-custody model below, and
   * neither should be called directly. Use promotePendingObject and
   * discardPendingObject, which refuse to act on anything outside the pending
   * namespace. A committed object must not be reachable by a delete that the
   * application can issue.
   */
  deleteObjectUnchecked(key: string): Promise<void>;
  copyObjectUnchecked(sourceKey: string, destinationKey: string): Promise<StoredEvidenceObject>;
}

export class EvidenceObjectAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`Evidence object already exists: ${key}`);
  }
}

export class InMemoryEvidenceObjectStorage implements EvidenceObjectStorage {
  readonly runtime = "memory" as const;
  readonly bucket: string;
  private readonly objects = new Map<string, StoredEvidenceObject>();

  constructor(bucket = "evidence-test-bucket") {
    this.bucket = bucket;
  }

  async putObjectIfAbsent(input: {
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<StoredEvidenceObject> {
    if (this.objects.has(input.key)) {
      throw new EvidenceObjectAlreadyExistsError(input.key);
    }

    const body = Buffer.from(input.body);
    const object = {
      key: input.key,
      contentType: input.contentType,
      contentLength: body.byteLength,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      body,
    };
    this.objects.set(input.key, object);
    return object;
  }

  async getObject(key: string): Promise<StoredEvidenceObject | null> {
    const object = this.objects.get(key);
    return object ? { ...object, body: Buffer.from(object.body) } : null;
  }

  async createSignedGetUrl(key: string, expiresInSeconds: number): Promise<SignedEvidenceAccess> {
    if (!this.objects.has(key)) {
      throw new Error("Cannot sign access for a missing evidence object.");
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const signature = crypto
      .createHmac("sha256", "deterministic-evidence-test-double")
      .update(`${this.bucket}:${key}:${expiresAt.toISOString()}`)
      .digest("hex");

    return {
      url: `memory://evidence/${encodeURIComponent(this.bucket)}/${encodeURIComponent(key)}?expires=${encodeURIComponent(
        expiresAt.toISOString(),
      )}&signature=${signature}`,
      expiresAt,
    };
  }

  async deleteObjectUnchecked(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /**
   * Every key currently held. Present on the in-memory driver only, so a test
   * can assert that a rolled-back submission left nothing behind — an assertion
   * that is otherwise impossible, because the key of a discarded object is
   * never returned to the caller.
   */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  async copyObjectUnchecked(sourceKey: string, destinationKey: string): Promise<StoredEvidenceObject> {
    const source = this.objects.get(sourceKey);
    if (!source) {
      throw new Error(`Cannot copy a missing object: ${sourceKey}`);
    }
    if (this.objects.has(destinationKey)) {
      throw new EvidenceObjectAlreadyExistsError(destinationKey);
    }
    const copy = { ...source, key: destinationKey, body: Buffer.from(source.body) };
    this.objects.set(destinationKey, copy);
    return { ...copy, body: Buffer.from(copy.body) };
  }
}

function hmac(key: Buffer | string, value: string) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hexSha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function awsDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secretKey: string, dateStamp: string, region: string) {
  const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export class S3CompatibleEvidenceObjectStorage implements EvidenceObjectStorage {
  readonly runtime = "s3-compatible" as const;
  readonly bucket: string;
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly forcePathStyle: boolean;

  constructor(input: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  }) {
    this.endpoint = new URL(input.endpoint);
    this.region = input.region;
    this.bucket = input.bucket;
    this.accessKey = input.accessKey;
    this.secretKey = input.secretKey;
    this.forcePathStyle = input.forcePathStyle;
  }

  private objectUrl(key: string) {
    const encodedKey = key.split("/").map(encodePathSegment).join("/");
    if (this.forcePathStyle) {
      return new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/${this.bucket}/${encodedKey}`, this.endpoint);
    }

    const url = new URL(`${this.endpoint.pathname.replace(/\/$/, "")}/${encodedKey}`, this.endpoint);
    url.hostname = `${this.bucket}.${url.hostname}`;
    return url;
  }

  private authHeaders(method: string, url: URL, body: Buffer | null, extraHeaders: Record<string, string>) {
    const now = new Date();
    const amzDate = awsDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash("sha256").update(body || "").digest("hex");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    };
    const signedHeaders = Object.keys(headers)
      .map((key) => key.toLowerCase())
      .sort()
      .join(";");
    const canonicalHeaders = Object.keys(headers)
      .map((key) => key.toLowerCase())
      .sort()
      .map((key) => `${key}:${headers[key] ?? headers[Object.keys(headers).find((item) => item.toLowerCase() === key)!]}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      url.searchParams.toString(),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hexSha256(canonicalRequest)].join("\n");
    const signature = crypto.createHmac("sha256", signingKey(this.secretKey, dateStamp, this.region)).update(stringToSign).digest("hex");

    return {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async putObjectIfAbsent(input: {
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<StoredEvidenceObject> {
    const url = this.objectUrl(input.key);
    const metadataHeaders = Object.fromEntries(
      Object.entries(input.metadata || {}).map(([key, value]) => [`x-amz-meta-${key.toLowerCase()}`, value]),
    );
    const headers = this.authHeaders("PUT", url, input.body, {
      "content-type": input.contentType,
      "if-none-match": "*",
      ...metadataHeaders,
    });
    const result = await fetch(url, { method: "PUT", headers, body: input.body as unknown as BodyInit });

    if (result.status === 412 || result.status === 409) {
      throw new EvidenceObjectAlreadyExistsError(input.key);
    }
    if (!result.ok) {
      throw new Error(`S3-compatible object write failed with HTTP ${result.status}.`);
    }

    return {
      key: input.key,
      contentType: input.contentType,
      contentLength: input.body.byteLength,
      sha256: crypto.createHash("sha256").update(input.body).digest("hex"),
      body: Buffer.from(input.body),
    };
  }

  async getObject(key: string): Promise<StoredEvidenceObject | null> {
    const url = this.objectUrl(key);
    const headers = this.authHeaders("GET", url, null, {});
    const result = await fetch(url, { method: "GET", headers });
    if (result.status === 404) {
      return null;
    }
    if (!result.ok) {
      throw new Error(`S3-compatible object read failed with HTTP ${result.status}.`);
    }
    const body = Buffer.from(await result.arrayBuffer());
    return {
      key,
      contentType: result.headers.get("content-type") || "application/octet-stream",
      contentLength: body.byteLength,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      body,
    };
  }

  async createSignedGetUrl(key: string, expiresInSeconds: number): Promise<SignedEvidenceAccess> {
    const now = new Date();
    const amzDate = awsDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const url = this.objectUrl(key);
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${this.accessKey}/${credentialScope}`);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    url.searchParams.set("X-Amz-SignedHeaders", "host");

    const canonicalRequest = ["GET", url.pathname, url.searchParams.toString(), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, hexSha256(canonicalRequest)].join("\n");
    const signature = crypto.createHmac("sha256", signingKey(this.secretKey, dateStamp, this.region)).update(stringToSign).digest("hex");
    url.searchParams.set("X-Amz-Signature", signature);

    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    };
  }

  async deleteObjectUnchecked(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const headers = this.authHeaders("DELETE", url, Buffer.alloc(0), {});
    const result = await fetch(url, { method: "DELETE", headers });
    // 404 is success for our purpose: the object is not there.
    if (!result.ok && result.status !== 404) {
      throw new Error(`S3-compatible object delete failed with HTTP ${result.status}.`);
    }
  }

  async copyObjectUnchecked(sourceKey: string, destinationKey: string): Promise<StoredEvidenceObject> {
    const source = await this.getObject(sourceKey);
    if (!source) {
      throw new Error(`Cannot copy a missing object: ${sourceKey}`);
    }
    // Read-then-write rather than CopyObject: it works identically on every
    // S3-compatible provider, and it re-verifies the bytes on the way through.
    return this.putObjectIfAbsent({
      key: destinationKey,
      body: source.body,
      contentType: source.contentType,
      metadata: { promotedfrom: sourceKey.slice(-120) },
    });
  }
}

export type EvidenceStorageConfig = {
  driver: "memory" | "s3";
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  isTest: boolean;
};

let storage: EvidenceObjectStorage | null = null;
let configuration: EvidenceStorageConfig | null = null;

/**
 * Wires the storage client from the host application's validated environment.
 * The API and the worker each call this once at startup so a single client
 * implementation serves both without either owning the other's configuration.
 */
export function configureEvidenceObjectStorage(config: EvidenceStorageConfig) {
  configuration = config;
  storage = null;
}

export function getEvidenceObjectStorage() {
  if (storage) {
    return storage;
  }

  if (!configuration) {
    throw new Error("Evidence object storage was used before configureEvidenceObjectStorage() ran.");
  }

  if (configuration.driver === "memory") {
    storage = new InMemoryEvidenceObjectStorage(configuration.bucket || "evidence-test-bucket");
    return storage;
  }

  storage = new S3CompatibleEvidenceObjectStorage({
    endpoint: configuration.endpoint,
    region: configuration.region,
    bucket: configuration.bucket,
    accessKey: configuration.accessKey,
    secretKey: configuration.secretKey,
    forcePathStyle: configuration.forcePathStyle,
  });
  return storage;
}

export function setEvidenceObjectStorageForTests(next: EvidenceObjectStorage | null) {
  if (!configuration?.isTest) {
    throw new Error("Evidence storage test replacement is only available in test mode.");
  }
  storage = next;
}

/**
 * The same private bucket, addressed for a different kind of record.
 *
 * Voter-registration documents and incident evidence share one private
 * S3-compatible bucket and one client; they are separated by key prefix, not by
 * credentials. This alias exists so a caller storing a voter's PVC does not
 * have to read as though it were storing incident evidence, and so the shared
 * bucket is visible rather than implied.
 *
 * Neither kind of object is ever public. There is no public-read path on this
 * client at all: reads go through createSignedGetUrl with an explicit, short
 * expiry.
 */
export function getPrivateObjectStorage() {
  return getEvidenceObjectStorage();
}

/** Key prefixes that keep the domains apart inside the shared bucket. */
export const PRIVATE_STORAGE_PREFIXES = {
  evidence: "evidence",
  voterVerification: "voter-verification",
  /**
   * Bytes the server has received but that no committed database row owns yet.
   *
   * A document is written here first, and moves to its committed key only once
   * the transaction that records it has actually committed. If that transaction
   * fails, the pending object is discarded — so a rolled-back registration
   * leaves no identity document behind with nothing to own it.
   */
  voterVerificationPending: "voter-verification/pending",
} as const;

export class CommittedObjectDeletionRefused extends Error {
  constructor(key: string) {
    super(
      `Refusing to delete "${key}": it is not a pending object. Committed evidence and committed identity documents are never deletable through this path.`,
    );
  }
}

/** True only for keys inside the pending namespace. */
export function isPendingObjectKey(key: string) {
  return key.startsWith(`${PRIVATE_STORAGE_PREFIXES.voterVerificationPending}/`);
}

/**
 * Removes an object that no committed row owns.
 *
 * This is the only deletion the application can perform, and it refuses any key
 * outside the pending namespace. The bucket policy narrows the same boundary
 * from the other side; this makes the rule true in code as well as in IAM, so a
 * misconfigured policy cannot turn a cleanup into evidence destruction.
 */
export async function discardPendingObject(key: string): Promise<void> {
  if (!isPendingObjectKey(key)) {
    throw new CommittedObjectDeletionRefused(key);
  }
  await getPrivateObjectStorage().deleteObjectUnchecked(key);
}

/**
 * Moves a pending object to its committed key, then removes the pending copy.
 *
 * Refuses to promote from outside the pending namespace, and refuses to promote
 * *into* it — a committed document must not end up somewhere a cleanup could
 * later delete it.
 */
export async function promotePendingObject(input: {
  pendingKey: string;
  committedKey: string;
}): Promise<void> {
  if (!isPendingObjectKey(input.pendingKey)) {
    throw new CommittedObjectDeletionRefused(input.pendingKey);
  }
  if (isPendingObjectKey(input.committedKey)) {
    throw new Error(
      `Refusing to promote into the pending namespace: ${input.committedKey}. A committed document must not be deletable by pending cleanup.`,
    );
  }

  const storage = getPrivateObjectStorage();
  await storage.copyObjectUnchecked(input.pendingKey, input.committedKey);
  // Only once the committed copy exists. If this delete fails the committed
  // document is already safe; the leftover pending object is caught by the
  // pending-namespace lifecycle rule.
  await storage.deleteObjectUnchecked(input.pendingKey);
}
