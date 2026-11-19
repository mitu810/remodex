// FILE: String+PathDisplayName.swift
// Purpose: Centralizes the "show the basename, fall back to the full path when
//          empty" idiom used across the chat UI so every surface displays the
//          same folder/file name from a filesystem path string.
// Layer: Foundation Extension
// Exports: String.pathDisplayName
// Depends on: Foundation

import Foundation

extension String {
    /// Returns the user-facing leaf of this filesystem path.
    nonisolated var pathDisplayName: String { RemoteHostPath.displayName(self) }
}
