// FILE: UserAttachmentViews.swift
// Purpose: Renders user image attachments in timeline rows and resolves preview images.
// Layer: Turn UI component
// Exports: UserAttachmentStrip, AttachmentPreviewImageResolver
// Depends on: Foundation, SwiftUI, UIKit, CodexImageAttachment, HapticFeedback

import Foundation
import SwiftUI
import UIKit

@MainActor
private enum UserAttachmentThumbnailCache {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(for attachment: CodexImageAttachment) -> UIImage? {
        guard !attachment.thumbnailBase64JPEG.isEmpty else {
            return nil
        }

        let key = cacheKey(for: attachment)
        if let cached = cache.object(forKey: key as NSString) {
            return cached
        }

        guard let data = Data(base64Encoded: attachment.thumbnailBase64JPEG),
              let image = UIImage(data: data) else {
            return nil
        }
        cache.setObject(image, forKey: key as NSString)
        return image
    }

    // Thumbnail decoding used to happen from the SwiftUI body on every row redraw.
    private static func cacheKey(for attachment: CodexImageAttachment) -> String {
        "\(attachment.id)|\(attachment.thumbnailContentFingerprint.cacheKey)"
    }
}

struct TimelineImageThumbnail: View {
    let image: UIImage?
    var side: CGFloat = TurnAttachmentThumbnailMetrics.side

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: TurnAttachmentThumbnailMetrics.cornerRadius)
        ZStack {
            shape.fill(Color(.secondarySystemFill))
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                RemodexIcon.image(systemName: "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: side, height: side)
        .clipShape(shape)
        .overlay { shape.strokeBorder(Color(.separator).opacity(0.6)) }
        .contentShape(shape)
    }
}

struct UserAttachmentStrip: View {
    let attachments: [CodexImageAttachment]
    var currentWorkingDirectory: String? = nil
    var alignment: HorizontalAlignment = .trailing

    @State private var previewImage: PreviewImagePayload?
    @State private var isPreviewUnavailable = false
    @State private var previewErrorText = ""

    var body: some View {
        VStack(alignment: alignment, spacing: 4) {
            ForEach(attachments) { attachment in
                if !attachment.hasPreviewPayload,
                   let reference = Self.workspaceReference(for: attachment, cwd: currentWorkingDirectory) {
                    AssistantMarkdownImagePreviewButton(reference: reference, currentWorkingDirectory: currentWorkingDirectory)
                } else {
                    attachmentButton(attachment)
                }
            }
        }
        .fullScreenCover(item: $previewImage) { payload in
            ZoomableImagePreviewScreen(payload: payload, onDismiss: { previewImage = nil })
        }
        .alert("Image unavailable", isPresented: $isPreviewUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(previewErrorText)
        }
    }

    private func attachmentButton(_ attachment: CodexImageAttachment) -> some View {
        let fileName = attachment.displayFileName ?? String(localized: "Image")
        return Button {
            HapticFeedback.shared.triggerImpactFeedback(style: .light)
            if let image = AttachmentPreviewImageResolver.resolve(attachment) {
                previewImage = PreviewImagePayload(image: image, title: fileName)
            } else {
                previewErrorText = attachment.isElidedHistoryPlaceholder
                    ? String(localized: "This attachment needs a bridge update and a chat reload before it can be viewed.")
                    : String(localized: "No preview data is available for this attachment.")
                isPreviewUnavailable = true
            }
        } label: {
            TimelineImageThumbnail(image: UserAttachmentThumbnailCache.image(for: attachment))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(fileName)
    }

    static func workspaceReference(for attachment: CodexImageAttachment, cwd: String?) -> AssistantMarkdownImageReference? {
        guard let source = attachment.sourceURL, let url = URL(string: source) else { return nil }
        let path = CodexImageAttachment.isHistoryImageReference(source) ? source : RemoteHostPath.linkDestination(url)
        guard let path else { return nil }
        let reference = AssistantMarkdownImageReference(path: path, altText: "", occurrenceIndex: 0)
        return reference.canPreview(currentWorkingDirectory: cwd) ? reference : nil
    }
}

@MainActor
enum AttachmentPreviewImageResolver {
    // Uses full payload data URL first, then falls back to the cached thumbnail for resilience.
    static func resolve(_ attachment: CodexImageAttachment) -> UIImage? {
        if let payloadDataURL = attachment.payloadDataURL,
           let imageData = decodeImageDataFromDataURL(payloadDataURL),
           let image = UIImage(data: imageData) {
            return image
        }

        return UserAttachmentThumbnailCache.image(for: attachment)
    }

    private static func decodeImageDataFromDataURL(_ dataURL: String) -> Data? {
        guard let commaIndex = dataURL.firstIndex(of: ",") else {
            return nil
        }

        let metadata = dataURL[..<commaIndex].lowercased()
        guard metadata.hasPrefix("data:image"),
              metadata.contains(";base64") else {
            return nil
        }

        let payloadStart = dataURL.index(after: commaIndex)
        return Data(base64Encoded: String(dataURL[payloadStart...]))
    }
}
