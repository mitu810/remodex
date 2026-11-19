// FILE: SettingsView.swift
// Purpose: Settings for Local Mode (Codex runs on the paired computer, relay WebSocket).
// Layer: View
// Exports: SettingsView

import SwiftUI
import StoreKit
import UIKit

private struct SettingsComputerNamePresentation: Identifiable, Equatable {
    let deviceId: String?
    let currentName: String
    let systemName: String

    var id: String { deviceId ?? currentName }
}

private enum SettingsSheet: Identifiable, Equatable {
    case computerName(SettingsComputerNamePresentation)
    case commandReference
    case macLoginInfo
    case paywall

    var id: String {
        switch self {
        case .computerName(let presentation):
            return "computerName-\(presentation.id)"
        case .commandReference:
            return "commandReference"
        case .macLoginInfo:
            return "macLoginInfo"
        case .paywall:
            return "paywall"
        }
    }
}

// One active presentation at a time so sheets and offer-code redemption
// never compete while Settings is already inside a full-screen cover.
private enum SettingsActivePresentation: Equatable {
    case none
    case sheet(SettingsSheet)
    case offerCodeRedemption
}

struct SettingsView: View {
    var connectCredentialDevice: ((String) async throws -> Void)? = nil
    @Environment(CodexService.self) private var codex
    @Environment(SubscriptionService.self) private var subscriptions
    @AppStorage("codex.appFontStyle") private var appFontStyleRawValue = AppFont.defaultStoredStyleRawValue
    @State private var activePresentation: SettingsActivePresentation = .none
    @State private var isShowingAboutRemodex = false

    var body: some View {
        List {
            SettingsAppearanceCard(appFontStyle: appFontStyleBinding)
            SettingsHistoryCard()
            SettingsNotificationsCard()
            SettingsRuntimeDefaultsCard()
            SettingsBridgeVersionCard {
                presentSettingsSheet(.commandReference)
            }
            if subscriptions.isBillingEnabled {
                SettingsSubscriptionCard(
                    onShowPaywall: {
                        presentSettingsSheet(.paywall)
                    },
                    onRedeemCode: {
                        presentOfferCodeRedemption()
                    }
                )
            }
            SettingsUsageCard(connectCredentialDevice: connectCredentialDevice)
            SettingsGPTAccountCard {
                presentSettingsSheet(.macLoginInfo)
            }
            SettingsArchivedChatsCard()
            SettingsAboutCard {
                showAboutRemodex()
            }
            SettingsConnectionCard {
                presentComputerNameSheet()
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(10)
        .font(AppFont.body())
        .tint(.primary)
        .navigationTitle("Settings")
        // Keep the About push anchored to SettingsView so custom List rows do
        // not depend on NavigationLink behavior inside rebuilt sections.
        .navigationDestination(isPresented: $isShowingAboutRemodex) {
            AboutRemodexView()
        }
        .sheet(item: activeSheetBinding) { sheet in
            settingsSheetContent(for: sheet)
        }
        .offerCodeRedemption(isPresented: isPresentingOfferCodeRedemption) { result in
            handleOfferCodeRedemptionCompletion(result)
        }
    }

    private var activeSheetBinding: Binding<SettingsSheet?> {
        Binding(
            get: {
                if case .sheet(let sheet) = activePresentation {
                    return sheet
                }
                return nil
            },
            set: { newSheet in
                if let newSheet {
                    activePresentation = .sheet(newSheet)
                } else if case .sheet = activePresentation {
                    activePresentation = .none
                }
            }
        )
    }

    private var isPresentingOfferCodeRedemption: Binding<Bool> {
        Binding(
            get: {
                if case .offerCodeRedemption = activePresentation {
                    return true
                }
                return false
            },
            set: { isPresented in
                if isPresented {
                    activePresentation = .offerCodeRedemption
                } else if case .offerCodeRedemption = activePresentation {
                    activePresentation = .none
                }
            }
        )
    }

    @ViewBuilder
    private func settingsSheetContent(for sheet: SettingsSheet) -> some View {
        switch sheet {
        case .computerName(let presentation):
            SettingsComputerNameSheet(
                nickname: sidebarComputerNicknameBinding(for: presentation.deviceId),
                currentName: presentation.currentName,
                systemName: presentation.systemName
            )
        case .commandReference:
            SettingsCommandReferenceSheet()
        case .macLoginInfo:
            GPTVoiceSetupSheet()
        case .paywall:
            RevenueCatPaywallView()
        }
    }

    private func handleOfferCodeRedemptionCompletion(_ result: Result<Void, Error>) {
        Task {
            if case .failure = result {
                await subscriptions.refreshCustomerInfoSilently()
            } else {
                await subscriptions.syncPurchasesAfterOfferCodeRedemption()
            }
        }
    }

    private func showAboutRemodex() {
        isShowingAboutRemodex = true
    }

    private func presentSettingsSheet(_ sheet: SettingsSheet) {
        activePresentation = .sheet(sheet)
    }

    private func presentOfferCodeRedemption() {
        switch activePresentation {
        case .none:
            activePresentation = .offerCodeRedemption
        case .sheet:
            activePresentation = .none
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(350))
                guard activePresentation == .none else { return }
                activePresentation = .offerCodeRedemption
            }
        case .offerCodeRedemption:
            break
        }
    }

