// Purpose: Manages the iPhone's Codex credentials and applies one to a chosen paired device.

import SwiftUI
import UniformTypeIdentifiers

struct SettingsCodexCredentialsView: View {
    @Environment(CodexService.self) private var codex
    let connectDevice: ((String) async throws -> Void)?
    @State private var profiles: [SavedCodexCredential] = []
    @State private var isImporting = false
    @State private var notice: String?

    var body: some View {
        List {
            Section {
                if profiles.isEmpty {
                    Text("No saved Codex accounts")
                        .foregroundStyle(.secondary)
                }
                ForEach(profiles) { profile in
                    NavigationLink {
                        CodexCredentialDetailView(id: profile.id, profiles: $profiles, connectDevice: connectDevice)
                    } label: {
                        SettingsLinkRow(title: profile.title, subtitle: profile.plan?.capitalized, showsDisclosure: false) {
                            RemodexIcon.image(systemName: "person.crop.circle")
                        }
                    }
                }
                if let notice {
                    SettingsInlineMessage(text: notice)
                }
            } footer: {
                Text("Save Codex ChatGPT credentials on this iPhone and choose a paired device when applying an account.")
            }
        }
        .font(AppFont.body())
        .navigationTitle("Codex Accounts")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    isImporting = true
                } label: {
                    RemodexIcon.image(systemName: "plus")
                }
                .accessibilityLabel("Import Codex credentials")
            }
        }
        .fileImporter(isPresented: $isImporting, allowedContentTypes: [.json], allowsMultipleSelection: true) { result in
            importCredentials(result)
        }
        .task(id: codex.savedCredentialVaultRevision) {
            do { profiles = try CodexCredentialVault.load() }
            catch { notice = String(localized: "Could not read the saved credentials from Keychain.") }
        }
    }

    private func importCredentials(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            let imported = urls.compactMap { try? CodexCredentialVault.readImport($0) }
            guard !imported.isEmpty else {
                notice = String(localized: "Select a Codex ChatGPT auth.json file.")
                return
            }
            profiles = try CodexCredentialVault.update { profiles in
                for profile in imported {
                    try CodexCredentialVault.mergeImported(profile, into: &profiles)
                }
            }
            let failed = urls.count - imported.count
            notice = failed == 0 ? nil : String(localized: "Could not import \(failed) selected files.")
        } catch {
            notice = String(localized: "Could not save the credentials in Keychain.")
        }
    }
}

