// Paths supplied by the bridge belong to its filesystem. Never resolve them against iOS.
import Foundation

nonisolated enum RemoteHostPath {
    private static func hasDrive(_ path: String) -> Bool {
        let bytes = path.utf8
        guard bytes.count >= 2, let first = bytes.first,
              (65...90).contains(first) || (97...122).contains(first) else { return false }
        return bytes.dropFirst().first == 58
    }

    static func isWindows(_ path: String) -> Bool {
        hasDrive(path) || path.hasPrefix(#"\\"#) || (path.hasPrefix("//") && !path.hasPrefix("///"))
    }

    // Convert separators only when the path or its supplied host context identifies Windows.
    static func slashPath(_ path: String, relativeTo base: String? = nil) -> String {
        if isWindows(path) || (!path.hasPrefix("/") && base.map(isWindows) == true) {
            return path.replacingOccurrences(of: #"\"#, with: "/")
        }
        return path
    }

    private static func root(of path: String) -> String? {
        if hasDrive(path) {
            guard path.dropFirst(2).hasPrefix("/") else { return nil }
            return String(path.prefix(3))
        }
        if path.hasPrefix("//") && !path.hasPrefix("///") {
            let parts = path.dropFirst(2).split(separator: "/", maxSplits: 2)
            guard parts.count >= 2 else { return nil }
            return "//" + parts[0] + "/" + parts[1]
        }
        if path.hasPrefix("/") { return "/" }
        if path == "~" || path.hasPrefix("~/") { return "~/" }
        return nil
    }

    static func projectPath(_ raw: String?) -> String? {
        guard var path = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              let root = root(of: slashPath(path)) else { return nil }
        let windows = isWindows(path)
        while path.last == "/" || (windows && path.last == #"\"#) {
            path.removeLast()
        }
        if path.isEmpty || path == "~" || (hasDrive(path) && path.count == 2) { return root }
        return path
    }

    // Used for comparisons only. The original host spelling stays on outgoing RPCs.
    static func comparisonPath(_ raw: String?) -> String? {
        guard let path = projectPath(raw) else { return nil }
        let slashes = slashPath(path)
        if hasDrive(slashes) { return slashes.prefix(1).uppercased() + slashes.dropFirst() }
        return slashes
    }

    static func sameProject(_ first: String?, _ second: String?) -> Bool {
        guard let key = comparisonPath(first) else { return false }
        return key == comparisonPath(second)
    }

    // Keep the native separator in persisted Windows sidebar IDs (including older IDs).
    static func projectGroupKey(_ path: String) -> String {
        guard isWindows(path), let key = comparisonPath(path) else { return path }
        return key.replacingOccurrences(of: "/", with: #"\"#)
    }

    static func linkDestination(_ url: URL) -> String? {
        if url.isFileURL {
            if let host = url.host, !host.isEmpty, host.lowercased() != "localhost" {
                return "//" + host + url.path
            }
            let path = url.path
            if path.hasPrefix("/"), hasDrive(String(path.dropFirst())) {
                return String(path.dropFirst())
            }
            return path
        }
        let decoded = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        guard url.scheme == nil || (hasDrive(decoded) && projectPath(decoded) != nil) else { return nil }
        return decoded
    }

    static func displayName(_ path: String, relativeTo base: String? = nil) -> String {
        let slashes = slashPath(path, relativeTo: base)
        if hasDrive(slashes), let root = root(of: slashes),
           slashes.dropFirst(root.count).allSatisfy({ $0 == "/" }) { return root }
        return slashes.split(separator: "/").last.map(String.init) ?? path
    }

    // Joins using the remote directory's separator, without expanding home or following symlinks.
    static func resolve(_ path: String, against base: String?) -> String? {
        guard !path.isEmpty else { return nil }
        if projectPath(path) != nil { return path }
        guard let base = projectPath(base) else { return nil }
        let windows = isWindows(base)
        guard !windows || (!hasDrive(path) && !path.hasPrefix(#"\"#)) else { return nil }
        let separator = windows && base.contains(#"\"#) ? #"\"# : "/"
        let child = slashPath(path, relativeTo: base).replacingOccurrences(of: "/", with: separator)
        return (base.hasSuffix(separator) ? base : base + separator) + child
    }

    // Component boundaries protect sibling repositories and UNC shares. The bridge verifies realpaths.
    static func relativePath(_ path: String, inside base: String) -> String? {
        guard let candidate = comparisonPath(path), let directory = comparisonPath(base),
              let volume = root(of: candidate), root(of: directory) == volume else { return nil }
        func components(_ value: String) -> [Substring] {
            var result = [Substring]()
            for part in value.dropFirst(volume.count).split(separator: "/") {
                if part == ".." {
                    if !result.isEmpty { result.removeLast() }
                } else if part != "." {
                    result.append(part)
                }
            }
            return result
        }
        let pathParts = components(candidate)
        let rootParts = components(directory)
        guard pathParts.starts(with: rootParts) else { return nil }
        return pathParts.dropFirst(rootParts.count).joined(separator: "/")
    }
}