    private var appFontStyleBinding: Binding<AppFont.Style> {
        Binding(
            get: { AppFont.Style(rawValue: appFontStyleRawValue) ?? AppFont.defaultStyle },
            set: { appFontStyleRawValue = $0.rawValue }
        )
    }

    // Captures the visible device details before presenting so reconnect updates cannot dismiss the editor.
    private func presentComputerNameSheet() {
        guard let trustedPairPresentation = codex.trustedPairPresentation else {
            return
        }

        presentSettingsSheet(
            .computerName(
                SettingsComputerNamePresentation(
                    deviceId: trustedPairPresentation.deviceId,
                    currentName: trustedPairPresentation.name,
                    systemName: trustedPairPresentation.systemName ?? trustedPairPresentation.name
                )
            )
        )
    }

    // Writes nicknames against the tapped trusted computer so switching pairs does not reuse the wrong alias.
    private func sidebarComputerNicknameBinding(for deviceId: String?) -> Binding<String> {
        Binding(
            get: { SidebarComputerNicknameStore.nickname(for: deviceId) },
            set: { SidebarComputerNicknameStore.setNickname($0, for: deviceId) }
        )
    }
}

private struct SettingsHistoryCard: View {
    @AppStorage(ThreadHistoryPageSize.storageKey) private var pageSize = ThreadHistoryPageSize.defaultValue

    var body: some View {
        SettingsCard(
            title: String(localized: "Chat History"),
            footer: String(localized: "Pull down at the top of a chat to load earlier messages. Each load reveals cached messages first, or requests older turns from your paired device.")
        ) {
            Picker("Load Size", selection: $pageSize) {
                ForEach(ThreadHistoryPageSize.allCases, id: \.self) { size in
                    Text("\(size.messageCount) messages / \(size.turnCount) turns")
                        .tag(size)
                }
            }
            .pickerStyle(.menu)
        }
    }
}

private struct SettingsUsageCard: View {
    let connectCredentialDevice: ((String) async throws -> Void)?
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    @State private var isRefreshing = false

    var body: some View {
        SettingsCard(
            title: String(localized: "Usage"),
            footer: String(localized: "Account-wide rate limits from your paired device.")
        ) {
            NavigationLink {
                SettingsCodexCredentialsView(connectDevice: connectCredentialDevice)
            } label: {
                SettingsLinkRow(title: String(localized: "Codex Accounts"), showsDisclosure: false) {
                    RemodexIcon.image(systemName: "person.crop.circle")
                }
            }

            UsageStatusSummaryContent(
                contextWindowUsage: nil,
                showsContextWindowSection: false,
                rateLimitBuckets: codex.rateLimitBuckets,
                isLoadingRateLimits: codex.isLoadingRateLimits,
                rateLimitsErrorMessage: codex.rateLimitsErrorMessage,
                showsRateLimitHeader: false,
                refreshControl: UsageStatusRefreshControl(
                    title: String(localized: "Refresh"),
                    isRefreshing: isRefreshing,
                    action: refreshStatus
                )
            )
        }
        .task {
            await refreshStatusIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await refreshStatusIfNeeded()
            }
        }
    }

    private func refreshStatus() {
        guard !isRefreshing else { return }
        HapticFeedback.shared.triggerImpactFeedback(style: .light)
        isRefreshing = true

        Task {
            await refreshStatusData()
            await MainActor.run {
                isRefreshing = false
            }
        }
    }

    private func refreshStatusIfNeeded() async {
        guard !isRefreshing else { return }
        guard codex.shouldAutoRefreshUsageStatus(threadId: nil) else { return }

        await MainActor.run {
            isRefreshing = true
        }
        await refreshStatusData()
        await MainActor.run {
            isRefreshing = false
        }
    }

    // Settings only needs the account-wide usage windows.
    private func refreshStatusData() async {
        await codex.refreshUsageStatus(threadId: nil)
    }
}

