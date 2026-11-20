// FILE: workspace-image.test.js
// Purpose: Verifies bridge-side local image preview reads stay scoped and size-safe.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, fs, os, path, ../src/workspace-handler

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { handleWorkspaceMethod } = require("../src/workspace-handler");

const validOnePixelPNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const IS_WINDOWS_HOST = path.delimiter === ";";

test("a desktop attachment outside the workspace can preview from its own chat", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.homedir(), ".remodex-chat-image-test-"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const imagePath = path.join(directory, "Screenshot.png");
  const untouchedPath = path.join(directory, "Never attached.png");
  const original = Buffer.concat([validOnePixelPNG, Buffer.from("original")]);
  fs.writeFileSync(imagePath, original);
  fs.writeFileSync(untouchedPath, original);
  const threadId = "01234567-89ab-4cde-89ab-fedcba987654";
  const otherThreadId = "abcdef12-3456-4abc-89ab-123456789abc";
  const sessions = path.join(directory, "sessions");
  fs.mkdirSync(sessions);
  const records = [
    { type: "session_meta", payload: { id: threadId } },
    { type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: `<image name=[Image #1] path="${imagePath}">` },
      { type: "input_image", image_url: `data:image/png;base64,${validOnePixelPNG.toString("base64")}` },
      { type: "input_text", text: "</image>" },
      { type: "input_text", text: `<image name=[Image #2] path="${untouchedPath}">` },
      { type: "input_image", image_url: `data:image/png;base64,${validOnePixelPNG.toString("base64")}` },
    ] } },
    { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "item_completed", item: {
      type: "UserMessage", id: "first-image", content: [{ type: "local_image", path: imagePath }],
    } } },
  ];
  const rollout = path.join(sessions, `rollout-2026-11-20T11-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n"));
  const read = (filePath = imagePath, id = threadId, itemId) => handleWorkspaceMethod("workspace/readImage", {
    path: filePath, threadId: id, itemId,
  });
  await assert.rejects(read(imagePath, otherThreadId), { errorCode: "image_path_not_allowed" });
  await assert.rejects(read(untouchedPath), { errorCode: "image_path_not_allowed" });
  const result = await read();
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.fileName, "Screenshot.png");
  assert.equal(result.dataBase64, original.toString("base64"));
  fs.writeFileSync(imagePath, Buffer.concat([validOnePixelPNG, Buffer.from("unrelated replacement")]));
  const replacedAt = new Date(Date.now() + 10_000);
  fs.utimesSync(imagePath, replacedAt, replacedAt);
  assert.equal((await read()).dataBase64, validOnePixelPNG.toString("base64"));
  fs.unlinkSync(imagePath);
  assert.equal((await read()).dataBase64, validOnePixelPNG.toString("base64"));

  const later = structuredClone(records.slice(1));
  later[0].payload.content[1].image_url = `data:image/png;base64,${original.toString("base64")}`;
  later[1].payload.item.id = "second-image";
  fs.appendFileSync(rollout, "\n" + later.map((record) => JSON.stringify(record)).join("\n"));
  assert.equal((await read(imagePath, threadId, "first-image")).dataBase64, validOnePixelPNG.toString("base64"));
  assert.equal((await read(imagePath, threadId, "second-image")).dataBase64, original.toString("base64"));
});

function useProcessPlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: platform,
  });
  t.after(() => {
    Object.defineProperty(process, "platform", descriptor);
  });
}

function writeFakeSips(fakeBinDir, scriptContent) {
  const scriptPath = path.join(fakeBinDir, "sips");
  fs.writeFileSync(scriptPath, scriptContent);
  fs.chmodSync(scriptPath, 0o755);

  if (IS_WINDOWS_HOST) {
    fs.writeFileSync(path.join(fakeBinDir, "sips.js"), scriptContent);
    fs.writeFileSync(
      path.join(fakeBinDir, "sips.cmd"),
      `@echo off\r\nnode "%~dp0sips.js" %*\r\n`
    );
  }
}

function writeFakePowerShell(fakeBinDir, scriptContent) {
  if (IS_WINDOWS_HOST) {
    return;
  }

  const scriptPath = path.join(fakeBinDir, "powershell.exe");
  fs.writeFileSync(scriptPath, scriptContent);
  fs.chmodSync(scriptPath, 0o755);
}

test("workspace/readImage returns base64 image data for a file inside cwd", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.fileName, "preview.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.byteLength, bytes.length);
  assert.equal(typeof result.mtimeMs, "number");
  assert.equal(result.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage returns SVG source as image data", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "icon.svg");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>`;
  fs.writeFileSync(imagePath, svg);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.fileName, "icon.svg");
  assert.equal(result.mimeType, "image/svg+xml");
  assert.equal(result.byteLength, Buffer.byteLength(svg));
  assert.equal(result.dataBase64, Buffer.from(svg).toString("base64"));
});

