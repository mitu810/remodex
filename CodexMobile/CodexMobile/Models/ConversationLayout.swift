// FILE: ConversationLayout.swift
// Purpose: Defines the composer layout preference shared by Settings and the conversation.

import Foundation

enum ConversationLayout: String, CaseIterable {
    case standard
    case spacious

    static let storageKey = "codex.conversationLayout"

    var title: String {
        switch self {
        case .standard: String(localized: "Default")
        case .spacious: String(localized: "Spacious")
        }
    }

    var minimumExpandedInputHeight: CGFloat { self == .spacious ? 60 : 34 }
    var collapsedControlSize: CGFloat { self == .spacious ? 44 : 34 }
    var expandedControlSize: CGFloat? { self == .spacious ? 44 : nil }

    func maxVisibleLines(hasAccessories: Bool) -> CGFloat {
        switch (self, hasAccessories) {
        case (.standard, false): 6
        case (.standard, true): 4
        case (.spacious, false): 8
        case (.spacious, true): 5
        }
    }
}
