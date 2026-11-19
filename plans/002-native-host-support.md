# Native Windows and Linux Hosts Implementation Plan

> **For agentic workers:** Execute with superpowers:executing-plans and test-driven-development. Independent platform/runtime and remote-path work may use superpowers:dispatching-parallel-agents.

**Goal:** Run Remodex against native Codex on macOS, Windows and Linux without WSL.

**Architecture:** Preserve the shared bridge, encrypted relay protocol and existing Mac service implementation. Add platform service adapters and a shared daemon runner; interpret remote paths on the host rather than with iOS filesystem semantics.

**Tech Stack:** Node.js CommonJS, Swift/Foundation, launchd, Windows Task Scheduler, systemd user services.

**Spec:** User-approved design in this chat: native Codex per platform, foreground control first, background lifecycle second. Existing desktop IPC probing/mirroring and rollout recovery remain intact; desktop GUI handoff parity is a separate milestone.

## Global Constraints

- Windows runs natively; no WSL dependency or automatic cross-environment dispatch.
- Preserve QR, saved trust and legacy `macDeviceId`/`x-role: mac` protocol fields.
- Preserve local cwd/project routing, item-scoped timelines and active-turn recovery.
- No Xcode tests or simulator runs. Node tests and standalone Foundation harnesses are allowed.
- No host service installation or changes to user pairing state during development checks.
- Keep source local-first, endpoints configurable, secrets out of logs.

## Review Focus

- Space, Unicode and shell metacharacters in executable, home and repository paths.
- Service environments missing interactive PATH; credentials must stay with the current user.
- Stale heartbeat, PID reuse, duplicate starts, process-tree shutdown and restart-loop prevention.
- Existing Mac installations and saved QR trust survive new platform support.
- Missing systemd, logged-out users and unavailable desktop IPC produce honest capability/error states.

### Task 1: Native runtime and cross-platform verification

**Files:** `phodex-bridge/src/codex-transport.js`, focused executable-resolution helpers if needed, corresponding tests, `.github/workflows/bridge-check.yml`.

**Interfaces:** Preserve `createCodexTransport`/`createCodexLaunchPlans`; allow explicit native executable selection and stable service PATH capture.

- [x] Add failing tests for native Windows executable discovery, `.cmd` compatibility, Linux launches and process shutdown.
- [x] Implement minimal platform-specific resolution without changing JSON-RPC behavior or Mac fallback.
- [x] Run transport tests. Add three-OS CI with appropriate targeted platform checks and retain full Linux suite.

### Task 2: Remote paths and host presentation

**Files:** focused Swift remote-path helper, affected project/path display and routing callers, Node filesystem handlers only where needed, standalone harness/tests.

**Interfaces:** Treat remote absolute paths as host strings; share path parsing for Windows drive/UNC and POSIX paths without touching iOS local attachments.

- [x] Add failing cases for drive roots, backslashes, UNC, spaces, Unicode and relative paths.
- [x] Fix remote path normalization and display at actual call sites; reuse existing host platform metadata.
- [x] Verify Foundation harness and static/source integration checks, without Xcode tests.

### Task 3: Shared service lifecycle and native adapters

**Files:** `phodex-bridge/src/native-bridge-service.js`, shared service runner, Windows/Linux service adapters, private-state helper, `src/index.js`, `bin/remodex.js`, corresponding tests.

**Interfaces:** Platform-neutral start/restart/stop/uninstall/status/QR/reset functions; macOS delegates to existing exports, Windows uses current-user scheduled tasks, Linux uses systemd user services. Non-systemd systems retain explicit foreground `run`.

- [x] Add failing adapter/lifecycle/CLI tests before implementation.
- [x] Add shared daemon config/status/pairing hooks, user-level startup definitions, stable environment and working directory, bounded restart policies and single-instance protection.
- [x] Protect Windows private state with current-user ACLs; retain POSIX permissions and trust identity.
- [x] Wire native CLI lifecycle while preserving Mac JSON contracts and foreground `run`.
- [x] Verify focused service, daemon, CLI, pairing and Mac regression tests without registering real services.

### Task 4: Documentation and integration review

**Files:** `README.md`, `CONTRIBUTING.md`, `SELF_HOSTING_MODEL.md`, `Docs/self-hosting.md`, `plans/README.md`.

- [x] Update native platform setup, local relay startup and service scope; remove stale Mac-only assertions.
- [x] Run bridge and relay suites, syntax/diff checks and a fresh review; fix substantive findings with regression tests.
- [x] Record exact results and distinguish automated coverage from pending real Windows/Linux device validation.

## Execution notes

- Work in `codex/native-host-support` in the clean current checkout; no extra worktree or approval cycle is needed for the already-approved reversible work.
- Keep intermediate execution records outside the repository. Do not commit or publish without a separate user request.

## Implementation decisions and remaining validation

- Node.js minimum is 20.8: Linux instance exclusion uses abstract Unix sockets that release automatically after exit; Windows uses named pipes. Runtime ownership does not rely on PID reuse or recovery files. CLI lifecycle writes have a separate management lock.
- The existing synchronous library `startBridge(...).stop()` API and macOS launchd ownership remain compatible. Mac services now retain explicit Codex binary/home settings on refresh.
- Windows tasks launch a fixed system PowerShell executable with encoded literal paths, avoiding Task Scheduler percent-variable expansion. Windows private-state ACL checks are invalidated when a file is replaced.
- Native QR refresh preserves installed runtime/identity settings. Reset waits for the runtime to stop, then clears trust at the installed identity path while keeping its identity key.
- Windows optional SSH sessions do not receive POSIX auto-cd commands. Desktop GUI handoff remains advertised only on macOS; compatible IPC buses continue to be probed on native hosts.
- Automated native-manager contracts and real runner subprocesses are tested without registering host services. Actual Windows/Linux phone pairing, logon/reboot, task/systemd behavior and reconnect validation remain pending on those operating systems.
- The unchanged rollout suite has two pre-existing capped-bootstrap failures, reproduced in both baseline and final checks. Six original Swift cold-module-cache timeouts pass when rerun with the same sources/assertions and the standard shared compiler cache. No Xcode tests were run.

### Verification results (2026-11-19)

- Affected runtime/service/security/path suites: 134 passed, 2 native-platform-only cases skipped on macOS.
- Relay suite: 46 passed.
- Six original Swift timeout cases: 6 passed using the standard shared module cache; sources and assertions unchanged.
- Full bridge suite: 939 passed, 2 skipped, 8 failed (the six cold-cache compiler timeouts above and the two unchanged capped-bootstrap failures also present before this change).
- Package dry-run includes all native service modules. JavaScript syntax and `git diff --check` pass.
- No real services installed, no user pairing changed, no Xcode tests/builds/simulators run, and no commits or publishing performed.
