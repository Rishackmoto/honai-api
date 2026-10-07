const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

require("../../config/env");

console.log("B2 ENV CHECK:", {
  endpoint: process.env.B2_ENDPOINT,
  bucketName: process.env.B2_BUCKET_NAME,
  keyId: process.env.B2_KEY_ID ? "ADA" : "KOSONG",
  appKey: process.env.B2_APPLICATION_KEY ? "ADA" : "KOSONG",
  publicUrl: process.env.B2_PUBLIC_URL,
});

function trimSlash(value) {
  return (value || "").toString().replace(/\/+$/, "");
}

const allowedPrivatePrefixes = ["pengajuan/", "profile/", "tenant-branding/", "backup/"];

function normalizeB2Key(value) {
  const text = (value || "").toString().trim();
  if (!text) return null;

  const parts = text.split("/").filter(Boolean);
  const prefixIndex = parts.findIndex((part) =>
    allowedPrivatePrefixes.some((prefix) => prefix.startsWith(`${part}/`))
  );

  if (prefixIndex < 0) return text.replace(/^\/+/, "");

  return parts.slice(prefixIndex).join("/");
}

function isAllowedPrivateKey(key) {
  return key && allowedPrivatePrefixes.some((prefix) => key.startsWith(prefix));
}

function encodeKey(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function copySource(key) {
  return `${process.env.B2_BUCKET_NAME}/${encodeKey(key)}`;
}

const b2 = new S3Client({
  region: "us-east-005",
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY,
  },
});

async function uploadToB2({ key, buffer, contentType, contentDisposition }) {
  await b2.send(
    new PutObjectCommand({
      Bucket: process.env.B2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
      ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
    })
  );

  const publicBaseUrl = trimSlash(process.env.B2_PUBLIC_URL);
  if (publicBaseUrl) {
    return `${publicBaseUrl}/${encodeKey(key)}`;
  }

  return `${trimSlash(process.env.B2_ENDPOINT)}/${process.env.B2_BUCKET_NAME}/${encodeKey(key)}`;
}

function keyFromB2Url(value) {
  const text = (value || "").toString().trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return normalizeB2Key(text);

  try {
    const url = new URL(text);
    const bucketName = process.env.B2_BUCKET_NAME;
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    const nestedKey = url.searchParams.get("key") || url.searchParams.get("path") || url.searchParams.get("file");
    if (nestedKey) return keyFromB2Url(nestedKey);

    if (parts[0] === "file" && parts[1] === bucketName) return normalizeB2Key(parts.slice(2).join("/"));
    if (parts[0] === bucketName) return normalizeB2Key(parts.slice(1).join("/"));
    return normalizeB2Key(parts.join("/"));
  } catch (_) {
    return null;
  }
}

async function deleteFromB2(keyOrUrl) {
  const key = keyFromB2Url(keyOrUrl);
  if (!key || !key.startsWith("pengajuan/")) return false;
  await b2.send(new DeleteObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key }));
  return true;
}

async function deleteManyFromB2(values = []) {
  const keys = [...new Set(values.map(keyFromB2Url).filter((key) => key && key.startsWith("pengajuan/")))];
  let deleted = 0;
  for (const key of keys) {
    await deleteFromB2(key);
    deleted += 1;
  }
  return deleted;
}

async function deletePrefixWithGuard(prefix, requiredPrefix) {
  const normalizedPrefix = (prefix || "").toString().trim();
  if (!normalizedPrefix || !normalizedPrefix.startsWith(requiredPrefix)) return 0;

  let deleted = 0;
  let continuationToken;
  do {
    const listResult = await b2.send(new ListObjectsV2Command({
      Bucket: process.env.B2_BUCKET_NAME,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listResult.Contents || []).map((item) => item.Key).filter(Boolean).map((Key) => ({ Key }));
    if (objects.length) {
      await b2.send(new DeleteObjectsCommand({
        Bucket: process.env.B2_BUCKET_NAME,
        Delete: { Objects: objects, Quiet: true },
      }));
      deleted += objects.length;
    }
    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

async function deletePrefixFromB2(prefix) {
  return deletePrefixWithGuard(prefix, "pengajuan/");
}

async function deleteBackupPrefixFromB2(prefix) {
  return deletePrefixWithGuard(prefix, "backup/");
}

async function deleteBackupObjectFromB2(keyOrUrl) {
  const key = keyFromB2Url(keyOrUrl);
  if (!key || !key.startsWith("backup/")) return false;
  await b2.send(new DeleteObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key }));
  return true;
}

async function listB2Objects(prefix) {
  const normalizedPrefix = (prefix || "").toString();
  const rows = [];
  let continuationToken;
  do {
    const result = await b2.send(new ListObjectsV2Command({
      Bucket: process.env.B2_BUCKET_NAME,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of result.Contents || []) {
      if (!item.Key) continue;
      rows.push({
        key: item.Key,
        size: Number(item.Size || 0),
        etag: (item.ETag || "").toString().replace(/^\"|\"$/g, ""),
        lastModified: item.LastModified ? new Date(item.LastModified).toISOString() : null,
      });
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return rows;
}

async function copyB2Object(sourceKey, destinationKey) {
  if (!sourceKey || !destinationKey || !destinationKey.startsWith("backup/")) {
    throw new Error("Invalid backup copy key");
  }
  await b2.send(new CopyObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    CopySource: copySource(sourceKey),
    Key: destinationKey,
  }));
  return destinationKey;
}

async function getSignedB2Url(keyOrUrl, expiresIn = 300) {
  const key = keyFromB2Url(keyOrUrl);
  if (!isAllowedPrivateKey(key)) throw new Error("Invalid B2 key");
  const command = new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key });
  return await getSignedUrl(b2, command, { expiresIn });
}

async function getB2Object(keyOrUrl) {
  const key = keyFromB2Url(keyOrUrl);
  if (!isAllowedPrivateKey(key)) throw new Error("Invalid B2 key");
  const result = await b2.send(new GetObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: key }));
  return { key, result };
}

async function getB2ObjectBuffer(keyOrUrl) {
  const { key, result } = await getB2Object(keyOrUrl);
  const body = result.Body;
  if (!body) return { key, buffer: Buffer.alloc(0), contentLength: 0 };
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return { key, buffer: Buffer.from(bytes), contentLength: Number(result.ContentLength || bytes.length) };
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  return { key, buffer, contentLength: Number(result.ContentLength || buffer.length) };
}

module.exports = {
  uploadToB2,
  deleteFromB2,
  deleteManyFromB2,
  deletePrefixFromB2,
  deleteBackupPrefixFromB2,
  deleteBackupObjectFromB2,
  listB2Objects,
  copyB2Object,
  keyFromB2Url,
  getSignedB2Url,
  getB2Object,
  getB2ObjectBuffer,
};
