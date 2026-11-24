// Receives original files into the same per-attachment directory layout as Codex Desktop.
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveCodexHome } = require("./codex-home");

const chunkBytes = 512 * 1024;
const uploads = new Map();

async function discard(upload) {
  clearTimeout(upload.timer);
  uploads.delete(upload.id);
  await fs.rm(upload.stage, { recursive: true, force: true });
}

function expireAfterIdle(upload) {
  upload.timer = setTimeout(() => discard(upload).catch(() => {}), 5 * 60_000);
  upload.timer.unref();
}

async function handleAttachmentUpload(method, params) {
  if (method === "workspace/uploadFileStart") {
    const { size } = params;
    let { name } = params;
    if (typeof name !== "string" || !name.trim() || /[/\\:\x00-\x1f\x7f]/u.test(name)
        || name === "." || name === ".." || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Invalid attachment name or size.");
    }
    if (process.platform === "win32") {
      name = name.replace(/[<>"|?*]/g, "_").replace(/[. ]+$/, "_");
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = "_" + name;
    }
    const root = path.join(resolveCodexHome(), "attachments");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const stage = path.join(root, ".upload-" + id);
    const upload = { id, stage, destination: path.join(root, id), name, size, offset: 0, busy: false };
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await fs.writeFile(path.join(stage, name), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await discard(upload);
      throw error;
    }
    uploads.set(id, upload);
    expireAfterIdle(upload);
    return { id, chunkBytes };
  }

  const upload = uploads.get(params.id);
  if (!upload || upload.busy) throw new Error("Upload expired or in progress.");
  clearTimeout(upload.timer);
  upload.busy = true;
  try {
    if (method === "workspace/uploadFileChunk") {
      const { offset, data } = params;
      if (offset !== upload.offset || typeof data !== "string" || data.length > Math.ceil(chunkBytes / 3) * 4) {
        throw new Error("Invalid attachment chunk.");
      }
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length || bytes.length > chunkBytes || offset + bytes.length > upload.size
          || bytes.toString("base64") !== data) throw new Error("Invalid attachment data.");
      await fs.appendFile(path.join(upload.stage, upload.name), bytes);
      upload.offset += bytes.length;
      return { offset: upload.offset };
    }
    if (method === "workspace/uploadFileFinish" && upload.offset === upload.size) {
      await fs.rename(upload.stage, upload.destination);
      uploads.delete(upload.id);
      return { path: path.join(upload.destination, upload.name) };
    }
    if (method === "workspace/uploadFileAbort") {
      await discard(upload);
      return {};
    }
    throw new Error("Incomplete attachment.");
  } catch (error) {
    await discard(upload);
    throw error;
  } finally {
    upload.busy = false;
    if (uploads.has(upload.id)) expireAfterIdle(upload);
  }
}

module.exports = { handleAttachmentUpload };