private struct SettingsAppearanceCard: View {
    @Binding var appFontStyle: AppFont.Style
    @AppStorage(GlassPreference.storageKey) private var useLiquidGlass = true
    @AppStorage(UserBubbleColor.storageKey) private var userBubbleColorRawValue = UserBubbleColor.defaultStoredRawValue
    private let settingsAccentColor = Color.primary

    var body: some View {
        SettingsCard(title: String(localized: "Appearance")) {
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                SettingsLinkRow(
                    title: String(localized: "Language"),
                    subtitle: String(localized: "Choose English or Simplified Chinese in iOS Settings."),
                    showsDisclosure: false
                ) {
                    RemodexIcon.image(systemName: "globe")
                }
            }
            .buttonStyle(.plain)

            SettingsMenuPickerRow(
                title: String(localized: "Font"),
                value: appFontStyle.title,
                options: AppFont.Style.allCases.map { style in
                    SettingsMenuPickerOption(value: style, title: style.title)
                },
                selection: $appFontStyle
            )

            HStack {
                Text("Message Bubble")
                UIKitMenuButton {
                    HStack {
                        Spacer()
                        Circle()
                            .fill(selectedUserBubbleColor.swatchColor)
                            .frame(width: 14, height: 14)
                    }
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .trailing)
                    .contentShape(Rectangle())
                } menu: {
                    UIMenu(
                        options: [.singleSelection],
                        children: UserBubbleColor.allCases.map { color in
                            UIAction(
                                title: color.title,
                                image: color.menuSwatchImage,
                                state: color == selectedUserBubbleColor ? .on : .off
                            ) { _ in
                                userBubbleColorRawValue = color.rawValue
                            }
                        }
                    )
                }
                .accessibilityLabel("Message Bubble color")
                .accessibilityValue(selectedUserBubbleColor.title)
                .tint(settingsAccentColor)
            }

            if GlassPreference.isSupported {
                Toggle("Liquid Glass", isOn: $useLiquidGlass)
                    .tint(settingsToggleTintColor)
            }

            SettingsPetCompanionSection(settingsAccentColor: settingsAccentColor)
        }
    }

    private var selectedUserBubbleColor: UserBubbleColor {
        UserBubbleColor(rawValue: userBubbleColorRawValue) ?? .default
    }
}

private struct SettingsPetCompanionSection: View {
    @Environment(CodexService.self) private var codex
    @Environment(PetCompanionStore.self) private var petStore

    let settingsAccentColor: Color

