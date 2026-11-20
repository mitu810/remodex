// FILE: qr.test.js
// Purpose: Verifies terminal pairing output keeps codes usable without leaking full bearer-like IDs by default.
// Layer: Unit Test
// Exports: node:test suite
// Depends on: node:test, node:assert/strict, ../src/qr

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SHORT_PAIRING_CODE_ALPHABET,
  SHORT_PAIRING_CODE_LENGTH,
  createShortPairingCode,
  printQR,
  shouldPrintPairingJson,
} = require("../src/qr");

test("createShortPairingCode emits a short human-friendly token", () => {
  const code = createShortPairingCode({
    randomBytesImpl() {
      return Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    },
  });

  assert.equal(code.length, SHORT_PAIRING_CODE_LENGTH);
  assert.match(code, new RegExp(`^[${SHORT_PAIRING_CODE_ALPHABET}]+$`));
});

test("printQR prints the short pairing code without the full pairing JSON by default", () => {
  const logs = captureConsoleLog(() => {
    printQR({
      pairingPayload: {
        relay: "ws://127.0.0.1:9000/relay",
        sessionId: "session-sensitive-long-value",
        macDeviceId: "mac-123",
        expiresAt: 1_900_000_000_000,
      },
      pairingCode: "ABCDEFGHJK",
    }, {
      env: {},
    });
  });

  const output = logs.join("\n");
  assert.match(output, /ABCDEFGHJK/);
  assert.doesNotMatch(output, /RMX1:/);
  assert.match(output, /Session ID: session-/);
  assert.doesNotMatch(output, /session-sensitive-long-value/);
  assert.doesNotMatch(output, /Pairing JSON/);
});

test("printQR refuses to print raw pairing JSON even for debug workflows", () => {
  const logs = captureConsoleLog(() => {
    printQR({
      relay: "ws://127.0.0.1:9000/relay",
      sessionId: "session-debug",
      macDeviceId: "mac-123",
      expiresAt: 1_900_000_000_000,
    }, {
      printPairingJson: true,
      env: {},
    });
  });

  const output = logs.join("\n");
  assert.match(output, /Pairing JSON debug output is disabled/);
  assert.doesNotMatch(output, /"sessionId":"session-debug"/);
  assert.doesNotMatch(output, /ws:\/\/127\.0\.0\.1:9000\/relay/);
});

test("the opt-in RMX1 paste code includes the self-hosted relay and matches the QR payload", () => {
  const pairingPayload = {
    v: 2, relay: "wss://relay.example/relay", sessionId: "fixture-session",
    macDeviceId: "fixture-device", macIdentityPublicKey: "fixture-key", expiresAt: 1_900_000_000_000,
  };
  const logs = captureConsoleLog(() => printQR({ pairingPayload, pairingCode: "ABCDEFGHJK" }, { includeCopyableCode: true }));
  const token = logs.find((line) => line.startsWith("RMX1:"));
  assert.ok(token);
  assert.deepEqual(JSON.parse(Buffer.from(token.slice(5), "base64url").toString("utf8")), pairingPayload);
  assert.ok(logs.includes("ABCDEFGHJK"));
});

test("shouldPrintPairingJson accepts explicit flags and debug env aliases", () => {
  assert.equal(shouldPrintPairingJson({ explicitValue: true, env: {} }), true);
  assert.equal(shouldPrintPairingJson({ explicitValue: false, env: { REMODEX_PRINT_PAIRING_JSON: "1" } }), false);
  assert.equal(shouldPrintPairingJson({ env: { REMODEX_PRINT_PAIRING_JSON: "yes" } }), true);
  assert.equal(shouldPrintPairingJson({ env: { PHODEX_PRINT_PAIRING_JSON: "on" } }), true);
  assert.equal(shouldPrintPairingJson({ env: { REMODEX_PRINT_PAIRING_JSON: "0" } }), false);
});

function captureConsoleLog(callback) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(" "));
  };

  try {
    callback();
  } finally {
    console.log = originalLog;
  }

  return logs;
}
