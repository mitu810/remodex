// Purpose: Reads a phone-owned ChatGPT account's quota from the configured Codex account service.

import Foundation

enum CodexAccountUsageClient {
    enum Failure: LocalizedError {
        case authenticationRejected
        case unavailable

        var errorDescription: String? {
            switch self {
            case .authenticationRejected:
                String(localized: "This saved credential could not access usage. Renew it or import a current credential.")
            case .unavailable:
                String(localized: "Usage is unavailable right now.")
            }
        }
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()

    static func read(credential: SavedCodexCredential) async throws -> [String: JSONValue] {
        guard let url = AppEnvironment.codexAccountUsageURL else { throw Failure.unavailable }
        guard let authorization = credential.usageAuthorization else { throw Failure.authenticationRejected }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(authorization.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(authorization.accountID, forHTTPHeaderField: "ChatGPT-Account-Id")

        let (data, response) = try await session.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw Failure.unavailable }
        if status == 401 { throw Failure.authenticationRejected }
        guard status == 200, let payload = try? JSONDecoder().decode([String: JSONValue].self, from: data),
              payload["rate_limit"] != nil || payload["additional_rate_limits"] != nil || payload["credits"] != nil else {
            throw Failure.unavailable
        }
        return payload
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        nonisolated func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping @Sendable (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}
