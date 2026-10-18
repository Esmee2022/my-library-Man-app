// Upload an already encrypted database snapshot to the private S3 backup bucket.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function configured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_REGION &&
    process.env.AWS_S3_BUCKET
  );
}

function createClient() {
  if (!configured()) throw new Error('AWS S3 backup is not configured.');
  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
}

async function putEncryptedBackup(key, body) {
  const client = createClient();
  const bucket = process.env.AWS_S3_BUCKET;

  try {
    const response = await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream'
    }));
    return { bucket, key, etag: response.ETag || null };
  } catch (error) {
    const status = error.$metadata?.httpStatusCode || 'network';
    const code = error.Code || error.name || 'S3UploadError';
    const message = String(error.message || 'S3 rejected the upload').slice(0, 300);
    throw new Error(`AWS S3 backup upload failed (${status}, ${code}): ${message}`);
  }
}

module.exports = { configured, putEncryptedBackup };
