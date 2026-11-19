const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Reuses the calling-agent bucket by default (same AWS account/credentials
// already configured there) under its own key prefix, so no new bucket setup
// is required to turn this on — set MEETING_RECORDINGS_S3_BUCKET to use a
// dedicated bucket instead.
//
// Required env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
// and one of MEETING_RECORDINGS_S3_BUCKET / CALLING_AGENT_S3_BUCKET.
//
// Bucket-level retention (auto-delete after N days) is not set per-upload —
// configure it once on the bucket, e.g.:
//   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
//     --lifecycle-configuration '{"Rules":[{"ID":"meeting-recordings-retention",
//     "Filter":{"Prefix":"meeting-recordings/"},"Status":"Enabled",
//     "Expiration":{"Days":<retention_days>}}]}'
function getBucket() {
  const bucket = process.env.MEETING_RECORDINGS_S3_BUCKET || process.env.CALLING_AGENT_S3_BUCKET;
  if (!bucket) throw new Error("MEETING_RECORDINGS_S3_BUCKET (or CALLING_AGENT_S3_BUCKET) is not configured");
  return bucket;
}

function getClient() {
  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

function keyFor(tenantId, meetingId, extension) {
  return `meeting-recordings/${tenantId}/${meetingId}/${Date.now()}.${extension}`;
}

async function uploadMeetingRecording(tenantId, meetingId, buffer, contentType, extension) {
  const bucket = getBucket();
  const key = keyFor(tenantId, meetingId, extension);

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Ignored (not an error) on buckets with ACLs disabled, which is the
      // modern S3 default for new buckets — access there is controlled by
      // bucket policy instead, not per-object ACL.
      ACL: "private",
    })
  );

  return key;
}

// Short-lived signed URL — recordings are never handed to the client as a
// direct/public S3 link, only ever through this.
async function getSignedPlaybackUrl(key, expiresInSeconds = 600) {
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

// Permanent — the caller must have already confirmed this is intentional
// (irreversible: once deleted, the recording cannot be recovered).
async function deleteMeetingRecording(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

module.exports = { uploadMeetingRecording, getSignedPlaybackUrl, deleteMeetingRecording };
