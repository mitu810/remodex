// FILE: WhatsNewSheet.swift
// Purpose: Lightweight root sheet that summarizes one release's notable improvements.
// Layer: View
// Exports: WhatsNewSheet
// Depends on: SwiftUI, AppFont

import SwiftUI

private struct WhatsNewItem {
    let title: String
    let detail: String
}

private let whatsNewItems: [WhatsNewItem] = [
    .init(
        title: String(localized: "Live Desktop Sync"),
        detail: String(localized: "Keep messages, models, queues, approvals, unread status, and active conversations synchronized between Remodex and Codex Desktop.")
    ),
    .init(
        title: String(localized: "Approve for Me"),
        detail: String(localized: "Let Codex review approval requests automatically, see what access is needed, and retry denied actions with one tap.")
    ),
    .init(
        title: String(localized: "Goals"),
        detail: String(localized: "Create long-running goals, track progress and token budgets, pause or resume work, and receive completion notifications.")
    ),
    .init(
        title: String(localized: "Live Activities"),
        detail: String(localized: "Follow running, completed, and failed chats from the Dynamic Island and Lock Screen, with shortcuts back to Remodex.")
    ),
    .init(
        title: String(localized: "Smarter Worktrees"),
        detail: String(localized: "Choose any base branch, carry configured project files into new worktrees, and keep worktree chats grouped under their original project.")
    ),
    .init(
        title: String(localized: "Better Model Controls"),
        detail: String(localized: "Use the redesigned model and intelligence picker with Fast Mode, an all-models browser, and automatic reloading.")
    ),
    .init(
        title: String(localized: "Redesigned Composer"),
        detail: String(localized: "Manage queued prompts, active plans, file changes, and skill mentions through cleaner, more compact controls.")
    ),
    .init(
        title: String(localized: "Better Markdown"),
        detail: String(localized: "Enjoy Markdown in your own messages and faster, smoother streaming responses.")
    ),
    .init(
        title: String(localized: "Clearer Tool Activity"),
        detail: String(localized: "Commands and tool calls are now grouped, expandable, and easier to follow with improved icons, statuses, history, and file changes.")
    ),
    .init(
        title: String(localized: "Smarter Sidebar"),
        detail: String(localized: "Find active and unread chats faster with improved sorting, status indicators, and automation labels.")
    ),
    .init(
        title: String(localized: "Reliable Recovery"),
        detail: String(localized: "Pairing, reconnects, and running chats now recover more reliably after sleep, relaunch, bridge restarts, or network loss.")
    ),
    .init(
        title: String(localized: "Cleaner Timelines"),
        detail: String(localized: "Duplicate messages, reasoning, final answers, and stale tool activity have been reduced, with smoother scrolling and history restoration.")
    ),
    .init(
        title: String(localized: "Improved Terminal"),
        detail: String(localized: "Select and copy terminal output, with refreshed native menus across Terminal, Settings, Git, and chat controls.")
    ),
    .init(
        title: String(localized: "Better Voice Input"),
        detail: String(localized: "Voice transcription is faster and more reliable, with smoother recording animations.")
    ),
    .init(
        title: String(localized: "Fresh New Look"),
        detail: String(localized: "A new Remodex icon and unified visual identity, plus an SF Pro Rounded font option.")
    ),
    .init(
        title: String(localized: "More Reliable Workflows"),
        detail: String(localized: "Plan Mode, completed steps, message sending, attachments, and long-running sessions are now more dependable.")
    ),
    .init(
        title: String(localized: "Performance and Stability"),
        detail: String(localized: "Cleaner Mac bridge removal, fixed service restart loops, and many additional synchronization, performance, and stability improvements.")
    ),
]

struct WhatsNewSheet: View {
    let version: String
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 24) {
                        header
                        featureList
                        visibilityNote
                    }
                    .padding(24)
                    .padding(.bottom, 140)
                }

                pinnedDismissButton
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What's New")
                .font(AppFont.title2(weight: .bold))

            Text("Remodex \(version)")
                .font(AppFont.mono(.subheadline))
                .foregroundStyle(.secondary)

            Text("Here’s what changed in this build.")
                .font(AppFont.body())
                .foregroundStyle(.secondary)
        }
    }

    private var featureList: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(whatsNewItems.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 12) {
                    Circle()
                        .fill(.secondary)
                        .frame(width: 5, height: 5)
                        .padding(.top, 8)

                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(item.title):")
                            .font(AppFont.body(weight: .semibold))
                            .foregroundStyle(.primary)

                        Text(item.detail)
                            .font(AppFont.body())
                            .foregroundStyle(.primary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var visibilityNote: some View {
        Text("We'll only show this once for each app version.")
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
    }

    private var pinnedDismissButton: some View {
        VStack(spacing: 0) {
            LinearGradient(
                colors: [
                    Color(.systemBackground).opacity(0),
                    Color(.systemBackground).opacity(0.92),
                    Color(.systemBackground)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 64)
            .allowsHitTesting(false)

            PrimaryCapsuleButton(title: String(localized: "Got It")) {
                onDismiss()
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
            .background(Color(.systemBackground))
        }
    }
}
