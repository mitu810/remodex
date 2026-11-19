// FILE: CodexImageAttachment.swift
// Purpose: Defines image attachment payload persisted in user chat messages.
// Layer: Model
// Exports: CodexImageAttachment
// Depends on: Foundation

import Foundation

struct CodexImageAttachment: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let thumbnailBase64JPEG: String
    let payloadDataURL: String?
    let sourceURL: String?
    let fileName: String?
    let thumbnailContentFingerprint: CodexTextContentFingerprint
    let payloadContentFingerprint: CodexTextContentFingerprint?
    let sourceContentFingerprint: CodexTextContentFingerprint?

    init(
        id: String = UUID().uuidString,
        thumbnailBase64JPEG: String,
        payloadDataURL: String? = nil,
        sourceURL: String? = nil,
        fileName: String? = nil
    ) {
        self.id = id
        self.thumbnailBase64JPEG = thumbnailBase64JPEG
        self.payloadDataURL = payloadDataURL
        self.sourceURL = sourceURL
        self.fileName = fileName
        self.thumbnailContentFingerprint = CodexTextContentFingerprint(thumbnailBase64JPEG)
        self.payloadContentFingerprint = payloadDataURL.map(CodexTextContentFingerprint.init)
        self.sourceContentFingerprint = sourceURL.map(CodexTextContentFingerprint.init)
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case thumbnailBase64JPEG
        case payloadDataURL
        case sourceURL
        case fileName
        case thumbnailContentFingerprint
        case payloadContentFingerprint
        case sourceContentFingerprint
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        thumbnailBase64JPEG = try container.decode(String.self, forKey: .thumbnailBase64JPEG)
        payloadDataURL = try container.decodeIfPresent(String.self, forKey: .payloadDataURL)
        sourceURL = try container.decodeIfPresent(String.self, forKey: .sourceURL)
        fileName = try container.decodeIfPresent(String.self, forKey: .fileName)
        thumbnailContentFingerprint = try container.decodeIfPresent(
            CodexTextContentFingerprint.self,
            forKey: .thumbnailContentFingerprint
        ) ?? CodexTextContentFingerprint(thumbnailBase64JPEG)
        let decodedPayloadFingerprint = try container.decodeIfPresent(
            CodexTextContentFingerprint.self,
            forKey: .payloadContentFingerprint
        )
        payloadContentFingerprint = payloadDataURL == nil
            ? nil
            : decodedPayloadFingerprint ?? payloadDataURL.map(CodexTextContentFingerprint.init)
        let decodedSourceFingerprint = try container.decodeIfPresent(
            CodexTextContentFingerprint.self,
            forKey: .sourceContentFingerprint
        )
        sourceContentFingerprint = sourceURL == nil
            ? nil
            : decodedSourceFingerprint ?? sourceURL.map(CodexTextContentFingerprint.init)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(thumbnailBase64JPEG, forKey: .thumbnailBase64JPEG)
        try container.encodeIfPresent(payloadDataURL, forKey: .payloadDataURL)
        try container.encodeIfPresent(sourceURL, forKey: .sourceURL)
        try container.encodeIfPresent(fileName, forKey: .fileName)
        try container.encode(thumbnailContentFingerprint, forKey: .thumbnailContentFingerprint)
        try container.encodeIfPresent(payloadContentFingerprint, forKey: .payloadContentFingerprint)
        try container.encodeIfPresent(sourceContentFingerprint, forKey: .sourceContentFingerprint)
    }

    // History rows usually keep thumbnails; callers can preserve bounded inline payloads
    // when the original file path is not previewable through the workspace bridge.
    func sanitizedForStorage(preservingPayloadDataURL: Bool) -> CodexImageAttachment {
        CodexImageAttachment(
            id: id,
            thumbnailBase64JPEG: thumbnailBase64JPEG,
            payloadDataURL: preservingPayloadDataURL ? normalizedPayloadDataURL : nil,
            sourceURL: normalizedSourceURL,
            fileName: fileName ?? inlineHEIFFileName
        )
    }

    // Keeps attachment matching stable without hashing giant inline data URLs.
    nonisolated var stableIdentityKey: String {
        if let normalizedSourceURL {
            return normalizedSourceURL
        }
        if !thumbnailBase64JPEG.isEmpty {
            return thumbnailBase64JPEG
        }
        if let normalizedPayloadDataURL {
            return normalizedPayloadDataURL
        }
        return id
    }

    // Distinguishes attachments with local preview data from path-only items.
    nonisolated var hasPreviewPayload: Bool {
        !thumbnailBase64JPEG.isEmpty || normalizedPayloadDataURL != nil
    }

    nonisolated var isElidedHistoryPlaceholder: Bool {
        normalizedSourceURL == "remodex://history-image-elided"
    }

    nonisolated static func isHistoryImageReference(_ path: String) -> Bool {
        guard let url = URL(string: path), url.scheme == "remodex", url.host == "history-image",
              url.query == nil, url.fragment == nil else { return false }
        let components = url.pathComponents.dropFirst()
        guard components.count == 2, let digest = components.first else { return false }
        return digest.utf8.count == 64 && digest.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    nonisolated static func mergingHistory(_ existing: [Self], with incoming: [Self]) -> [Self] {
        if existing.isEmpty { return incoming }
        guard existing.count == incoming.count else { return existing }
        return zip(existing, incoming).map { saved, updated in
            if saved.isElidedHistoryPlaceholder,
               updated.hasPreviewPayload || updated.sourceURL.map(isHistoryImageReference) == true {
                return updated
            }
            return saved
        }
    }

    nonisolated var displayFileName: String? {
        if let fileName, !fileName.isEmpty { return fileName.pathDisplayName }
        if let source = normalizedSourceURL {
            if isElidedHistoryPlaceholder { return nil }
            let path = URL(string: source)?.path.removingPercentEncoding ?? source
            return path.pathDisplayName
        }
        return inlineHEIFFileName
    }

    private nonisolated var inlineHEIFFileName: String? {
        guard let payloadDataURL else { return nil }
        let header = payloadDataURL.prefix(32).lowercased()
        if header.hasPrefix("data:image/heic;") { return "Image.heic" }
        if header.hasPrefix("data:image/heif;") { return "Image.heif" }
        return nil
    }

    nonisolated private var normalizedPayloadDataURL: String? {
        let trimmed = payloadDataURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    nonisolated private var normalizedSourceURL: String? {
        let trimmed = sourceURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty, !Self.isInlineImageDataURL(trimmed) else {
            return nil
        }
        return trimmed
    }

    nonisolated private static func isInlineImageDataURL(_ value: String) -> Bool {
        value.lowercased().hasPrefix("data:image")
    }
}
