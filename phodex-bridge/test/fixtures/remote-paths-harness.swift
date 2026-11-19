import Foundation

final class RoutingState {
    enum Platform { case windows, linux }
    var bridgeHostPlatform = Platform.linux
    var authoritativeProjectPathByThreadID = [String: String]()
    func currentAuthoritativeProjectPath(for id: String) -> String? { authoritativeProjectPathByThreadID[id] }
    func normalizedThreadIdValue(_ id: String) -> String? { id }
}

@main struct RemotePathChecks {
    static func main() throws {
        var failures = [String]()
        func check(_ name: String, _ passed: Bool) {
            if !passed { failures.append(name) }
        }

        let windows = #"C:\Users\李 雷\Project X"#
        let worktree = #"C:\Users\李 雷\.codex\worktrees\c014\Project X"#
        let unc = #"\\build-server\源码\App"#
        for (path, name) in [(windows, "Project X"), (unc, "App"), (#"\\build-server\源码\"#, "源码"),
                             ("/home/李 雷/literal\\name", "literal\\name"), ("/", "/")] {
            check("folder label for \(path)", path.pathDisplayName == name)
        }
        for path in [windows, unc, "/home/李 雷/Project X", "~/workspace"] {
            let thread = CodexThread(id: "chat", metadata: ["cwd": .string(path)])
            let decoded = try JSONDecoder().decode(CodexThread.self, from: JSONEncoder().encode(thread))
            check("metadata cwd for \(path)", decoded.gitWorkingDirectory == path)
            let start = CodexThreadStartProjectBinding.makeThreadStartParams(modelIdentifier: nil,
                preferredProjectPath: decoded.normalizedProjectPath, serviceTier: nil)
            check("thread/start cwd for \(path)", start["cwd"]?.stringValue == path)
        }
        for relative in ["_default", "src/file", #"C:repo"#, #"\repo"#] {
            check("reject relative project \(relative)", CodexThreadStartProjectBinding.normalizedProjectPath(relative) == nil)
        }
        check("drive root", CodexThreadStartProjectBinding.normalizedProjectPath(#"C:\"#) == "C:/")
        check("trim trailing Windows separator", CodexThreadStartProjectBinding.normalizedProjectPath(windows + "\\") == windows)
        let thread = CodexThread(id: "worktree", cwd: worktree, worktreeOriginPath: unc)
        check("managed worktree label", thread.projectDisplayName == "Project X [c014]")
        check("managed worktree group", thread.projectGroupPath == unc)
        let canonical = TurnWorktreeRouting.comparableProjectPath(worktree)
        check("canonical keeps remote drive", canonical?.hasPrefix("C:") == true)
        let fromGit = "C:/Users/李 雷/.codex/worktrees/c014/Project X"
        let match = TurnWorktreeRouting.matchingLiveThread(in: [thread], projectPath: fromGit, sort: { $0 })
        check("reopen existing thread across git separators", match?.id == thread.id)
        let gitSpelling = CodexThread(id: "git", cwd: "c:/Users/李 雷/Project X")
        let nativeSpelling = CodexThread(id: "native", cwd: windows)
        check("one sidebar project across separators", gitSpelling.projectGroupKey == nativeSpelling.projectGroupKey)
        check("separate same-named POSIX repos", CodexThread(id: "a", cwd: "/repo/A").projectGroupKey
              != CodexThread(id: "b", cwd: "/repo/a").projectGroupKey)
        check("share root boundary", RemoteHostPath.relativePath(#"\\build-server\源码新\App"#, inside: #"\\build-server\源码"#) == nil)
        check("fuzzy relative path", RemoteHostPath.relativePath(#"c:\Users\李 雷\Project X\src\汉.swift"#, inside: windows) == "src/汉.swift")
        check("POSIX backslash literal", RemoteHostPath.relativePath(#"/repo/a\b"#, inside: "/repo") == #"a\b"#)
        for (url, expected) in [
            ("file:///C:/Users/me/Report%20one.md", "C:/Users/me/Report one.md"),
            ("file://build-server/share/Report.md", "//build-server/share/Report.md"),
            ("C:/repo/Report.md:12", "C:/repo/Report.md"),
            ("https://example.com/Report.md", nil),
            ("report.pdf", "report.pdf"),
            ("docs/%E5%90%88%E5%90%8C.docx", "docs/合同.docx"),
            ("C:/repo/release.zip", "C:/repo/release.zip"),
            ("https://example.com/release.zip", nil),
        ] as [(String, String?)] {
            check("workspace link \(url)", WorkspaceFileLinkResolver.localPath(from: URL(string: url)!) == expected)
        }
        let state = RoutingState()
        state.authoritativeProjectPathByThreadID["native"] = "C:/Users/李 雷/Project X"
        _ = state.applyingAuthoritativeProjectPath(to: nativeSpelling, treatAsServerState: true)
        check("server confirms completed worktree handoff", state.authoritativeProjectPathByThreadID.isEmpty)
        check("POSIX SSH cwd", state.directoryCommand("/repo/a b") == "cd '/repo/a b'\n")
        check("Windows SSH path never becomes a POSIX command", state.directoryCommand(#"C:\work\Project & data"#) == nil)
        state.bridgeHostPlatform = .windows
        check("Windows host with a slash path uses manual cd", state.directoryCommand("/work") == nil)
        if failures.isEmpty { print("remote path checks passed") }
        else { print(failures.joined(separator: "\n")); exit(1) }
    }
}
