// Keeps inline conversation images out of history envelopes and serves their bytes on demand.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readThreadRolloutRecords, resolveSessionsRoot } = require("./rollout-watch");

// An 8 MiB original fits the phone's 16 MiB frame after both layers of base64.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const REFERENCE_PREFIX = "remodex://history-image/";
const ELIDED_IMAGE = "remodex://history-image-elided";
const cache = new Map();
const pendingReads = new Map();
let cacheBytes = 0;

const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"],
  ["image/heic", "heic"], ["image/heif", "heif"], ["image/avif", "avif"],
  ["image/bmp", "bmp"], ["image/tiff", "tiff"],
]);

function findInlineImage(value) {
  if (typeof value === "string") {
    return /^data:image\//i.test(value) ? value : null;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      const found = findInlineImage(nested);
      if (found) return found;
    }
  }
  return null;
}

function isConversationImageContentItem(item) {
  const type = typeof item?.type === "string" ? item.type.toLowerCase().replace(/[\s_-]+/g, "") : "";
  return ["image", "localimage", "inputimage", "outputimage", "imageurl"].includes(type);
}

function sanitizeInlineHistoryImageContentItem(item) {
  if (!isConversationImageContentItem(item)) return item;
  const inline = inlineImageFromContentItem(item);
  if (!inline) return item;

  const { url: _url, image_url: _imageUrl, imageUrl: _camelCaseUrl, path: _path, ...metadata } = item;
  const image = decodeInlineImage(inline);
  let reference;
  if (image) {
    const originalName = item.fileName || item.file_name || item.filename;
    reference = `${REFERENCE_PREFIX}${image.digest}/${encodeURIComponent(imageFileName(originalName, image.mimeType))}`;
    rememberImage(reference, image);
  }
  return { ...metadata, url: reference || ELIDED_IMAGE };
}

function inlineImageFromContentItem(item) {
  return findInlineImage(item.url) || findInlineImage(item.image_url)
    || findInlineImage(item.imageUrl) || findInlineImage(item.path);
}

function decodeInlineImage(inline) {
  if (inline.length > MAX_DATA_URL_LENGTH) return null;
  const separator = inline.indexOf(",");
  const header = /^data:(image\/[a-z]+);base64$/i.exec(inline.slice(0, separator));
  const mimeType = header?.[1].toLowerCase();
  if (separator < 0 || !IMAGE_EXTENSIONS.has(mimeType)) return null;
  const encoded = inline.slice(separator + 1);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const data = Buffer.from(encoded, "base64");
  if (data.length > MAX_IMAGE_BYTES || !matchesImageHeader(data, mimeType)) {
    return null;
  }

  const digest = createHash("sha256").update(mimeType).update(data).digest("hex");
  return { digest, data, mimeType };
}

function imageFileName(suppliedFileName, mimeType) {
  const originalName = typeof suppliedFileName === "string" ? suppliedFileName.split(/[\\/]/).at(-1)?.trim() : null;
  return originalName && originalName.length <= 160
    && !/[\u0000-\u001f\uD800-\uDFFF]/u.test(originalName)
    && originalName !== "." && originalName !== ".."
    ? originalName : `Image.${IMAGE_EXTENSIONS.get(mimeType)}`;
}

function rememberImage(reference, image) {
  const { data } = image;
  const previous = cache.get(reference);
  if (previous) {
    cache.delete(reference);
    cache.set(reference, previous);
    return previous;
  }

  while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + data.length > MAX_CACHE_BYTES) {
    const [oldestKey, oldestImage] = cache.entries().next().value;
    cache.delete(oldestKey);
    cacheBytes -= oldestImage.data.length;
  }
  cache.set(reference, image);
  cacheBytes += data.length;
  return image;
}

function matchesImageHeader(data, mimeType) {
  switch (mimeType) {
    case "image/png": return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg": return data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case "image/gif": return /^GIF8[79]a$/.test(data.toString("ascii", 0, 6));
    case "image/webp": return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
    case "image/heic":
    case "image/heif":
    case "image/avif": return data.toString("ascii", 4, 8) === "ftyp";
    case "image/bmp": return data.toString("ascii", 0, 2) === "BM";
    case "image/tiff": return /^(49492a00|4d4d002a)$/.test(data.toString("hex", 0, 4));
    default: return false;
  }
}

function isHistoryImageReference(value) {
  return typeof value === "string" && value.startsWith(REFERENCE_PREFIX);
}

