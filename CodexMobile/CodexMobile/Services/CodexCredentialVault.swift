// Purpose: Stores one device-local account library for all paired hosts.

import CryptoKit
import Foundation

struct SavedCodexCredential: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    let identity: String
    let email: String?
    let plan: String?
    let refreshedAt: Date?
    let authJSON: String

    var title: String {
        if !name.isEmpty { return name }
        return email ?? String(localized: "ChatGPT Account")
    }

    var fingerprint: String? {
        guard let encodedIdentity = Data(base64Encoded: identity),
              let parts = try? JSONDecoder().decode([String].self, from: encodedIdentity),
              parts.count == 2 else { return nil }
        let input = parts.map { Data($0.utf8).base64EncodedString() }.joined(separator: ".")
        return SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    init(authJSON: String, id: UUID = UUID(), name: String = "") throws {
        let data = Data(authJSON.utf8)
        guard data.count <= CodexCredentialVault.maximumImportBytes,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["auth_mode"] == nil || object["auth_mode"] is NSNull || object["auth_mode"] as? String == "chatgpt",
              object["OPENAI_API_KEY"] == nil || object["OPENAI_API_KEY"] is NSNull || object["OPENAI_API_KEY"] as? String == "",
              let tokens = object["tokens"] as? [String: Any],
              let idToken = tokens["id_token"] as? String,
              let accessToken = tokens["access_token"] as? String, !accessToken.isEmpty,
              let refreshToken = tokens["refresh_token"] as? String, !refreshToken.isEmpty else {
            throw CodexCredentialVault.invalidCredential
        }

        let idClaims = Self.claims(in: idToken)
        let accessClaims = Self.claims(in: accessToken)
        let auth = (idClaims["https://api.openai.com/auth"] ?? accessClaims["https://api.openai.com/auth"]) as? [String: Any]
        let profile = accessClaims["https://api.openai.com/profile"] as? [String: Any]
        let email = idClaims["email"] as? String ?? profile?["email"] as? String
        guard let user = auth?["chatgpt_user_id"] as? String ?? auth?["user_id"] as? String
                ?? idClaims["sub"] as? String ?? idClaims["email"] as? String, !user.isEmpty else {
            throw CodexCredentialVault.invalidCredential
        }
        let workspace = tokens["account_id"] as? String ?? auth?["chatgpt_account_id"] as? String ?? ""
        self.id = id
        self.name = name
        self.identity = try JSONEncoder().encode([user, workspace]).base64EncodedString()
        self.email = email
        self.plan = auth?["chatgpt_plan_type"] as? String
        self.authJSON = authJSON
        if let stamp = object["last_refresh"] as? String {
            let parser = ISO8601DateFormatter()
            let whole = parser.date(from: stamp)
            parser.formatOptions.insert(.withFractionalSeconds)
            refreshedAt = whole ?? parser.date(from: stamp)
        } else {
            refreshedAt = nil
        }
    }

    private static func claims(in token: String) -> [String: Any] {
        let components = token.split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 3 else { return [:] }
        var payload = components[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: payload) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

enum CodexCredentialVault {
    static let maximumImportBytes = 128 * 1024

    static var invalidCredential: CodexServiceError {
        .invalidInput(String(localized: "Select a Codex ChatGPT auth.json file."))
    }

    static func displayMessage(for error: Error) -> String {
        guard let serviceError = error as? CodexServiceError,
              case .rpcError(let response) = serviceError else {
            return error.localizedDescription
        }
        return NSLocalizedString(response.message, comment: "Account credential operation failure")
    }

    static func load() throws -> [SavedCodexCredential] {
        let data = try SecureStore.readPrivateData(for: CodexSecureKeys.accountCredentialVault)
        guard let data else { return [] }
        return try JSONDecoder().decode([SavedCodexCredential].self, from: data)
    }

    static func update(_ change: (inout [SavedCodexCredential]) throws -> Void) throws -> [SavedCodexCredential] {
        var credentials = try load()
        try change(&credentials)
        let data = try JSONEncoder().encode(credentials)
        try SecureStore.writeDeviceOnlyData(data, for: CodexSecureKeys.accountCredentialVault)
        return credentials
    }

    static func readImport(_ url: URL) throws -> SavedCodexCredential {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        guard let data = try file.read(upToCount: maximumImportBytes + 1),
              data.count <= maximumImportBytes,
              let credential = String(data: data, encoding: .utf8) else {
            throw invalidCredential
        }
        return try SavedCodexCredential(authJSON: credential)
    }

    static func mergeImported(_ imported: SavedCodexCredential, into credentials: inout [SavedCodexCredential]) throws {
        guard let index = credentials.firstIndex(where: { $0.identity == imported.identity }) else {
            credentials.append(imported)
            return
        }
        let saved = credentials[index]
        guard (imported.refreshedAt ?? .distantPast) > (saved.refreshedAt ?? .distantPast) else { return }
        credentials[index] = try SavedCodexCredential(authJSON: imported.authJSON, id: saved.id, name: saved.name)
    }
}

struct CodexCredentialCheckResult {
    let usage: [CodexRateLimitBucket]
    let creditsBalance: String?
    let unlimited: Bool
    let credential: String?
    let usageUnavailable: Bool
    let renewalFailed: Bool
}

enum CodexCredentialApplyResult {
    case alreadyActive
    case restarted(desktopRestartFailed: Bool)
    case differentAccount
    case awaitingVerification
}

extension CodexService {
    static let managedCredentialStatusDefaultsKey = "codex.credentials.deviceAccounts"

    func applySavedCredential(
        _ credential: SavedCodexCredential,
        deviceID: String,
        onRestartScheduled: () -> Void
    ) async throws -> CodexCredentialApplyResult {
        guard let fingerprint = credential.fingerprint else { throw CodexCredentialVault.invalidCredential }
        let previousReplayEpoch = lastAppliedBridgeReplayEpoch
        let result: [String: JSONValue]
        do {
            result = try await requestCredentialOperation("applyAndRestart", credential: credential, deviceID: deviceID)
        } catch CodexServiceError.rpcError(let error) where error.code == -32601 {
            throw CodexServiceError.invalidResponse(String(localized: "Update the bridge on this device to switch accounts automatically."))
        }
        guard let restartScheduled = result["restartScheduled"]?.boolValue else {
            throw CodexServiceError.invalidResponse(String(localized: "The device did not confirm the credential update."))
        }
        guard restartScheduled else {
            await refreshGPTAccountState()
            return .alreadyActive
        }

        managedCredentialRestartingDeviceIDs.insert(deviceID)
        defer { managedCredentialRestartingDeviceIDs.remove(deviceID) }
        liveManagedCredentialDeviceID = nil
        onRestartScheduled()

        // A relay can keep the phone's socket alive while its paired bridge is
        // replaced. Reconnect explicitly so both parties establish fresh keys.
        try await Task.sleep(for: .milliseconds(850))
        if isConnected, secureSession?.macDeviceId == deviceID,
           lastAppliedBridgeReplayEpoch == previousReplayEpoch {
            await disconnect(preserveReconnectIntent: true)
            shouldAutoReconnectOnForeground = true
        }

        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(40)
        while clock.now < deadline {
            guard (normalizedCurrentTrustedMacDeviceId ?? normalizedRelayMacDeviceId) == deviceID else {
                return .awaitingVerification
            }
            if isConnected, liveManagedCredentialDeviceID == deviceID,
               lastAppliedBridgeReplayEpoch != previousReplayEpoch {
                return managedCredentialStatusByDeviceID[deviceID] == fingerprint
                    ? .restarted(desktopRestartFailed: managedCredentialDesktopRestartFailed)
                    : .differentAccount
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        return .awaitingVerification
    }

    func recordManagedCredentialStatus(_ status: [String: JSONValue]?, for deviceID: String) {
        guard isConnected, secureSession?.macDeviceId == deviceID else { return }
        let fingerprint = status?["fingerprint"]?.stringValue
        let hasValidFingerprint = fingerprint?.utf8.count == 64
            && fingerprint?.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } == true
        guard hasValidFingerprint || status?["signedIn"]?.boolValue == false else {
            liveManagedCredentialDeviceID = nil
            return
        }
        liveManagedCredentialDeviceID = deviceID
        managedCredentialDesktopRestartFailed = status?["desktopRestartFailed"]?.boolValue == true
        managedCredentialStatusByDeviceID[deviceID] = hasValidFingerprint ? fingerprint : ""
        defaults.set(managedCredentialStatusByDeviceID, forKey: Self.managedCredentialStatusDefaultsKey)
    }

    func forgetManagedCredentialStatus(for deviceID: String) {
        managedCredentialStatusByDeviceID.removeValue(forKey: deviceID)
        if liveManagedCredentialDeviceID == deviceID { liveManagedCredentialDeviceID = nil }
        defaults.set(managedCredentialStatusByDeviceID, forKey: Self.managedCredentialStatusDefaultsKey)
    }

    func checkSavedCredential(_ credential: SavedCodexCredential, deviceID: String, renew: Bool) async throws -> CodexCredentialCheckResult {
        let result = try await requestCredentialOperation("check", credential: credential, deviceID: deviceID, renew: renew)
        let usage = result["usage"]?.objectValue ?? [:]
        let credits = usage["rateLimits"]?.objectValue?["credits"]?.objectValue
        return CodexCredentialCheckResult(
            usage: savedCredentialRateLimitBuckets(from: usage),
            creditsBalance: credits?["balance"]?.stringValue,
            unlimited: credits?["unlimited"]?.boolValue == true,
            credential: result["credential"]?.stringValue,
            usageUnavailable: result["usageUnavailable"]?.boolValue == true,
            renewalFailed: result["renewalFailed"]?.boolValue == true
        )
    }

    private func requestCredentialOperation(
        _ operation: String,
        credential: SavedCodexCredential,
        deviceID: String,
        renew: Bool = false
    ) async throws -> [String: JSONValue] {
        let response = try await sendRequest(
            method: "remodex/accountCredential/\(operation)",
            params: .object([
                "deviceId": .string(deviceID),
                "credential": .string(credential.authJSON),
                "renew": .bool(renew),
            ]),
            timeoutNanoseconds: 50_000_000_000,
            expectedSecureDeviceID: deviceID
        )
        guard let result = response.result?.objectValue else {
            throw CodexServiceError.invalidResponse(String(localized: "The device did not return an account update."))
        }
        return result
    }
}
