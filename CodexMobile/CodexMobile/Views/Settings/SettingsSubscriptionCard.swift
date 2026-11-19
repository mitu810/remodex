// FILE: SettingsSubscriptionCard.swift
// Purpose: Presents Remodex Pro subscription status and purchase actions.
// Layer: Settings UI component
// Exports: SettingsSubscriptionCard
// Depends on: SwiftUI, StoreKit, SubscriptionService, RevenueCatPaywallView

import StoreKit
import SwiftUI

struct SettingsSubscriptionCard: View {
    @Environment(SubscriptionService.self) private var subscriptions
    let onShowPaywall: () -> Void
    let onRedeemCode: () -> Void

    var body: some View {
        SettingsCard(
            title: "Remodex Pro",
            footer: subscriptions.hasProAccess
                ? String(localized: "Manage billing through your Apple ID subscription settings.")
                : "Unlock voice mode, unlimited threads, and more."
        ) {
            SettingsValueRow(
                title: String(localized: "Plan"),
                value: subscriptions.hasProAccess ? String(localized: "Active") : String(localized: "Free"),
                valueColor: subscriptions.hasProAccess ? .green : .secondary
            )

            SettingsButton(subscriptions.hasProAccess ? String(localized: "View Pro Benefits") : String(localized: "Upgrade to Pro")) {
                onShowPaywall()
            }

            SettingsButton(String(localized: "Redeem Code")) {
                onRedeemCode()
            }
            .disabled(subscriptions.isPurchasing || subscriptions.isRestoring)

            SettingsButton(
                subscriptions.isRestoring ? String(localized: "Restoring…") : String(localized: "Restore Purchases"),
                isLoading: subscriptions.isRestoring
            ) {
                Task {
                    await subscriptions.restorePurchases()
                }
            }
            .disabled(subscriptions.isPurchasing)

            if let error = subscriptions.lastErrorMessage, !error.isEmpty {
                SettingsInlineMessage(text: error, tint: .red)
            }
        }
        .task {
            guard subscriptions.bootstrapState == .idle else {
                return
            }
            await subscriptions.bootstrap()
        }
    }
}
