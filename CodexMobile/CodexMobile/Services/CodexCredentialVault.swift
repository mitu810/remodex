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
    var accessExpiresAt: Date?
    var usageSnapshot: CodexAccountUsageSnapshot?

    var usageAuthorization: (accessToken: String, accountID: String?)? {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(authJSON.utf8))) as? [String: Any],
              let tokens = object["tokens"] as? [String: Any],
              let accessToken = tokens["access_token"] as? String, Self.isHeaderValue(accessToken) else { return nil }
        let authClaim = "https://api.openai.com/auth"
        let accessAuth = Self.claims(in: accessToken)[authClaim] as? [String: Any]
        let identityAuth = tokens["id_token"].flatMap { $0 as? String }.map(Self.claims)?[authClaim] as? [String: Any]
        let accountID = [
            tokens["account_id"] as? String,
            accessAuth?["chatgpt_account_id"] as? String,
            identityAuth?["chatgpt_account_id"] as? String,
        ].compactMap { $0 }.first(where: Self.isHeaderValue)
        return (accessToken, accountID)
    }

    var effectiveAccessExpiry: Date? {
        if let accessExpiresAt { return accessExpiresAt }
        // Vault records created before expiration tracking still contain the JWT.
        guard let object = (try? JSONSerialization.jsonObject(with: Data(authJSON.utf8))) as? [String: Any],
              let tokens = object["tokens"] as? [String: Any],
              let token = tokens["access_token"] as? String else { return nil }
        return Self.accessExpiry(in: Self.claims(in: token))
    }

    func needsRenewal(at now: Date = .now) -> Bool {
        if let expiry = effectiveAccessExpiry {
            return expiry.timeIntervalSince(now) <= 24 * 60 * 60
        }
        return now.timeIntervalSince(refreshedAt ?? .distantPast) >= 7 * 24 * 60 * 60
    }

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
        self.accessExpiresAt = Self.accessExpiry(in: accessClaims)
        if let stamp = object["last_refresh"] as? String {
            let parser = ISO8601DateFormatter()
            let whole = parser.date(from: stamp)
            parser.formatOptions.insert(.withFractionalSeconds)
            refreshedAt = whole ?? parser.date(from: stamp)
        } else {
            refreshedAt = nil
        }
    }

    private static func accessExpiry(in claims: [String: Any]) -> Date? {
        guard let seconds = claims["exp"] as? Double, seconds.isFinite, seconds > 0 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    private static func isHeaderValue(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { (33...126).contains($0) }
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
        var replacement = try SavedCodexCredential(authJSON: imported.authJSON, id: saved.id, name: saved.name)
        replacement.usageSnapshot = saved.usageSnapshot
        credentials[index] = replacement
    }
}

struct CodexAccountUsageSnapshot: Codable, Equatable, Sendable {
    let buckets: [CodexRateLimitBucket]
    let credits: CodexAccountUsageCredits?
    let updatedAt: Date
}

struct CodexAccountUsageCredits: Codable, Equatable, Sendable {
    let creditsBalance: String?
    let unlimited: Bool

    var displayBalance: String {
        if unlimited { return String(localized: "Unlimited") }
        guard let creditsBalance,
              let balance = Decimal(string: creditsBalance, locale: Locale(identifier: "en_US_POSIX")),
              !balance.isNaN else { return String(localized: "Unavailable") }
        return balance.formatted(.number.precision(.fractionLength(0)))
    }
}

private struct CodexCredentialCheckResult {
    let usage: CodexAccountUsageSnapshot?
    let credential: String?
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
        guard !isApplyingVaultCredential else {
            throw CodexServiceError.invalidInput(String(localized: "An account operation is in progress. Try again shortly."))
        }
        isApplyingVaultCredential = true
        defer { isApplyingVaultCredential = false }
        if let savedCredentialCheckTask { _ = try? await savedCredentialCheckTask.value }
        guard let credential = try CodexCredentialVault.load().first(where: { $0.id == credential.id }) else {
            throw CodexCredentialVault.invalidCredential
        }
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

