# Implementation Plans

Plan 002 implements native Windows/Linux hosts alongside macOS. Its validation status distinguishes automated checks from pending native device runs.


Plans cover local-first runtime reliability and native host support. Plan 002's implementation and automated checks are in place; real Windows/Linux device validation remains pending.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 002 | Native Windows and Linux host support | P1 | L | — | IN PROGRESS |
| 001 | Prevent orphaned macOS LaunchAgent restart loops and add clean service removal | P1 | M | — | DONE |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale — finding fixed independently or approach
abandoned)

## Dependency notes

- Plan 001 is self-contained. Its tests should land with the implementation so
  the launch policy, legacy-plist migration, and removal ordering cannot drift.

## Findings considered and rejected

- Add `PathState` alongside `SuccessfulExit=false`: rejected because launchd
  ORs separate `KeepAlive` conditions, so the unsuccessful-exit condition
  would continue scheduling the missing program.
- Replace `SuccessfulExit=false` with `PathState`: rejected because it changes
  clean-exit behavior, protects only one path, and Apple documents filesystem
  state monitoring as race-prone. In Remodex it would also restart the current
  clean "daemon config missing" exit while the CLI path still exists.
- Use `SuccessfulExit=true` or `Crashed=true`: rejected because either policy
  loses ordinary Node failure recovery; Node exceptions normally exit non-zero
  rather than through a crash signal.
- Add an npm uninstall lifecycle hook: rejected because npm 7 and newer do not
  run uninstall lifecycle scripts.
- Add menu bar UI or Xcode work in this fix: rejected as unnecessary scope.
  The CLI is installed independently, the existing menu bar updater already
  calls the plist-rewriting `start` path, and deleting an app from Finder has
  no reliable uninstall callback.

