// FILE: index.js
// Purpose: Small entrypoint wrapper for bridge lifecycle commands.
// Layer: CLI entry
// Exports: bridge lifecycle, pairing reset, thread resume/watch, and macOS service helpers.
// Depends on: ./bridge, ./secure-device-state, ./session-state, ./rollout-watch, ./macos-launch-agent

const { runForegroundBridge, runBridgeService } = require('./service-runner');
const { createNativeBridgeService } = require('./native-bridge-service');
const { readBridgeDeviceState, resetBridgeTrustState } = require("./secure-device-state");
const { openLastActiveThread } = require("./session-state");
const { watchThreadRollout } = require("./rollout-watch");
const { readBridgeConfig } = require("./codex-desktop-refresher");
const {
  getMacOSBridgeServiceStatus,
  readMacOSBridgePairingSession,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  resetMacOSBridgePairing,
  restartMacOSBridgeService,
  runMacOSBridgeService,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
} = require("./macos-launch-agent");

module.exports = {
  getMacOSBridgeServiceStatus,
  readMacOSBridgePairingSession,
  printMacOSBridgePairingQr,
  printMacOSBridgeServiceStatus,
  readBridgeConfig,
  readBridgeDeviceState,
  resetMacOSBridgePairing,
  restartMacOSBridgeService,
  startBridge: require('./bridge').startBridge,
  runForegroundBridge,
  runBridgeService,
  createNativeBridgeService,
  runMacOSBridgeService,
  startMacOSBridgeService,
  stopMacOSBridgeService,
  uninstallMacOSBridgeService,
  resetBridgePairing: resetBridgeTrustState,
  openLastActiveThread,
  watchThreadRollout,
};
