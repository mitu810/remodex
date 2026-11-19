// Downloads workspace files over the paired bridge and stages them for the Files picker.

import Foundation

nonisolated struct WorkspaceFileDownload {
    let url: URL

    private static let extensions: Set<String> = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "7z", "rar", "tar", "gz"
    ]

    static func supports(_ path: String) -> Bool {
        extensions.contains((path as NSString).pathExtension.lowercased())
    }

    func discard() {
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}

private struct WorkspaceFileChunk {
    let fileName: String
    let byteLength: Int
    let fileVersion: String
    let data: Data
}

enum WorkspaceFileError {
    static func downloadReason(forPreviewFailure failure: RPCError) -> String? {
        switch code(failure) {
        case "file_too_large":
            return String(localized: "This file is too large to preview. Download the original to Files.")
        case "binary_file", "unsupported_text_encoding":
            return String(localized: "This file cannot be previewed as text. Download the original to Files.")
        default:
            return nil
        }
    }

    static func displayMessage(for failure: RPCError) -> String {
        switch code(failure) {
        case "file_not_found", "image_not_found":
            return String(localized: "The file is no longer available on the paired device.")
        case "file_path_not_allowed":
            return String(localized: "Only files in the current workspace can be viewed.")
        case "history_image_unavailable":
            return String(localized: "Reopen the chat to reload this image, then tap it again.")
        default:
            return NSLocalizedString(failure.message, comment: "Workspace file operation error")
        }
    }

    private static func code(_ failure: RPCError) -> String? {
        failure.data?.objectValue?["errorCode"]?.stringValue
    }
}

extension CodexService {
    func downloadWorkspaceFile(
        path: String,
        cwd: String?,
        onProgress: (Double) -> Void
    ) async throws -> WorkspaceFileDownload {
        guard let deviceID = secureSession?.macDeviceId else { throw CodexServiceError.disconnected }
        guard let cwd, !cwd.isEmpty else {
            throw CodexServiceError.invalidInput(String(localized: "This chat has no workspace folder."))
        }

        var chunk = try await requestWorkspaceFileChunk(
            path: path, cwd: cwd, deviceID: deviceID, offset: 0, fileVersion: nil
        )
        let fileName = chunk.fileName
        let fileVersion = chunk.fileVersion
        let byteLength = chunk.byteLength
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: false)
        let download = WorkspaceFileDownload(url: directory.appendingPathComponent(fileName, isDirectory: false))
        var completed = false
        defer { if !completed { download.discard() } }

        try Data().write(to: download.url)
        let handle = try FileHandle(forWritingTo: download.url)
        defer { try? handle.close() }
        var received = 0
        while true {
            try Task.checkCancellation()
            guard chunk.fileName == fileName, chunk.fileVersion == fileVersion, chunk.byteLength == byteLength,
                  chunk.data.count <= byteLength - received,
                  !chunk.data.isEmpty || received == byteLength else {
                throw invalidDownloadResponse()
            }

            try handle.write(contentsOf: chunk.data)
            received += chunk.data.count
            onProgress(byteLength == 0 ? 1 : Double(received) / Double(byteLength))
            if received == byteLength { break }
            chunk = try await requestWorkspaceFileChunk(
                path: path, cwd: cwd, deviceID: deviceID, offset: received, fileVersion: fileVersion
            )
        }

        completed = true
        return download
    }

    private func requestWorkspaceFileChunk(
        path: String, cwd: String, deviceID: String, offset: Int, fileVersion: String?
    ) async throws -> WorkspaceFileChunk {
        var params: [String: JSONValue] = ["path": .string(path), "cwd": .string(cwd), "offset": .integer(offset)]
        if let fileVersion { params["fileVersion"] = .string(fileVersion) }
        let response: RPCMessage
        do {
            response = try await sendRequest(
                method: "workspace/readFileChunk",
                params: .object(params),
                timeoutNanoseconds: 30_000_000_000,
                timeoutMessage: String(localized: "The file download timed out. Try again."),
                expectedSecureDeviceID: deviceID
            )
        } catch CodexServiceError.rpcError(let failure) {
            if failure.data?.objectValue?["errorCode"]?.stringValue == "unknown_method" || failure.code == -32601 {
                throw CodexServiceError.invalidResponse(String(localized: "Update the bridge on this device to download files."))
            }
            throw CodexServiceError.invalidResponse(WorkspaceFileError.displayMessage(for: failure))
        }

        guard let result = response.result?.objectValue, result["offset"]?.intValue == offset,
              let fileName = result["fileName"]?.stringValue,
              !fileName.isEmpty, fileName != ".", fileName != "..",
              !fileName.contains("/"), !fileName.contains("\\"), !fileName.contains("\0"),
              let byteLength = result["byteLength"]?.intValue, (0...100 * 1024 * 1024).contains(byteLength),
              let version = result["fileVersion"]?.stringValue, !version.isEmpty,
              let encodedData = result["data"]?.stringValue,
              let data = Data(base64Encoded: encodedData), data.count <= 1024 * 1024 else {
            throw invalidDownloadResponse()
        }
        return WorkspaceFileChunk(fileName: fileName, byteLength: byteLength, fileVersion: version, data: data)
    }

    private func invalidDownloadResponse() -> CodexServiceError {
        .invalidResponse(String(localized: "The bridge returned an incomplete or invalid file."))
    }
}