test("workspace/readImage can return metadata without image bytes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    includeData: false,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.byteLength, bytes.length);
  assert.equal(typeof result.mtimeMs, "number");
  assert.equal(result.dataBase64, undefined);
});

test("workspace/readImage skips bytes when cached metadata still matches", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const first = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
  });
  const second = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    ifByteLength: first.byteLength,
    ifMtimeMs: first.mtimeMs,
  });

  assert.equal(second.notModified, true);
  assert.equal(second.byteLength, bytes.length);
  assert.equal(second.dataBase64, undefined);
});

test("workspace/readImage accepts bounded preview reads", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = validOnePixelPNG;
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.previewMaxPixelDimension, 1600);
  assert.equal(typeof result.dataBase64, "string");
  assert.ok(Buffer.from(result.dataBase64, "base64").length > 0);
});

test("workspace/readImage ignores client platform fields for non-mac preview decisions", async (t) => {
  useProcessPlatform(t, "win32");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-fake-powershell-"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath || ""}`;
  t.after(() => {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  writeFakePowerShell(
    fakeBinDir,
    `#!/usr/bin/env node
const fs = require("fs");
const fileIndex = process.argv.indexOf("-File");
if (fileIndex === -1) {
  throw new Error("Expected -File invocation");
}
const inputPath = process.argv[fileIndex + 2];
const outputPath = process.argv[fileIndex + 3];
const maxDimension = Number(process.argv[fileIndex + 4]);
if (!inputPath || !outputPath || !Number.isFinite(maxDimension)) {
  throw new Error("Expected -File <script> <input> <output> <maxDimension>");
}
fs.copyFileSync(inputPath, outputPath);
`
  );

  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
    previewPlatform: "darwin",
    hostPlatform: "darwin",
    platform: "darwin",
  });

  assert.equal(result.previewMaxPixelDimension, 1600);
  const previewLength = Buffer.from(result.dataBase64, "base64").length;
  assert.ok(previewLength > 0);
  assert.ok(previewLength <= 2 * 1024 * 1024);
});

test("workspace/readImage retries smaller previews when the first preview is still too large", async (t) => {
  useProcessPlatform(t, "darwin");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-fake-sips-"));
  const fakeSipsLog = path.join(tempDir, "sips.log");
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath || ""}`;
  t.after(() => {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  writeFakeSips(
    fakeBinDir,
    `#!/usr/bin/env node
const fs = require("fs");
const validOnePixelPNG = Buffer.from("${validOnePixelPNG.toString("base64")}", "base64");
const dimension = Number(process.argv[process.argv.indexOf("-Z") + 1]);
const outputPath = process.argv[process.argv.indexOf("--out") + 1];
fs.appendFileSync(${JSON.stringify(fakeSipsLog)}, String(dimension) + "\\n");
fs.writeFileSync(outputPath, dimension > 512 ? Buffer.alloc(2 * 1024 * 1024 + 1) : validOnePixelPNG);
`
  );

  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
  });

  const attemptedDimensions = fs.readFileSync(fakeSipsLog, "utf8").trim().split("\n").map(Number);
  assert.deepEqual(attemptedDimensions, [1600, 1200, 1024, 900, 768, 675, 512]);
  assert.equal(Buffer.from(result.dataBase64, "base64").length, validOnePixelPNG.length);
  assert.equal(result.previewMaxPixelDimension, 1600);
});

test("workspace/readImage stops preview retries when sips times out", async (t) => {
  useProcessPlatform(t, "darwin");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-fake-sips-timeout-"));
  const fakeSipsLog = path.join(tempDir, "sips-timeout.log");
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath || ""}`;
  t.after(() => {
    if (previousPath == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  writeFakeSips(
    fakeBinDir,
    `#!/usr/bin/env node
const fs = require("fs");
const dimension = Number(process.argv[process.argv.indexOf("-Z") + 1]);
fs.appendFileSync(${JSON.stringify(fakeSipsLog)}, String(dimension) + "\\n");
setTimeout(() => {}, 30_000);
`
  );

  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readImage", {
      cwd: tempDir,
      path: imagePath,
      maxPixelDimension: 1600,
    }),
    /took too long/
  );

  const attemptedDimensions = fs.readFileSync(fakeSipsLog, "utf8").trim().split("\n").map(Number);
  assert.deepEqual(attemptedDimensions, [1600]);
});

