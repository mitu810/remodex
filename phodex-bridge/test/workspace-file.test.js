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
const { handleWorkspaceMethod, handleWorkspaceRequest } = require("../src/workspace-handler");

function makeGitWorkspace() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-file-"));
  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  return tempDir;
}

test("workspace file reads authorize only exact external paths from the requested chat", async (t) => {
  const cwd = makeGitWorkspace();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remodex-chat-files-")));
  const codexHome = path.join(outside, "codex-home");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const shared = path.join(outside, "Build Report.txt");
  const attachment = path.join(outside, "attachment.zip");
  const image = path.join(outside, "chart.svg");
  const privateFile = path.join(outside, "private.txt");
  const alias = path.join(outside, "alias.txt");
  const toolOnly = path.join(outside, "tool-only.txt");
  for (const file of [shared, attachment, privateFile, toolOnly]) fs.writeFileSync(file, "local content\n");
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.symlinkSync(privateFile, alias);
  const sessionRoot = path.join(codexHome, "sessions", "2026", "11", "20");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "11111111-1111-1111-1111-111111111111";
  const otherThread = "22222222-2222-2222-2222-222222222222";
  const rollout = (id, messages) => fs.writeFileSync(path.join(sessionRoot, `rollout-2026-11-20T12-00-00-${id}.jsonl`), [
    { type: "session_meta", payload: { id, cwd } },
    ...messages,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const chat = (role, text) => ({ type: "response_item", payload: {
    type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  } });
  rollout(threadId, [
    chat("assistant", `[Report](${shared.replaceAll(" ", "%20")}) and \`${alias}\` and [chart](${image})`),
    chat("user", `# Files mentioned by the user:\n\n## attachment.zip: ${attachment}\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nRead this.`),
    { type: "response_item", payload: { type: "function_call_output", output: `[tool file](${toolOnly})` } },
  ]);
  rollout(otherThread, [chat("assistant", `\`${privateFile}\``)]);

  const preview = await handleWorkspaceMethod("workspace/readFile", { cwd, threadId, path: shared });
  assert.equal(preview.content, "local content\n");
  const part = await handleWorkspaceMethod("workspace/readFileChunk", { cwd, threadId, path: attachment, offset: 0 });
  assert.equal(Buffer.from(part.data, "base64").toString(), "local content\n");
  const imagePreview = await handleWorkspaceMethod("workspace/readImage", { cwd, threadId, path: image, chatFileLink: true });
  assert.equal(imagePreview.mimeType, "image/svg+xml");
  await assert.rejects(() => handleWorkspaceMethod("workspace/readImage", {
    cwd, threadId: otherThread, path: image, chatFileLink: true,
  }), { errorCode: "file_path_not_allowed" });
  for (const file of [privateFile, alias, toolOnly]) {
    await assert.rejects(() => handleWorkspaceMethod("workspace/readFileChunk", {
      cwd: outside, threadId, path: file, offset: 0,
    }), { errorCode: "file_path_not_allowed" });
  }
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFile", {
    cwd, threadId: otherThread, path: shared,
  }), { errorCode: "file_path_not_allowed" });
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFile", {
    cwd: outside, threadId: "33333333-3333-3333-3333-333333333333", path: privateFile,
  }), { errorCode: "file_path_not_allowed" });

  const unscoped = await new Promise((resolve) => {
    handleWorkspaceRequest(JSON.stringify({ id: 1, method: "workspace/readFileChunk", params: {
      cwd: outside, path: privateFile, offset: 0,
    } }), (result) => resolve(JSON.parse(result)));
  });
  assert.equal(unscoped.error.data.errorCode, "missing_chat_file_scope");

  const openCodeID = "opencode:ses_workspace_file_test";
  const providerRead = async () => ({ id: openCodeID, cwd, turns: [{ items: [
    { type: "agentMessage", text: `[Report](<${shared}>)` },
    { type: "commandExecution", text: `[Other report](${toolOnly})` },
  ] }] });
  assert.equal((await handleWorkspaceMethod("workspace/readFile", {
    threadId: openCodeID, path: shared,
  }, providerRead)).content, "local content\n");
  await assert.rejects(() => handleWorkspaceMethod("workspace/readFile", {
    threadId: openCodeID, path: toolOnly,
  }, providerRead), { errorCode: "file_path_not_allowed" });
});

test("workspace/readVisualization reads only the current chat's HTML output", async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-visualization-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
  });
  const root = path.join(codexHome, "visualizations", "2026", "11", "19");
  const current = path.join(root, "current-chat");
  const other = path.join(root, "other-chat");
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const content = '<div lang="zh">可视化示例</div>';
  const file = path.join(current, "方案.html");
  const outside = path.join(other, "方案.html");
  fs.writeFileSync(file, content);
  fs.writeFileSync(outside, "Other chat");
  fs.symlinkSync(outside, path.join(current, "outside.html"));

  for (const requestedPath of [file, "方案.html"]) {
    assert.deepEqual(await handleWorkspaceMethod("workspace/readVisualization", {
      threadId: "current-chat", path: requestedPath,
    }), { fileName: "方案.html", content });
  }
  for (const requestedPath of [outside, "outside.html"]) {
    await assert.rejects(() => handleWorkspaceMethod("workspace/readVisualization", {
      threadId: "current-chat", path: requestedPath,
    }), { errorCode: "visualization_path_not_allowed" });
  }
  const large = path.join(current, "large.html");
  fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(() => handleWorkspaceMethod("workspace/readVisualization", {
    threadId: "current-chat", path: large,
  }), { errorCode: "visualization_too_large" });
});

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

test("workspace/readFileChunk downloads a SQL file rejected by the text preview size limit", async (t) => {
  const cwd = makeGitWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fileName = "统计报表.sql";
  const source = Buffer.from("SELECT '统计报表';\n".repeat(100_000));
  fs.writeFileSync(path.join(cwd, fileName), source);

  await assert.rejects(() => handleWorkspaceMethod("workspace/readFile", { cwd, path: fileName }),
    (error) => error.errorCode === "file_too_large");
  const pieces = [];
  let offset = 0;
  let fileVersion;
  while (offset < source.length) {
    const chunk = await handleWorkspaceMethod("workspace/readFileChunk", { cwd, path: fileName, offset, fileVersion });
    fileVersion ??= chunk.fileVersion;
    assert.equal(chunk.fileName, fileName);
    assert.equal(chunk.fileVersion, fileVersion);
    const bytes = Buffer.from(chunk.data, "base64");
    assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024);
    pieces.push(bytes);
    offset += bytes.length;
  }
  assert.deepEqual(Buffer.concat(pieces), source);
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