    var body: some View {
        Group {
            Toggle(isOn: petEnabledBinding) {
                HStack(spacing: 8) {
                    Text("Companion Pet")
                    Text("BETA")
                        .font(AppFont.caption2(weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(settingsAccentColor)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(settingsAccentColor.opacity(0.15))
                        )
                }
            }
            .tint(settingsToggleTintColor)

            if petStore.isEnabled {
                if petStore.availablePets.isEmpty {
                    SettingsInlineMessage(
                        text: petStore.isLoading
                            ? String(localized: "Loading pets from your device…")
                            : "No local pets found in ~/.codex/pets."
                    )
                } else {
                    SettingsMenuPickerRow(
                        title: String(localized: "Pet"),
                        value: petStore.selectedPet?.displayName ?? String(localized: "None"),
                        options: petStore.availablePets.map { pet in
                            SettingsMenuPickerOption(value: pet.id, title: pet.displayName)
                        },
                        selection: selectedPetBinding
                    )
                }

                if let errorMessage = petStore.errorMessage {
                    SettingsInlineMessage(text: errorMessage, tint: .red)
                }

                SettingsButton(String(localized: "Refresh Pets"), isLoading: petStore.isLoading) {
                    HapticFeedback.shared.triggerImpactFeedback(style: .light)
                    Task {
                        await petStore.refreshPets(codex: codex)
                    }
                }
            }
        }
        .task(id: codex.isConnected) {
            guard codex.isConnected, petStore.isEnabled else {
                return
            }
            await petStore.loadPetsIfNeeded(codex: codex)
            await petStore.loadSelectedPet(codex: codex)
        }
    }

    private var petEnabledBinding: Binding<Bool> {
        Binding(
            get: { petStore.isEnabled },
            set: { isEnabled in
                petStore.setEnabled(isEnabled)
                guard isEnabled else {
                    return
                }
                Task {
                    await petStore.loadPetsIfNeeded(codex: codex)
                    await petStore.loadSelectedPet(codex: codex)
                }
            }
        )
    }

    private var selectedPetBinding: Binding<String> {
        Binding(
            get: { petStore.selectedPet?.id ?? "" },
            set: { selectedID in
                petStore.selectPet(id: selectedID.isEmpty ? nil : selectedID)
                Task {
                    await petStore.loadSelectedPet(codex: codex)
                }
            }
        )
    }
}

private struct SettingsNotificationsCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsCard(
            title: String(localized: "Notifications"),
            footer: String(localized: "Local alerts work while Remodex can run in the background. Reliable alerts after iOS suspends the app require a configured push service.")
        ) {
            SettingsValueRow(title: String(localized: "Permission"), value: statusLabel)

            if codex.notificationAuthorizationStatus == .notDetermined {
                SettingsButton(String(localized: "Allow Notifications")) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    Task {
                        await codex.requestNotificationPermission()
                    }
                }
            }

            if codex.notificationAuthorizationStatus == .denied {
                SettingsButton(String(localized: "Open iOS Settings")) {
                    HapticFeedback.shared.triggerImpactFeedback()
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
        }
        .task {
            await codex.refreshManagedNotificationRegistrationState()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                return
            }
            Task {
                await codex.refreshManagedNotificationRegistrationState()
            }
        }
    }

    private var statusLabel: String {
        switch codex.notificationAuthorizationStatus {
        case .authorized: String(localized: "Authorized")
        case .denied: String(localized: "Denied")
        case .provisional: String(localized: "Provisional")
        case .ephemeral: String(localized: "Ephemeral")
        case .notDetermined: String(localized: "Not requested")
        @unknown default: String(localized: "Unknown")
        }
    }
}

private struct SettingsGPTAccountCard: View {
    let onShowInfo: () -> Void

    var body: some View {
        SettingsCard(title: String(localized: "Voice")) {
            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onShowInfo()
            } label: {
                SettingsLinkRow(
                    title: String(localized: "ChatGPT Setup"),
                    subtitle: String(localized: "Auth and transcription on your paired computer")
                ) {
                    RemodexIcon.image(systemName: "waveform")
                }
            }
        }
    }
}

private struct SettingsBridgeVersionCard: View {
    @Environment(CodexService.self) private var codex
    @Environment(\.scenePhase) private var scenePhase
    let onShowCommands: () -> Void
    @State private var isUpdatingBridge = false
    @State private var bridgeUpdateMessage: String?
    @State private var bridgeUpdateFailed = false

