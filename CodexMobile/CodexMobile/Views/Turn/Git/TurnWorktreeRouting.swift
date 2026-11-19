// FILE: TurnWorktreeRouting.swift
// Purpose: Centralizes worktree path normalization and live-thread reuse decisions for TurnView.
// Layer: View Support
// Exports: TurnWorktreeRouting

import Foundation

enum TurnWorktreeRouting {
    static func comparableProjectPath(_ rawPath: String?) -> String? {
        RemoteHostPath.comparisonPath(rawPath)
    }

    // Prefers reopening the live thread already associated with a worktree instead of spawning another one.
    static func matchingLiveThread(
        in threads: [CodexThread],
        projectPath: String,
        sort: ([CodexThread]) -> [CodexThread]
    ) -> CodexThread? {
        guard let target = comparableProjectPath(projectPath) else { return nil }
        let matchingLiveThreads = threads.filter { thread in
            thread.syncState == .live
                && comparableProjectPath(thread.normalizedProjectPath) == target
        }

        return sort(matchingLiveThreads).first
    }
}