    // The service owns the request through persistence even when its settings page is dismissed.
    func refreshSavedCredential(id: UUID, renewingOn deviceID: String? = nil) async throws {
        guard savedCredentialCheckTask == nil, !isApplyingVaultCredential else {
            throw CodexServiceError.invalidInput(String(localized: "An account operation is in progress. Try again shortly."))
        }
        guard let credential = try CodexCredentialVault.load().first(where: { $0.id == id }) else { return }
        if let deviceID, let fingerprint = credential.fingerprint,
           managedCredentialStatusByDeviceID[deviceID] != fingerprint,
           managedCredentialStatusByDeviceID.contains(where: { $0.key != deviceID && $0.value == fingerprint }) {
            throw CodexServiceError.invalidInput(String(localized: "Connect to the device using this account before renewing it."))
        }

        checkingSavedCredentialID = id
        let task = Task { @MainActor [self] in
            defer {
                checkingSavedCredentialID = nil
                savedCredentialCheckTask = nil
            }
            let result = try await checkSavedCredential(credential, renewingOn: deviceID)
            if result.credential != nil || result.usage != nil {
                _ = try CodexCredentialVault.update { profiles in
                    guard let index = profiles.firstIndex(where: { $0.id == id }),
                          profiles[index].authJSON == credential.authJSON else { return }
                    if let json = result.credential {
                        var updated = try SavedCodexCredential(authJSON: json, id: id, name: profiles[index].name)
                        guard updated.identity == credential.identity,
                              (updated.refreshedAt ?? .distantPast) >= (credential.refreshedAt ?? .distantPast) else {
                            throw CodexCredentialVault.invalidCredential
                        }
                        updated.usageSnapshot = profiles[index].usageSnapshot
                        profiles[index] = updated
                    }
                    if let usage = result.usage { profiles[index].usageSnapshot = usage }
                }
                savedCredentialVaultRevision &+= 1
            }
            if result.renewalFailed {
                throw CodexServiceError.invalidResponse(String(localized: "Codex did not confirm a renewed credential."))
            }
            if result.usage == nil, deviceID == nil {
                throw CodexServiceError.invalidResponse(String(localized: "Usage is unavailable right now."))
            }
        }
        savedCredentialCheckTask = task
        try await task.value
    }

    // Reuses the live device when it owns this credential. Avoid rotating a copy
    // when a different paired host is known to be using the same account.
    func runCredentialMaintenance(deviceID: String) async {
        while !Task.isCancelled, isAppInForeground, isConnected, secureSession?.macDeviceId == deviceID {
            await refreshRateLimits()
            if let profiles = try? CodexCredentialVault.load() {
                for profile in profiles where profile.needsRenewal() {
                    guard !Task.isCancelled, isAppInForeground, isConnected, secureSession?.macDeviceId == deviceID,
                          savedCredentialCheckTask == nil, !isApplyingVaultCredential else { break }
                    guard let fingerprint = profile.fingerprint,
                          !managedCredentialStatusByDeviceID.contains(where: { $0.key != deviceID && $0.value == fingerprint }),
                          Date().timeIntervalSince(lastCredentialRenewalAttempt[profile.id] ?? .distantPast) >= 3600 else { continue }
                    lastCredentialRenewalAttempt[profile.id] = .now
                    do {
                        try await refreshSavedCredential(id: profile.id, renewingOn: deviceID)
                        savedCredentialRenewalFailures.removeValue(forKey: profile.id)
                    } catch {
                        if isConnected, secureSession?.macDeviceId == deviceID {
                            savedCredentialRenewalFailures[profile.id] = CodexCredentialVault.displayMessage(for: error)
                        }
                    }
                }
            }
            try? await Task.sleep(for: .seconds(300))
        }
    }

    private func checkSavedCredential(
        _ credential: SavedCodexCredential,
        renewingOn deviceID: String?
    ) async throws -> CodexCredentialCheckResult {
        if let deviceID {
            return try await checkSavedCredentialOnDevice(credential, deviceID: deviceID, renew: true)
        }
        do {
            let payload = try await CodexAccountUsageClient.read(credential: credential)
            return CodexCredentialCheckResult(usage: savedCredentialUsageSnapshot(from: payload), credential: nil, renewalFailed: false)
        } catch CodexAccountUsageClient.Failure.authenticationRejected {
            // The linked host may already hold a newer token. Only read from a
            // live device verified to use this account, without requesting renewal.
            guard isConnected, let deviceID = secureSession?.macDeviceId,
                  liveManagedCredentialDeviceID == deviceID,
                  let fingerprint = credential.fingerprint,
                  managedCredentialStatusByDeviceID[deviceID] == fingerprint else {
                throw CodexAccountUsageClient.Failure.authenticationRejected
            }
            return try await checkSavedCredentialOnDevice(credential, deviceID: deviceID, renew: false)
        }
    }

    private func checkSavedCredentialOnDevice(
        _ credential: SavedCodexCredential,
        deviceID: String,
        renew: Bool
    ) async throws -> CodexCredentialCheckResult {
        let result = try await requestCredentialOperation("check", credential: credential, deviceID: deviceID, renew: renew)
        return CodexCredentialCheckResult(
            usage: result["usage"]?.objectValue.map(savedCredentialUsageSnapshot(from:)),
            credential: result["credential"]?.stringValue,
            renewalFailed: result["renewalFailed"]?.boolValue == true
        )
    }

    private func savedCredentialUsageSnapshot(from payload: IncomingParamsObject) -> CodexAccountUsageSnapshot {
        CodexAccountUsageSnapshot(
            buckets: savedCredentialRateLimitBuckets(from: payload),
            credits: decodeAccountUsageCredits(from: payload),
            updatedAt: .now
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
