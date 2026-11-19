// FILE: codex-cli-bootstrap.test.js
// Purpose: Verifies Codex CLI bootstrap decisions for install, update, opt-out, and npm-missing flows.
// Layer: Unit test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/codex-cli-bootstrap

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureCodexCLI,
  shouldSkipCodexBootstrap,
} = require("../src/codex-cli-bootstrap");

test("ensureCodexCLI installs Codex when it is missing", () => {
  const commands = [];
  const messages = [];
  let codexVersion = null;

  const result = ensureCodexCLI({
    platform: "darwin",
    execFileSyncImpl(command, args, options) {
      commands.push([command, args, options?.stdio || null]);
      if (command === "codex" && args[0] === "--version") {
        if (!codexVersion) {
          throw new Error("missing codex");
        }
        return `codex-cli ${codexVersion}`;
      }
      if (command === "npm" && args[0] === "--version") {
        return "11.6.2";
      }
      if (command === "npm" && args[0] === "install") {
        codexVersion = "0.120.0";
        return "";
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    logger: {
      log(message) {
        messages.push(message);
      },
    },
  });

  assert.deepEqual(result, {
    status: "installed",
    versionBefore: null,
    versionAfter: "0.120.0",
  });
  assert.equal(
    commands.some(([command, args]) => command === "npm" && args.join(" ") === "install -g @openai/codex@latest"),
    true
  );
  assert.deepEqual(messages, [
    "[remodex] Checking Codex CLI...",
    "[remodex] Codex CLI not found.",
    "[remodex] Installing Codex CLI via npm (@openai/codex@latest)...",
    "[remodex] Codex CLI installed (0.120.0).",
  ]);
});

test("ensureCodexCLI updates Codex when it is already installed", () => {
  const messages = [];
  let codexVersion = "0.118.0";

  const result = ensureCodexCLI({
    platform: "darwin",
    execFileSyncImpl(command, args) {
      if (command === "codex" && args[0] === "--version") {
        return `codex-cli ${codexVersion}`;
      }
      if (command === "npm" && args[0] === "--version") {
        return "11.6.2";
      }
      if (command === "npm" && args[0] === "install") {
        codexVersion = "0.120.0";
        return "";
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    logger: {
      log(message) {
        messages.push(message);
      },
    },
  });

  assert.deepEqual(result, {
    status: "updated",
    versionBefore: "0.118.0",
    versionAfter: "0.120.0",
  });
  assert.deepEqual(messages, [
    "[remodex] Checking Codex CLI...",
    "[remodex] Codex CLI found (0.118.0).",
    "[remodex] Updating Codex CLI via npm (@openai/codex@latest)...",
    "[remodex] Codex CLI updated (0.120.0).",
  ]);
});

test("ensureCodexCLI stops gracefully when npm is unavailable", () => {
  const warnings = [];

  const result = ensureCodexCLI({
    platform: "darwin",
    execFileSyncImpl(command, args) {
      if (command === "codex" && args[0] === "--version") {
        throw new Error("missing codex");
      }
      if (command === "npm" && args[0] === "--version") {
        throw new Error("missing npm");
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
    logger: {
      log() {},
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(result, {
    status: "failed",
    versionBefore: null,
    versionAfter: null,
  });
  assert.deepEqual(warnings, [
    "[remodex] npm is unavailable, so Remodex could not install or update the Codex CLI automatically.",
  ]);
});

test("shouldSkipCodexBootstrap respects the opt-out env flag", () => {
  assert.equal(shouldSkipCodexBootstrap({ REMODEX_SKIP_CODEX_BOOTSTRAP: "1" }), true);
  assert.equal(shouldSkipCodexBootstrap({ REMODEX_SKIP_CODEX_BOOTSTRAP: "true" }), true);
  assert.equal(shouldSkipCodexBootstrap({ REMODEX_SKIP_CODEX_BOOTSTRAP: "0" }), false);
});

test("Windows bootstrap recognizes a preinstalled native Codex executable", () => {
  const command = String.raw`D:\用户 & %bin%\codex.exe`;
  const result = ensureCodexCLI({
    platform: "win32", env: { REMODEX_CODEX_COMMAND: command }, shouldUpdate: false,
    execFileSyncImpl(file, args) {
      assert.equal(file, command);
      assert.deepEqual(args, ["--version"]);
      return "codex-cli 0.120.0";
    },
    logger: { log() {}, warn() {} },
  });
  assert.equal(result.status, "current");
});

test("Windows bootstrap installs via the discovered npm shim then rechecks the new Codex shim", () => {
  const bin = String.raw`C:\Npm & %HOME%!\bin`;
  const npm = `${bin}\\npm.cmd`;
  const codex = `${bin}\\codex.cmd`;
  let installed = false;
  const result = ensureCodexCLI({
    platform: "win32", env: { Path: bin, SystemRoot: String.raw`C:\Windows` },
    fsImpl: { statSync: (file) => ({ isFile: () => file === npm || (installed && file === codex) }) },
    execFileSyncImpl(command, args, options) {
      assert.equal(command, String.raw`C:\Windows\System32\cmd.exe`);
      assert.equal(options.windowsVerbatimArguments, true);
      assert.ok(!args.join(" ").includes(bin));
      if (Object.values(options.env).includes(npm)) {
        if (args.at(-1).includes("--version")) return "11.6.2";
        assert.ok(args.at(-1).includes("install -g @openai/codex@latest"));
        installed = true;
        return "";
      }
      assert.ok(Object.values(options.env).includes(codex));
      return "codex-cli 0.120.0";
    },
    logger: { log() {}, warn() {} },
  });
  assert.deepEqual(result, { status: "installed", versionBefore: null, versionAfter: "0.120.0" });
});

test("bootstrap leaves an explicitly selected unavailable executable under user control", () => {
  const commands = [];
  const result = ensureCodexCLI({
    platform: "linux", env: { REMODEX_CODEX_COMMAND: "/opt/separate/codex" },
    execFileSyncImpl(command) { commands.push(command); throw new Error("missing"); },
    logger: { log() {}, warn() {} },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(commands, ["/opt/separate/codex"]);
});
