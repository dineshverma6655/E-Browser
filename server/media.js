// Cloudflare R2 (S3-compatible) storage for photos and videos that cannot go peer-to-peer (partner offline / P2P down).
// Files are private, uploaded/downloaded with short-lived signed URLs, and deleted once the partner has SEEN them.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function createMedia() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  const enabled = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
  if (!enabled) {
    console.warn('> Cloud video storage disabled: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in .env');
    return { enabled: false };
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    // R2 does not support the SDK's newer automatic checksums on presigned URLs
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = R2_BUCKET;

  return {
    enabled: true,
    bucket: Bucket,

    uploadUrl: (Key, ContentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 15 * 60 }),

    downloadUrl: (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 10 * 60 }),

    // Can we reach the bucket with these credentials? -> { ok, error? }
    async ping() {
      try {
        await s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.name === 'NoSuchBucket' ? 'Bucket not found' : e.name === 'AccessDenied' ? 'Access denied (check API token)' : e.message };
      }
    },

    // Returns the object size in bytes, or null if it does not exist.
    async head(Key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket, Key }));
        return Number(r.ContentLength || 0);
      } catch {
        return null;
      }
    },

    async remove(Key) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key }));
      } catch (e) {
        console.warn('> R2 delete failed:', Key, e.message);
      }
    },
  };
}

module.exports = { createMedia };
