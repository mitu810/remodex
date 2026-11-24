const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { handleWorkspaceRequest } = require("../src/workspace-handler");

function request(operation, params) {
  return new Promise((resolve, reject) => {
    const wire = JSON.stringify({ id: 1, method: "workspace/uploadFile" + operation, params });
    assert.ok(handleWorkspaceRequest(wire, () => assert.fail("Upload replies must not enter replay history."), () => raw => {
      const response = JSON.parse(raw);
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    }));
  });
}

test("phone files arrive byte-for-byte, incomplete and cancelled uploads stay out of attachments", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-upload-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const name = "周末 报表.bin";
  const bytes = randomBytes(17 * 1024 * 1024 + 129);
  const upload = await request("Start", { name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += upload.chunkBytes) {
    const chunk = bytes.subarray(offset, offset + upload.chunkBytes);
    const ack = await request("Chunk", { id: upload.id, offset, data: chunk.toString("base64") });
    assert.equal(ack.offset, offset + chunk.length);
  }
  const result = await request("Finish", { id: upload.id });
  assert.equal(result.path, path.join(home, "attachments", upload.id, name));
  assert.deepEqual(await fs.readFile(result.path), bytes);

  const empty = await request("Start", { name, size: 0 });
  const other = await request("Finish", { id: empty.id });
  assert.notEqual(result.path, other.path);
  assert.equal((await fs.stat(other.path)).size, 0);
  for (const invalid of ["../other", "a/b", "a\\b", "..", "a\nb"]) {
    await assert.rejects(request("Start", { name: invalid, size: 0 }));
  }
  for (const [operation, args] of [["Chunk", { offset: 3, data: "YQ==" }], ["Finish", {}], ["Abort", {}]]) {
    const { id } = await request("Start", { name, size: 10 });
    if (operation === "Abort") await request(operation, { id });
    else await assert.rejects(request(operation, { id, ...args }));
    await assert.rejects(request("Finish", { id }));
  }
  assert.deepEqual((await fs.readdir(path.join(home, "attachments"))).sort(), [upload.id, empty.id].sort());
});