test("workspace/readImage revalidates cached preview dimensions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, validOnePixelPNG);

  const first = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
  });
  const samePreview = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1600,
    ifByteLength: first.byteLength,
    ifMtimeMs: first.mtimeMs,
    ifPreviewMaxPixelDimension: first.previewMaxPixelDimension,
  });
  const differentPreview = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    maxPixelDimension: 1200,
    ifByteLength: first.byteLength,
    ifMtimeMs: first.mtimeMs,
    ifPreviewMaxPixelDimension: first.previewMaxPixelDimension,
  });

  assert.equal(samePreview.notModified, true);
  assert.equal(differentPreview.notModified, undefined);
  assert.equal(differentPreview.previewMaxPixelDimension, 1200);
  assert.equal(typeof differentPreview.dataBase64, "string");
});

test("workspace/readImage does not fall back to original bytes when preview conversion fails", async (t) => {
  useProcessPlatform(t, "darwin");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "corrupt.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readImage", {
      cwd: tempDir,
      path: imagePath,
      maxPixelDimension: 1600,
    }),
    /lightweight phone preview/
  );
});

test("workspace/readImage does not round cached mtime checks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const first = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
  });
  const second = await handleWorkspaceMethod("workspace/readImage", {
    cwd: tempDir,
    path: imagePath,
    ifByteLength: first.byteLength,
    ifMtimeMs: first.mtimeMs + 0.4,
  });

  assert.equal(second.notModified, undefined);
  assert.equal(second.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage rejects non-image paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  const textPath = path.join(tempDir, "notes.txt");
  fs.writeFileSync(textPath, "not an image");

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readImage", {
      cwd: tempDir,
      path: textPath,
    }),
    /Only local image files/
  );
});

test("workspace/readImage rejects workspace images when cwd is missing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.homedir(), "remodex-image-"));
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readImage", {
      path: imagePath,
    }),
    /Only images in this workspace/
  );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace/readImage allows images inside non-git workspace cwd", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.homedir(), "remodex-image-"));
  const imagePath = path.join(tempDir, "preview.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  try {
    const result = await handleWorkspaceMethod("workspace/readImage", {
      cwd: tempDir,
      path: imagePath,
    });

    assert.equal(result.path, fs.realpathSync(imagePath));
    assert.equal(result.dataBase64, bytes.toString("base64"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace/readImage allows generated images under CODEX_HOME", async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome == null) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  const imageDir = path.join(codexHome, "generated_images", "thread-1");
  fs.mkdirSync(imageDir, { recursive: true });
  const imagePath = path.join(imageDir, "ig_123.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    path: imagePath,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage allows temporary screenshot images", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  const imagePath = path.join(tempDir, "emanuele-mobile.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    path: imagePath,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage sniffs extensionless temporary screenshots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-image-"));
  const imagePath = path.join(tempDir, "clipboard-image");
  const bytes = validOnePixelPNG;
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    path: imagePath,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage allows CleanShot media screenshots on macOS", async (t) => {
  useProcessPlatform(t, "darwin");
  const previousHome = process.env.HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-home-"));
  process.env.HOME = homeDir;
  t.after(() => {
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  const cleanShotMediaDir = path.join(homeDir, "Library", "Application Support", "CleanShot", "media", "capture");
  fs.mkdirSync(cleanShotMediaDir, { recursive: true });
  const imagePath = path.join(cleanShotMediaDir, "CleanShot 2026-05-22.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  const result = await handleWorkspaceMethod("workspace/readImage", {
    path: imagePath,
  });

  assert.equal(result.path, fs.realpathSync(imagePath));
  assert.equal(result.dataBase64, bytes.toString("base64"));
});

test("workspace/readImage allows macOS shared /tmp screenshot images", { skip: process.platform !== "darwin" }, async () => {
  const tempDir = fs.mkdtempSync(path.join("/tmp", "remodex-image-"));
  const imagePath = path.join(tempDir, "emanuele-mobile.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.writeFileSync(imagePath, bytes);

  try {
    const result = await handleWorkspaceMethod("workspace/readImage", {
      path: imagePath,
    });

    assert.equal(result.path, fs.realpathSync(imagePath));
    assert.equal(result.dataBase64, bytes.toString("base64"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace/readImage rejects cwd widening outside a repository", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.homedir(), "remodex-image-"));
  const imagePath = path.join(tempDir, "preview.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    await assert.rejects(
      () => handleWorkspaceMethod("workspace/readImage", {
        cwd: "/",
        path: imagePath,
      }),
      /Only images in this workspace/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