    var body: some View {
        SettingsCard(
            title: String(localized: "Bridge"),
            footer: guidanceText
        ) {
            SettingsValueRow(
                title: String(localized: "Status"),
                value: versionStatusLabel,
                valueColor: versionStatusColor
            )

            SettingsValueRow(
                title: String(localized: "Installed"),
                value: installedVersionLabel,
                valueColor: installedValueStyle,
                usesMonospacedValue: true
            )

            SettingsValueRow(
                title: String(localized: "Latest"),
                value: latestVersionLabel,
                usesMonospacedValue: true
            )

            if codex.supportsBridgePackageUpdate {
                SettingsButton(bridgeUpdateButtonTitle, isLoading: isUpdatingBridge) {
                    Task {
                        await updateBridgeFromSettings()
                    }
                }
                .disabled(!codex.isConnected || isUpdatingBridge)
            }

            Link(destination: RemodexBridgeRelease.url) {
                SettingsLinkRow(
                    title: String(localized: "Open GitHub Releases"),
                    subtitle: String(localized: "Download the bridge update package and script")
                ) {
                    RemodexIcon.image(systemName: "arrow.down.circle")
                }
            }

            Button {
                HapticFeedback.shared.triggerImpactFeedback(style: .light)
                onShowCommands()
            } label: {
                SettingsLinkRow(
                    title: String(localized: "Terminal Commands"),
                    subtitle: String(localized: "Start, repair, or inspect the bridge on your \(codex.hostComputerLabel)")
                ) {
                    RemodexIcon.image(systemName: "terminal")
                }
            }

            if let bridgeUpdateMessage {
                SettingsInlineMessage(
                    text: bridgeUpdateMessage,
                    tint: bridgeUpdateFailed ? .orange : .secondary
                )
            }
        }
        .task {
            await codex.refreshBridgeVersionState()
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await codex.refreshBridgeVersionState()
            }
        }
    }

    private var installedVersionLabel: String {
        normalizedVersion(codex.bridgeInstalledVersion) ?? String(localized: "Unknown")
    }

    private var latestVersionLabel: String {
        normalizedVersion(codex.latestBridgePackageVersion) ?? String(localized: "Unknown")
    }

    private var guidanceText: String? {
        guard let installedVersion else {
            return String(localized: "Connect to your paired device to read the installed bridge version.")
        }

        guard let latestVersion else {
            return nil
        }

        if installedVersion == latestVersion {
            return String(localized: "Your bridge matches the latest published package.")
        }

        if installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending {
            return String(localized: "A newer Remodex package is available.")
        }

        return String(localized: "This bridge is newer than the latest GitHub release.")
    }

    private var versionStatusColor: Color {
        guard let installedVersion,
              let latestVersion,
              installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending else {
            return .secondary
        }

        return .orange
    }

    private var versionStatusLabel: String {
        guard let installedVersion else {
            return String(localized: "Unknown")
        }

        guard let latestVersion else {
            return String(localized: "Installed")
        }

        if installedVersion == latestVersion {
            return String(localized: "Up to date")
        }

        if installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending {
            return String(localized: "Update available")
        }

        return String(localized: "Different build")
    }

    private var bridgeUpdateButtonTitle: String {
        if let installedVersion,
           let latestVersion,
           installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending {
            return String(localized: "Update Bridge on Device")
        }

        return String(localized: "Reinstall Bridge on Device")
    }

    private var installedValueStyle: Color {
        guard let installedVersion,
              let latestVersion,
              installedVersion.compare(latestVersion, options: .numeric) == .orderedAscending else {
            return .primary
        }

        return .orange
    }

    private var installedVersion: String? {
        normalizedVersion(codex.bridgeInstalledVersion)
    }

    private var latestVersion: String? {
        normalizedVersion(codex.latestBridgePackageVersion)
    }

    private func updateBridgeFromSettings() async {
        guard codex.isConnected else {
            bridgeUpdateFailed = true
            bridgeUpdateMessage = String(localized: "Connect to your paired device first.")
            return
        }

        guard !isUpdatingBridge else {
            return
        }

        isUpdatingBridge = true
        bridgeUpdateMessage = nil
        bridgeUpdateFailed = false

        do {
            let handoffService = DesktopHandoffService(codex: codex)
            try await handoffService.updateBridgePackageAndRestart()
            bridgeUpdateFailed = false
            bridgeUpdateMessage = String(localized: "Bridge update scheduled. Reconnecting after restart...")
        } catch {
            bridgeUpdateFailed = true
            bridgeUpdateMessage = error.localizedDescription
        }

        isUpdatingBridge = false
    }

    private func normalizedVersion(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }
}

private struct SettingsArchivedChatsCard: View {
    @Environment(CodexService.self) private var codex

    private var archivedCount: Int {
        codex.threads.filter { $0.syncState == .archivedLocal }.count
    }

    var body: some View {
        SettingsCard(title: String(localized: "Archived")) {
            NavigationLink {
                ArchivedChatsView()
            } label: {
                SettingsLinkRow(
                    title: String(localized: "Archived Chats"),
                    subtitle: archivedCount > 0 ? String(localized: "\(archivedCount) saved locally") : nil,
                    showsDisclosure: false
                ) {
                    RemodexIcon.image(systemName: "archivebox")
                }
            }
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView()
            .environment(CodexService())
    }
}