async function readHistoryImage(reference, { threadId, includeData, previewMaxPixelDimension }) {
  const [, digest, encodedName] = /^remodex:\/\/history-image\/([a-f0-9]{64})\/([^/?#]{1,1920})$/.exec(reference) || [];
  if (!digest) return null;
  let requestedName;
  try {
    requestedName = decodeURIComponent(encodedName);
  } catch {
    return null;
  }
  const image = cache.get(reference) || await recoverHistoryImage(threadId, digest);
  if (!image) return null;
  rememberImage(reference, image);
  const { data, mimeType } = image;
  return {
    path: reference,
    fileName: imageFileName(requestedName, mimeType),
    mimeType,
    byteLength: data.length,
    previewMaxPixelDimension: previewMaxPixelDimension || undefined,
    ...(includeData ? { dataByteLength: data.length, dataBase64: data.toString("base64") } : {}),
  };
}

async function recoverHistoryImage(threadId, digest) {
  if (typeof threadId !== "string") return null;
  const root = resolveSessionsRoot();
  const key = JSON.stringify([root, threadId, digest]);
  let pending = pendingReads.get(key);
  if (!pending) {
    pending = findImageInRollouts(root, threadId, digest).finally(() => pendingReads.delete(key));
    pendingReads.set(key, pending);
  }
  return pending;
}

async function findImageInRollouts(root, threadId, digest) {
  for await (const record of readThreadRolloutRecords(root, threadId, /data:image\//i)) {
    const payload = record.payload;
    if (record.type !== "response_item" || payload?.type !== "message" || !Array.isArray(payload.content)) {
      continue;
    }
    for (const item of payload.content) {
      if (!isConversationImageContentItem(item)) continue;
      const inline = inlineImageFromContentItem(item);
      const image = inline && decodeInlineImage(inline);
      if (image?.digest === digest) return image;
    }
  }
  return null;
}

// A typed Codex user attachment can authorize its own path. Text markers only
// locate the embedded copy and must never grant access to a host file.
async function findLocalImageInHistory(threadId, imagePath, itemId) {
  let match = null;
  let ambiguous = false;
  let embedded = null;
  const matchesPath = (file) => typeof file === "string" && path.isAbsolute(file)
    && path.resolve(file) === imagePath;
  for await (const record of readThreadRolloutRecords(resolveSessionsRoot(), threadId, /local_?image|data:image\//i)) {
    const payload = record.payload;
    if (record.type === "session_meta") embedded = null;
    if (record.type === "event_msg" && payload?.type === "item_completed"
      && /^user_?message$/i.test(payload.item?.type || "") && Array.isArray(payload.item?.content)) {
      const hasAttachment = payload.item.content.some((item) => (
        /^local_?image$/i.test(item?.type || "") && matchesPath(item.path)
      ));
      if (hasAttachment) {
        const timestamp = Date.parse(record.timestamp);
        const candidate = { embedded, attachedAt: Number.isSafeInteger(timestamp) ? timestamp : null };
        if (itemId && payload.item.id === itemId) return candidate;
        if (match) ambiguous = true;
        else match = candidate;
        embedded = null;
      }
    }
    if (!embedded && record.type === "response_item" && payload?.type === "message"
      && payload.role === "user" && Array.isArray(payload.content)) {
      for (let index = 0; index < payload.content.length - 1; index += 1) {
        const marker = payload.content[index]?.text;
        const file = typeof marker === "string"
          && /^<image name=\[Image #\d+\] path="([^"\r\n]+)">$/.exec(marker)?.[1];
        const item = payload.content[index + 1];
        if (matchesPath(file) && isConversationImageContentItem(item)) {
          const inline = inlineImageFromContentItem(item);
          if (inline) embedded = decodeInlineImage(inline);
          if (embedded) break;
        }
      }
    }
  }
  return ambiguous ? null : match;
}

function originalImageMimeType(data) {
  if (data.toString("ascii", 4, 8) === "ftyp") {
    const brands = [data.toString("ascii", 8, 12)];
    const boxEnd = Math.min(data.length, data.readUInt32BE(0), 256);
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
      brands.push(data.toString("ascii", offset, offset + 4));
    }
    if (brands.some((brand) => /^(avif|avis)$/.test(brand))) return "image/avif";
    if (brands.some((brand) => /^(hei[cmsvx]|hev[cx])$/.test(brand))) return "image/heic";
    if (brands.some((brand) => /^(mif1|msf1)$/.test(brand))) return "image/heif";
    return null;
  }
  for (const mimeType of IMAGE_EXTENSIONS.keys()) {
    if (matchesImageHeader(data, mimeType)) return mimeType;
  }
  return null;
}


module.exports = {
  isConversationImageContentItem, sanitizeInlineHistoryImageContentItem, isHistoryImageReference,
  readHistoryImage, findLocalImageInHistory, originalImageMimeType,
};
