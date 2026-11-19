const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

test("iOS routes threads and labels projects using paths from the paired host", {
  skip: process.platform !== "darwin" ? "requires the macOS Swift compiler" : false,
  timeout: 180000,
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-host-paths-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mobile = path.resolve(__dirname, "../../CodexMobile/CodexMobile");
  const turns = fs.readFileSync(path.join(mobile, "Services/CodexService+ThreadsTurns.swift"), "utf8");
  const file = path.join(directory, "ProjectBinding.swift");
  const start = turns.indexOf("enum CodexThreadStartProjectBinding {");
  const end = turns.indexOf("struct ThreadCatalogSnapshot", start);
  assert.ok(start >= 0 && end > start);
  const preview = fs.readFileSync(path.join(mobile, "Views/Turn/Messages/WorkspaceImagePreview.swift"), "utf8");
  const links = preview.indexOf("enum WorkspaceFileLinkResolver {");
  const view = preview.indexOf("private struct WorkspacePreviewChromeButton:", links);
  assert.ok(links >= 0 && view > links);
  const downloads = fs.readFileSync(path.join(mobile, "Services/CodexService+WorkspaceDownloads.swift"), "utf8");
  const downloadType = downloads.indexOf("nonisolated struct WorkspaceFileDownload");
  const downloadService = downloads.indexOf("private struct WorkspaceFileChunk", downloadType);
  assert.ok(downloadType >= 0 && downloadService > downloadType);
  const routing = fs.readFileSync(path.join(mobile, "Services/CodexService+ThreadProjectRouting.swift"), "utf8");
  const applying = routing.indexOf("    func applyingAuthoritativeProjectPath(");
  const nextMethod = routing.indexOf("    // Lets tool-call telemetry", applying);
  assert.ok(applying >= 0 && nextMethod > applying);
  const terminal = fs.readFileSync(path.join(mobile, "Services/Terminal/CodexService+Terminal.swift"), "utf8");
  const shellCommand = terminal.indexOf("    private func shellChangeDirectoryCommand(");
  const afterCommand = terminal.indexOf("    private func terminalErrorText(", shellCommand);
  assert.ok(shellCommand >= 0 && afterCommand > shellCommand);
  fs.writeFileSync(file, [
    "import Foundation", turns.slice(start, end), preview.slice(links, view), downloads.slice(downloadType, downloadService),
    "extension RoutingState {", routing.slice(applying, nextMethod), terminal.slice(shellCommand, afterCommand),
    "func directoryCommand(_ path: String) -> String? { shellChangeDirectoryCommand(for: path) }", "}",
  ].join("\n"));
  const binary = path.join(directory, "remote-paths");
  execFileSync("xcrun", ["swiftc", "-parse-as-library",
    ...["CodexThread", "CodexRuntimeSettings", "RemoteHostPath", "String+PathDisplayName", "JSONValue", "RPCMessage"]
      .map(name => path.join(mobile, "Models", name + ".swift")),
    file, path.join(mobile, "Views/Turn/Git/TurnWorktreeRouting.swift"),
    path.join(__dirname, "fixtures/remote-paths-harness.swift"), "-o", binary], { timeout: 150000 });
  const result = execFileSync(binary, { encoding: "utf8", timeout: 10000 });
  assert.equal(result.trim(), "remote path checks passed");
});
