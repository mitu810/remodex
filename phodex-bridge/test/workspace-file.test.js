// FILE: workspace-file.test.js
// Purpose: Verifies bridge-side read-only text file previews stay scoped and size-safe.
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

function makeGitWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-file-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  return tempDir;
}

test("workspace/readFile returns UTF-8 text for a file inside cwd", async () => {
  const tempDir = makeGitWorkspace();
  const filePath = path.join(tempDir, "src", "App.swift");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "let value = 1\nprint(value)\n", "utf8");

  const result = await handleWorkspaceMethod("workspace/readFile", {
    cwd: tempDir,
    path: "src/App.swift",
  });

  assert.equal(result.path, fs.realpathSync(filePath));
  assert.equal(result.fileName, "App.swift");
  assert.equal(result.content, "let value = 1\nprint(value)\n");
  assert.equal(result.lineCount, 2);
  assert.equal(result.encoding, "utf-8");
  assert.equal(typeof result.mtimeMs, "number");
});

test("workspace/readFile can return metadata without file content", async () => {
  const tempDir = makeGitWorkspace();
  const filePath = path.join(tempDir, "README.md");
  fs.writeFileSync(filePath, "# Demo\n", "utf8");

  const result = await handleWorkspaceMethod("workspace/readFile", {
    cwd: tempDir,
    path: filePath,
    includeContent: false,
  });

  assert.equal(result.path, fs.realpathSync(filePath));
  assert.equal(result.content, undefined);
});

test("workspace/readFile resolves a unique bare filename inside the workspace", async () => {
  const tempDir = makeGitWorkspace();
  const filePath = path.join(tempDir, "phodex-bridge", "test", "bridge-desktop-ipc-integration.test.js");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "test('demo', () => {})\n", "utf8");

  const result = await handleWorkspaceMethod("workspace/readFile", {
    cwd: tempDir,
    path: "bridge-desktop-ipc-integration.test.js",
  });

  assert.equal(result.path, fs.realpathSync(filePath));
  assert.equal(result.content, "test('demo', () => {})\n");
});

test("workspace/readFile rejects ambiguous bare filename matches", async () => {
  const tempDir = makeGitWorkspace();
  const firstPath = path.join(tempDir, "Sources", "App.swift");
  const secondPath = path.join(tempDir, "Tests", "App.swift");
  fs.mkdirSync(path.dirname(firstPath), { recursive: true });
  fs.mkdirSync(path.dirname(secondPath), { recursive: true });
  fs.writeFileSync(firstPath, "let first = true\n", "utf8");
  fs.writeFileSync(secondPath, "let second = true\n", "utf8");

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readFile", {
      cwd: tempDir,
      path: "App.swift",
    }),
    /Multiple files named "App.swift"/
  );
});

test("workspace/readFile skips content when cached metadata still matches", async () => {
  const tempDir = makeGitWorkspace();
  const filePath = path.join(tempDir, "README.md");
  fs.writeFileSync(filePath, "# Demo\n", "utf8");

  const first = await handleWorkspaceMethod("workspace/readFile", {
    cwd: tempDir,
    path: filePath,
  });
  const second = await handleWorkspaceMethod("workspace/readFile", {
    cwd: tempDir,
    path: filePath,
    ifByteLength: first.byteLength,
    ifMtimeMs: first.mtimeMs,
  });

  assert.equal(second.notModified, true);
  assert.equal(second.content, undefined);
});

test("workspace/readFile rejects files outside the selected workspace", async () => {
  const tempDir = makeGitWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-file-outside-"));
  const outsidePath = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(outsidePath, "nope", "utf8");

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readFile", {
      cwd: tempDir,
      path: outsidePath,
    }),
    /Only files in the current workspace/
  );
});

test("workspace/readFile rejects binary files", async () => {
  const tempDir = makeGitWorkspace();
  const filePath = path.join(tempDir, "data.bin");
  fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

  await assert.rejects(
    () => handleWorkspaceMethod("workspace/readFile", {
      cwd: tempDir,
      path: filePath,
    }),
    /looks binary/
  );
});

test("workspace/readFileChunk preserves a binary document across bounded reads", async (t) => {
  const cwd = makeGitWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fileName = "交付材料.zip";
  const source = Buffer.alloc(1024 * 1024 + 23, 0xa5);
  source.write("PK");
  source[source.length - 1] = 0;
  fs.writeFileSync(path.join(cwd, fileName), source);
  const received = [];
  let offset = 0;
  let fileVersion;
  while (offset < source.length) {
    const piece = await handleWorkspaceMethod("workspace/readFileChunk", { cwd, path: fileName, offset, fileVersion });
    assert.equal(piece.fileName, fileName);
    assert.equal(piece.byteLength, source.length);
    assert.equal(piece.offset, offset);
    fileVersion ??= piece.fileVersion;
    assert.equal(piece.fileVersion, fileVersion);
    const data = Buffer.from(piece.data, "base64");
    assert.ok(data.length > 0 && data.length <= 1024 * 1024);
    received.push(data);
    offset += data.length;
  }
  assert.ok(received.length > 1);
  assert.deepEqual(Buffer.concat(received), source);
});

test("workspace/readFileChunk rejects a changed file and an out-of-workspace symlink", async (t) => {
  const cwd = makeGitWorkspace();
  const outside = makeGitWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const fileName = "report.pdf";
  fs.writeFileSync(path.join(cwd, fileName), Buffer.alloc(1024 * 1024 + 8, 1));
  const first = await handleWorkspaceMethod("workspace/readFileChunk", { cwd, path: fileName, offset: 0 });
  fs.appendFileSync(path.join(cwd, fileName), "\0");
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
    cwd, path: fileName, offset: 1024 * 1024, fileVersion: first.fileVersion,
  }), { errorCode: "file_changed" });
  fs.writeFileSync(path.join(outside, fileName), "private");
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
    cwd, path: path.join(outside, fileName), offset: 0,
  }), { errorCode: "file_path_not_allowed" });
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(outside, fileName), path.join(cwd, "link.pdf"));
    await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
      cwd, path: "link.pdf", offset: 0,
    }), { errorCode: "file_path_not_allowed" });
  }
});

test("workspace/readFileChunk handles empty files and validates download limits", async (t) => {
  const cwd = makeGitWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fileName = "empty.docx";
  const fullPath = path.join(cwd, fileName);
  fs.writeFileSync(fullPath, "");
  const empty = await handleWorkspaceMethod("workspace/readFileChunk", { cwd, path: fileName, offset: 0 });
  assert.equal(empty.byteLength, 0);
  assert.equal(empty.data, "");
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
    cwd, path: fileName, offset: -1,
  }), { errorCode: "invalid_file_offset" });
  fs.truncateSync(fullPath, 100 * 1024 * 1024 + 1);
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
    cwd, path: fileName, offset: 0,
  }), { errorCode: "file_too_large" });
});
