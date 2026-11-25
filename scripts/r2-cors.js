// One-time: lets the browser upload/download videos straight to your R2 bucket.
// Needs an R2 API token with Admin permission (Object Read & Write cannot change CORS).
// If it fails, paste the same rules in Cloudflare dashboard > R2 > bucket > Settings > CORS Policy.
require('dotenv').config({ path: ['.env.local', '.env'], quiet: true });
const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ALLOWED_ORIGINS } = process.env;
if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error('Set the R2_* values in .env first.');
  process.exit(1);
}
const origins = (R2_ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean);
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});
s3.send(
  new PutBucketCorsCommand({
    Bucket: R2_BUCKET,
    CORSConfiguration: {
      CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag', 'Content-Length'], MaxAgeSeconds: 3600 }],
    },
  })
)
  .then(() => console.log('CORS set for:', origins.join(', ')))
  .catch((e) => {
    console.error('Failed:', e.message);
    process.exit(1);
  });
