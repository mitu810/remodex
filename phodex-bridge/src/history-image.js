// Keeps inline conversation images out of history envelopes and serves their bytes on demand.

const { createHash } = require("node:crypto");
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const REFERENCE_PREFIX = "remodex://history-image/";
const ELIDED_IMAGE = "remodex://history-image-elided";
const cache = new Map();
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
  const inline = findInlineImage(item.url) || findInlineImage(item.image_url) || findInlineImage(item.path);
  if (!inline) return item;

  const { url: _url, image_url: _imageUrl, path: _path, ...metadata } = item;
  const reference = rememberImage(inline, item.fileName || item.file_name || item.filename);
  return { ...metadata, url: reference || ELIDED_IMAGE };
}

function rememberImage(inline, suppliedFileName) {
  if (inline.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) return null;
  const separator = inline.indexOf(",");
  const header = /^data:(image\/[a-z]+);base64$/i.exec(inline.slice(0, separator));
  const mimeType = header?.[1].toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mimeType);
  if (separator < 0 || !extension) return null;
  const encoded = inline.slice(separator + 1);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const data = Buffer.from(encoded, "base64");
  if (data.length > MAX_IMAGE_BYTES || !matchesImageHeader(data, mimeType)) {
    return null;
  }

  const originalName = typeof suppliedFileName === "string" ? suppliedFileName.split(/[\\/]/).at(-1)?.trim() : null;
  const fileName = originalName && originalName.length <= 160
    && !/[\u0000-\u001f\uD800-\uDFFF]/u.test(originalName)
    && originalName !== "." && originalName !== ".."
    ? originalName : `Image.${extension}`;
  const digest = createHash("sha256").update(mimeType).update(data).digest("hex");
  const reference = `${REFERENCE_PREFIX}${digest}/${encodeURIComponent(fileName)}`;
  const previous = cache.get(reference);
  if (previous) {
    cache.delete(reference);
    cache.set(reference, previous);
    return reference;
  }

  while (cache.size >= MAX_CACHE_ENTRIES || cacheBytes + data.length > MAX_CACHE_BYTES) {
    const [oldestKey, oldestImage] = cache.entries().next().value;
    cache.delete(oldestKey);
    cacheBytes -= oldestImage.data.length;
  }
  cache.set(reference, { data, mimeType, fileName });
  cacheBytes += data.length;
  return reference;
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

function readHistoryImage(reference, { includeData, previewMaxPixelDimension }) {
  const cached = cache.get(reference);
  if (!cached) return null;
  cache.delete(reference);
  cache.set(reference, cached);
  const { data, fileName, mimeType } = cached;
  return {
    path: reference,
    fileName,
    mimeType,
    byteLength: data.length,
    previewMaxPixelDimension: previewMaxPixelDimension || undefined,
    ...(includeData ? { dataByteLength: data.length, dataBase64: data.toString("base64") } : {}),
  };
}

module.exports = { isConversationImageContentItem, sanitizeInlineHistoryImageContentItem, isHistoryImageReference, readHistoryImage };
