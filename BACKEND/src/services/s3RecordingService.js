const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// New AWS credentials, not shared with anything else in this app —
// required env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
// CALLING_AGENT_S3_BUCKET.
//
// The bucket's lifecycle-retention rule (auto-delete after the DPDP-Act
// retention window) is NOT something this code can set per-upload — it's a
// one-time bucket-level configuration, e.g.:
//   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
//     --lifecycle-configuration '{"Rules":[{"ID":"calling-agent-retention",
//     "Filter":{"Prefix":"calling-agent-recordings/"},"Status":"Enabled",
//     "Expiration":{"Days":<retention_days>}}]}'
function getClient() {
  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

function keyFor(callId) {
  return `calling-agent-recordings/${callId}.mp3`;
}

async function downloadFromProvider(providerRecordingUrl) {
  const response = await fetch(providerRecordingUrl);
  if (!response.ok) {
    throw new Error(`Failed to download recording from provider (HTTP ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function uploadRecording(callId, providerRecordingUrl) {
  const bucket = process.env.CALLING_AGENT_S3_BUCKET;
  if (!bucket) throw new Error("CALLING_AGENT_S3_BUCKET is not configured");

  const buffer = await downloadFromProvider(providerRecordingUrl);
  const key = keyFor(callId);

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "audio/mpeg",
      // Ignored (not an error) on buckets with ACLs disabled, which is the
      // modern S3 default for new buckets — access there is controlled by
      // bucket policy instead, not per-object ACL.
      ACL: "private",
    })
  );

  return { key, buffer };
}

// Short-lived signed URL — the Phase 5 audio-player endpoint uses this
// server-side rather than ever handing an S3 or provider URL to the client.
async function getSignedPlaybackUrl(key, expiresInSeconds = 300) {
  const bucket = process.env.CALLING_AGENT_S3_BUCKET;
  if (!bucket) throw new Error("CALLING_AGENT_S3_BUCKET is not configured");
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

module.exports = { uploadRecording, getSignedPlaybackUrl, keyFor };