private struct CodexCredentialDetailView: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @Binding var profiles: [SavedCodexCredential]
    let connectDevice: ((String) async throws -> Void)?

    @State private var editedName = ""
    @State private var isConfirmingDeletion = false
    @State private var notice: String?
    @State private var usageError: String?

    private var profile: SavedCodexCredential? { profiles.first { $0.id == id } }
    private var isChecking: Bool { codex.checkingSavedCredentialID == id }
    private var canCheck: Bool {
        codex.checkingSavedCredentialID == nil && !codex.isApplyingVaultCredential
    }
    private var deviceID: String? { codex.isConnected ? codex.secureSession?.macDeviceId : nil }

    var body: some View {
        List {
            if let profile {
                SettingsCard(title: String(localized: "Account")) {
                    if let email = profile.email {
                        SettingsValueRow(title: String(localized: "Email"), value: email)
                    }
                    if let plan = profile.plan {
                        SettingsValueRow(title: String(localized: "Plan"), value: plan.capitalized)
                    }
                    if let expiry = profile.effectiveAccessExpiry {
                        SettingsValueRow(title: String(localized: "Credential Expires"),
                                         value: expiry.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let refreshed = profile.refreshedAt {
                        SettingsValueRow(title: String(localized: "Last Credential Renewal"),
                                         value: refreshed.formatted(date: .abbreviated, time: .shortened))
                    }
                    TextField("Account name", text: $editedName)
                        .textInputAutocapitalization(.sentences)
                    SettingsButton(String(localized: "Save Name")) { saveName() }
                        .disabled(isChecking || editedName == profile.name)
                }

                SettingsCard(
                    title: String(localized: "Usage"),
                    footer: String(localized: "Credentials renew automatically near expiry while Remodex is active and connected to a paired device.")
                ) {
                    if let usage = profile.usageSnapshot {
                        UsageStatusSummaryContent(
                            contextWindowUsage: nil,
                            showsContextWindowSection: false,
                            rateLimitBuckets: usage.buckets,
                            isLoadingRateLimits: false,
                            rateLimitsErrorMessage: nil,
                            showsRateLimitHeader: false,
                            refreshControl: nil
                        )
                        if let credits = usage.credits {
                            SettingsValueRow(title: String(localized: "Credit balance"), value: credits.displayBalance)
                        }
                        SettingsValueRow(title: String(localized: "Usage Updated"),
                                         value: usage.updatedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let usageError {
                        SettingsInlineMessage(text: usageError, tint: .orange)
                    }
                    if let failure = codex.savedCredentialRenewalFailures[id] {
                        SettingsInlineMessage(text: failure, tint: .orange)
                    }
                    SettingsButton(String(localized: "Refresh Usage"), isLoading: isChecking) {
                        Task { await check(renew: false) }
                    }
                    .disabled(!canCheck)
                    SettingsButton(String(localized: "Renew Credential")) {
                        Task { await check(renew: true) }
                    }
                    .disabled(!canCheck || deviceID == nil)
                }

                Section {
                    NavigationLink("Apply to Device") {
                        CodexCredentialDevicePicker(profile: profile, connectDevice: connectDevice)
                    }
                    .disabled(isChecking || connectDevice == nil)
                    if let notice {
                        SettingsInlineMessage(text: notice)
                    }
                }

                Section {
                    SettingsButton(String(localized: "Delete Saved Credential"), role: .destructive) {
                        isConfirmingDeletion = true
                    }
                    .disabled(isChecking)
                }
            }
        }
        .font(AppFont.body())
        .navigationTitle(profile?.title ?? String(localized: "Codex Accounts"))
        .onAppear { editedName = profile?.name ?? "" }
        .task(id: id) {
            guard Date().timeIntervalSince(profile?.usageSnapshot?.updatedAt ?? .distantPast) >= 300 else { return }
            if let pending = codex.savedCredentialCheckTask { _ = try? await pending.value }
            guard !Task.isCancelled else { return }
            await check(renew: false)
        }
        .confirmationDialog("Delete saved credential?", isPresented: $isConfirmingDeletion, titleVisibility: .visible) {
            Button("Delete", role: .destructive, action: deleteCredential)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the saved copy from this iPhone. Devices keep their current login.")
        }
    }

    private func saveName() {
        do {
            profiles = try CodexCredentialVault.update { profiles in
                guard let index = profiles.firstIndex(where: { $0.id == id }) else { return }
                profiles[index].name = String(editedName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
            }
            editedName = profile?.name ?? ""
            notice = nil
        } catch {
            notice = String(localized: "Could not save the credentials in Keychain.")
        }
    }

    private func deleteCredential() {
        do {
            profiles = try CodexCredentialVault.update { $0.removeAll { $0.id == id } }
            dismiss()
        } catch {
            notice = String(localized: "Could not save the credentials in Keychain.")
        }
    }

    private func check(renew: Bool) async {
        guard canCheck, !renew || deviceID != nil else { return }
        usageError = nil
        do {
            try await codex.refreshSavedCredential(id: id, renewingOn: renew ? deviceID : nil)
            if renew { codex.savedCredentialRenewalFailures.removeValue(forKey: id) }
        } catch {
            if !Task.isCancelled { usageError = CodexCredentialVault.displayMessage(for: error) }
        }
    }
}

private struct CodexCredentialDevicePicker: View {
    @Environment(CodexService.self) private var codex
    let profile: SavedCodexCredential
    let connectDevice: ((String) async throws -> Void)?
    @State private var selected: MyDeviceRowModel?
    @State private var isConfirming = false
    @State private var isApplying = false
    @State private var notice: String?

    var body: some View {
        List {
            Section {
                let devices = MyDevicesPresentation.rowModels(from: codex, switchingDeviceId: nil)
                if devices.isEmpty {
                    Text("Pair a device before applying a credential.")
                        .foregroundStyle(.secondary)
                }
                ForEach(devices) { device in
                    Button {
                        selected = device
                        isConfirming = true
                    } label: {
                        SettingsLinkRow(title: device.primaryName, subtitle: device.credentialLabel, showsDisclosure: false) {
                            RemodexIcon.image(systemName: "desktopcomputer")
                        }
                    }
                    .disabled(isApplying)
                }
                if isApplying { ProgressView() }
                if let notice { SettingsInlineMessage(text: notice) }
            }
        }
        .font(AppFont.body())
        .navigationTitle("Apply to Device")
        .confirmationDialog(
            "Replace this device’s Codex credential?",
            isPresented: $isConfirming,
            titleVisibility: .visible,
            presenting: selected
        ) { device in
            Button("Apply Credential") { apply(to: device) }
            Button("Cancel", role: .cancel) {}
        } message: { device in
            Text("Remodex will back up the current credential on \(device.primaryName), then restart the bridge and Codex.")
        }
    }

    private func apply(to device: MyDeviceRowModel) {
        guard let connectDevice, !isApplying else { return }
        isApplying = true
        notice = nil
        Task { @MainActor in
            defer { isApplying = false }
            do {
                try await connectDevice(device.deviceId)
                let result = try await codex.applySavedCredential(profile, deviceID: device.deviceId) {
                    notice = String(localized: "Credential saved. Restarting and reconnecting…")
                }
                switch result {
                case .alreadyActive:
                    notice = String(localized: "This device already uses the selected account.")
                case .restarted(let desktopRestartFailed):
                    notice = desktopRestartFailed
                        ? String(localized: "The bridge confirmed the selected account, but the desktop app could not restart.")
                        : String(localized: "Device reconnected and confirmed the selected account.")
                case .differentAccount:
                    notice = String(localized: "Device reconnected, but Codex did not load the selected account.")
                case .awaitingVerification:
                    notice = String(localized: "Credential saved. Waiting for the device to confirm the new account.")
                }
            } catch is CancellationError {
                notice = String(localized: "The selected device connection changed. Check the device and try again.")
            } catch {
                notice = CodexCredentialVault.displayMessage(for: error)
            }
        }
    }
}
