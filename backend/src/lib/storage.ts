import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { config } from "../config.js";

/**
 * S3-compatible object storage (MinIO locally / on the VPS).
 *
 * Two clients because browsers and the API reach MinIO at different hosts:
 *  - `internal` (S3_ENDPOINT, e.g. http://minio:9000 inside Docker) for the
 *    API's own calls (head/delete/bucket setup);
 *  - `browserFacing` (S3_PUBLIC_URL, e.g. http://localhost:9000) only to sign
 *    upload forms, so the URL handed to the browser is one it can reach.
 */
const s = config.storage;
const base: S3ClientConfig = {
  region: s.region,
  forcePathStyle: true,
  credentials: { accessKeyId: s.accessKey, secretAccessKey: s.secretKey },
  // Recent AWS SDKs add CRC checksums by default; MinIO-compatible servers
  // don't need them on these calls.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
};
const internal = new S3Client({ ...base, endpoint: s.endpoint });
const browserFacing = new S3Client({ ...base, endpoint: s.publicUrl });

export const MEDIA_PREFIX = "media/";

/** Public, permanent URL of an object (path-style). */
export function publicUrlFor(key: string): string {
  return `${s.publicUrl.replace(/\/$/, "")}/${s.bucket}/${key}`;
}

/**
 * Creates the bucket if missing and makes objects under media/ publicly
 * readable (uploads stay authenticated via presigned forms). Retries while
 * MinIO is still starting.
 */
export async function initStorage(log: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: s.bucket }));
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw e;
        await internal.send(new CreateBucketCommand({ Bucket: s.bucket }));
        log(`bucket created: ${s.bucket}`);
      }
      await internal.send(
        new PutBucketPolicyCommand({
          Bucket: s.bucket,
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: ["*"] },
                Action: ["s3:GetObject"],
                Resource: [`arn:aws:s3:::${s.bucket}/${MEDIA_PREFIX}*`],
              },
            ],
          }),
        }),
      );
      log(`object storage ready: ${s.endpoint} bucket=${s.bucket}`);
      return;
    } catch (e) {
      if (attempt >= 30) throw e;
      log(`object storage not ready (${(e as Error).name}), retrying… (${attempt}/30)`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Presigned POST form: the browser uploads directly to storage, with the
 *  size and content type enforced by the storage server itself. */
export async function presignUpload(key: string, contentType: string, maxBytes: number) {
  return createPresignedPost(browserFacing, {
    Bucket: s.bucket,
    Key: key,
    Conditions: [
      ["content-length-range", 1, maxBytes],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType },
    Expires: s.uploadTtlSeconds,
  });
}

export async function headObject(key: string): Promise<{ size: number; contentType: string } | null> {
  try {
    const r = await internal.send(new HeadObjectCommand({ Bucket: s.bucket, Key: key }));
    return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? "" };
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return null;
    throw e;
  }
}

/** Idempotent: deleting a missing key succeeds. */
export async function deleteObject(key: string): Promise<void> {
  await internal.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
}

export async function storageHealthy(): Promise<boolean> {
  try {
    await internal.send(new HeadBucketCommand({ Bucket: s.bucket }));
    return true;
  } catch {
    return false;
  }
}
