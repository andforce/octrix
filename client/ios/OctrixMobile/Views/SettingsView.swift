import SwiftUI
import UIKit

/// 账号与设备配置：授权中心管理账号设备，iPhone 登录后自动同步全部授权 Mac。
struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let isOnboarding: Bool

    @State private var showLogin = false
    @State private var showMacSetupGuide = false
    @State private var isSyncingAccountDevices = false
    @State private var accountDeviceSyncError: String?
    @State private var deepSeekAPIKey = ""
    @State private var hasSavedDeepSeekAPIKey = false
    @State private var deepSeekAPIKeyPreview = ""
    @State private var isEditingDeepSeekAPIKey = false
    @State private var isDeepSeekAPIKeyVerified = false
    @State private var isValidatingDeepSeekAPIKey = false
    @State private var selectedDeepSeekModel = DeepSeekVoiceModel.v4Flash
    @State private var availableDeepSeekModels: [DeepSeekVoiceModel] = []
    @State private var isDeepSeekModelExpanded = false
    @State private var deepSeekSettingsMessage: String?
    @State private var showClearDeepSeekAPIKeyConfirmation = false
    @State private var showLogoutConfirmation = false
    @State private var isLoggingOut = false
    @State private var logoutWarning: String?
    @State private var deviceRemovalAlert: DeviceRemovalAlert?
    @State private var deletingServerId: String?

    var body: some View {
        Group {
            if isOnboarding && !store.settings.isAuthenticated {
                OctrixCloudLoginView(isInitial: true)
            } else {
                settingsForm
            }
        }
    }

    private var settingsForm: some View {
        Form {
            Section {
                AccountSettingsRow(
                    accountLabel: accountLabel,
                    authorizationCenter: authorizationCenterHost,
                    isAuthenticated: store.settings.isAuthenticated,
                    deviceCount: store.settings.servers.count,
                    isSyncingDevices: isSyncingAccountDevices
                )

                if !store.settings.isAuthenticated {
                    Button {
                        showLogin = true
                    } label: {
                        Label("登录 Octrix", systemImage: "person.crop.circle")
                    }
                }

                if store.settings.isAuthenticated, !store.settings.servers.isEmpty {
                    Button {
                        store.connectIfConfigured(force: true)
                        Task { await store.refreshState() }
                    } label: {
                        Label("重新连接全部设备", systemImage: "arrow.clockwise")
                    }
                }

                if let accountDeviceSyncError {
                    Label(accountDeviceSyncError, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)

                    Button("重试同步") {
                        Task { await syncAccountDevices() }
                    }
                    .disabled(isSyncingAccountDevices)
                }
            } header: {
                Text("Octrix 账号")
            } footer: {
                Text(store.settings.isAuthenticated
                    ? "账号下的全部 Mac 会自动同步到这里，无需逐台选择或单独配对。"
                    : "登录后，iPhone 会自动获得这个账号下全部授权 Mac 的访问权限。")
            }

            if store.settings.servers.isEmpty {
                Section("我的 Mac") {
                    ContentUnavailableView(
                        isSyncingAccountDevices ? "正在同步 Mac" : "账号下还没有 Mac",
                        systemImage: "desktopcomputer",
                        description: Text("请先在 Mac 端登录同一个 Octrix 账号，设备会自动出现在这里。"),
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                Section {
                    ForEach(store.settings.servers) { config in
                        DeviceSettingsRow(
                            config: config,
                            connection: store.connectionState(serverId: config.id),
                            errorMessage: store.lastErrorMessage(serverId: config.id),
                            isDeleting: deletingServerId == config.id,
                            onReconnect: {
                                store.connect(serverId: config.id, force: true)
                                Task { await store.refreshState(serverId: config.id) }
                            },
                            onDelete: {
                                deviceRemovalAlert = .confirmation(config)
                            }
                        )
                        .contextMenu {
                            Button {
                                store.connect(serverId: config.id, force: true)
                                Task { await store.refreshState(serverId: config.id) }
                            } label: {
                                Label("重新连接", systemImage: "arrow.clockwise")
                            }

                            Button(role: .destructive) {
                                deviceRemovalAlert = .confirmation(config)
                            } label: {
                                Label("删除设备", systemImage: "trash")
                            }
                            .disabled(deletingServerId == config.id)
                        }
                    }
                } header: {
                    HStack(spacing: 8) {
                        Text("我的 Mac")
                        if isSyncingAccountDevices {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                } footer: {
                    Text("列表来自 Octrix 账号；授权中心的设备变化会自动同步到这台 iPhone。")
                }
            }

            Section {
                Button {
                    showMacSetupGuide = true
                } label: {
                    Label("连接一台 Mac", systemImage: "laptopcomputer.and.iphone")
                }

                Link(destination: authorizationCenterURL) {
                    Label("打开网页授权中心", systemImage: "safari")
                }
            } header: {
                Text("使用帮助")
            } footer: {
                Text("首次使用只需要：在 Mac 安装后台 Octrix Host、登录同一个账号，然后回到这里。不需要 DMG 或服务器地址。")
            }

            Section {
                if hasSavedDeepSeekAPIKey, !isEditingDeepSeekAPIKey {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("API Key")
                                .foregroundStyle(.primary)
                            Text(deepSeekAPIKeyPreview)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }

                        Spacer()

                        if isValidatingDeepSeekAPIKey {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("正在验证 DeepSeek Key")
                        } else {
                            Label(
                                isDeepSeekAPIKeyVerified ? "已验证" : "待验证",
                                systemImage: isDeepSeekAPIKeyVerified
                                    ? "checkmark.circle.fill"
                                    : "exclamationmark.circle.fill"
                            )
                            .font(.subheadline)
                            .foregroundStyle(isDeepSeekAPIKeyVerified ? Color.green : Color.orange)
                        }

                        Menu {
                            Button {
                                beginEditingDeepSeekAPIKey()
                            } label: {
                                Label("更换 API Key", systemImage: "pencil")
                            }

                            Divider()

                            Button(role: .destructive) {
                                showClearDeepSeekAPIKeyConfirmation = true
                            } label: {
                                Label("移除 API Key", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("管理 DeepSeek API Key")
                        .disabled(isValidatingDeepSeekAPIKey)
                    }
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }

                    if !isDeepSeekAPIKeyVerified {
                        Button {
                            Task { await validateAndSaveDeepSeekAPIKey(DeepSeekVoicePolishSettings.apiKey) }
                        } label: {
                            Label {
                                validationButtonLabel("验证 API Key")
                            } icon: {
                                Image(systemName: "checkmark.shield")
                            }
                        }
                        .disabled(isValidatingDeepSeekAPIKey)
                    }
                } else {
                    SecureField(hasSavedDeepSeekAPIKey ? "输入新的 DeepSeek API Key" : "DeepSeek API Key", text: $deepSeekAPIKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isValidatingDeepSeekAPIKey)

                    Button {
                        Task { await validateAndSaveDeepSeekAPIKey(deepSeekAPIKey) }
                    } label: {
                        validationButtonLabel("验证并保存")
                    }
                    .disabled(deepSeekAPIKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isValidatingDeepSeekAPIKey)

                    if hasSavedDeepSeekAPIKey {
                        Button("取消") { cancelEditingDeepSeekAPIKey() }
                            .disabled(isValidatingDeepSeekAPIKey)
                    }
                }

                if let deepSeekSettingsMessage {
                    Text(deepSeekSettingsMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("语音输入优化")
            } footer: {
                Text("设置后，语音识别完成会把文本发送到 DeepSeek 进行整理；失败时会静默保留原始识别结果。API Key 只保存在本机。")
            }

            if hasSavedDeepSeekAPIKey && isDeepSeekAPIKeyVerified && !isEditingDeepSeekAPIKey {
                Section {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isDeepSeekModelExpanded.toggle()
                        }
                    } label: {
                        HStack {
                            Text("模型")
                                .foregroundStyle(.primary)
                            Spacer()
                            Text(selectedDeepSeekModel.rawValue)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Image(systemName: isDeepSeekModelExpanded ? "chevron.up" : "chevron.down")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)

                    if isDeepSeekModelExpanded {
                        ForEach(availableDeepSeekModels) { model in
                            Button {
                                selectDeepSeekModel(model)
                            } label: {
                                HStack {
                                    Text(model.rawValue)
                                        .foregroundStyle(model == selectedDeepSeekModel ? Color.accentColor : Color.primary)
                                    Spacer()
                                    if model == selectedDeepSeekModel {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Color.accentColor)
                                    }
                                }
                            }
                        }
                    }
                } header: {
                    Text("DeepSeek 模型")
                }
            }

            if store.settings.isAuthenticated || !store.settings.servers.isEmpty {
                Section {
                    Button(role: .destructive) {
                        showLogoutConfirmation = true
                    } label: {
                        HStack {
                            if isLoggingOut { ProgressView() }
                            Text(isLoggingOut ? "正在退出…" : "退出登录")
                        }
                    }
                    .disabled(isLoggingOut)

                    if store.settings.isAuthenticated {
                        NavigationLink {
                            DeleteAccountView()
                        } label: {
                            Label("删除账号", systemImage: "trash")
                                .foregroundStyle(.red)
                        }
                    }
                } footer: {
                    Text("退出只会撤销这台 iPhone 的访问权限；删除账号会永久删除 Octrix Cloud 中的账号数据并断开所有设备。")
                }
            }
        }
        .navigationTitle("设置")
        .onAppear {
            loadDeepSeekAPIKey()
        }
        .toolbar {
            if !isOnboarding {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .task(id: store.settings.isAuthenticated) {
            if store.settings.isAuthenticated {
                await syncAccountDevices()
            }
        }
        .refreshable {
            if store.settings.isAuthenticated {
                await syncAccountDevices()
            }
        }
        .sheet(isPresented: $showLogin) {
            NavigationStack {
                OctrixCloudLoginView(isInitial: false)
            }
        }
        .sheet(isPresented: $showMacSetupGuide) {
            NavigationStack {
                MacSetupGuideView(presentation: .help) {}
            }
        }
        .alert("移除 DeepSeek API Key？", isPresented: $showClearDeepSeekAPIKeyConfirmation) {
            Button("移除 Key", role: .destructive) {
                clearDeepSeekAPIKey()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("移除后将关闭语音润色和模型选择。你随时可以重新添加。")
        }
        .alert("退出 Octrix？", isPresented: $showLogoutConfirmation) {
            Button("退出登录", role: .destructive) {
                Task { await logout() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这会断开所有连接、清除本机凭证，并撤销当前 iPhone 的云端访问权限。")
        }
        .alert("已从本机退出", isPresented: Binding(
            get: { logoutWarning != nil },
            set: { if !$0 { logoutWarning = nil } },
        )) {
            Button("知道了") {
                logoutWarning = nil
                if !isOnboarding { dismiss() }
            }
        } message: {
            Text(logoutWarning ?? "")
        }
        .alert(item: $deviceRemovalAlert) { alert in
            switch alert {
            case .confirmation(let config):
                Alert(
                    title: Text("删除这台 Mac？"),
                    message: Text("删除「\(config.title)」后，它将从账号设备列表中移除。如需再次使用，必须在 Mac 上重新登录 Octrix。"),
                    primaryButton: .destructive(Text("删除设备")) {
                        Task { await deleteAccountDevice(config) }
                    },
                    secondaryButton: .cancel(Text("取消"))
                )
            case .failure(let message):
                Alert(
                    title: Text("无法删除设备"),
                    message: Text(message),
                    dismissButton: .default(Text("知道了"))
                )
            }
        }
    }

    private func logout() async {
        isLoggingOut = true
        let revokedRemotely = await store.logout()
        isLoggingOut = false
        if revokedRemotely {
            if !isOnboarding { dismiss() }
        } else {
            logoutWarning = "本机凭证已清除，但云端撤销请求未完成。请在网站授权中心撤销这台 iPhone。"
        }
    }

    private var accountLabel: String {
        store.settings.cloudAccount?.accountLabel
            ?? store.settings.servers.compactMap(\.accountLabel).first
            ?? "未登录"
    }

    private var authorizationCenterHost: String {
        if let url = store.settings.cloudAccount?.baseURL {
            var host = url.host ?? url.absoluteString
            if let port = url.port {
                host += ":\(port)"
            }
            return host
        }
        return store.settings.servers.first?.serverHost ?? "未连接授权中心"
    }

    private var authorizationCenterURL: URL {
        OctrixCloudConfiguration.page("dashboard", baseURL: store.settings.cloudAccount?.baseURL)
    }

    private func syncAccountDevices() async {
        guard store.settings.isAuthenticated, !isSyncingAccountDevices else { return }
        isSyncingAccountDevices = true
        accountDeviceSyncError = nil
        defer { isSyncingAccountDevices = false }

        do {
            _ = try await store.syncAccountDevices()
            await store.refreshState()
        } catch {
            accountDeviceSyncError = "设备列表暂时无法同步：\(error.localizedDescription)"
        }
    }

    private func deleteAccountDevice(_ config: RelayServerConfig) async {
        guard deletingServerId == nil else { return }
        deletingServerId = config.id
        defer { deletingServerId = nil }

        do {
            try await store.deleteAccountDevice(serverId: config.id)
        } catch {
            deviceRemovalAlert = .failure(error.localizedDescription)
        }
    }

    private func loadDeepSeekAPIKey() {
        let savedKey = DeepSeekVoicePolishSettings.apiKey
        deepSeekAPIKey = ""
        hasSavedDeepSeekAPIKey = DeepSeekVoicePolishSettings.hasAPIKey
        deepSeekAPIKeyPreview = DeepSeekVoicePolishSettings.maskedAPIKey(savedKey)
        isEditingDeepSeekAPIKey = !hasSavedDeepSeekAPIKey
        isDeepSeekAPIKeyVerified = hasSavedDeepSeekAPIKey && DeepSeekVoicePolishSettings.isVerified
        selectedDeepSeekModel = DeepSeekVoicePolishSettings.selectedModel
        availableDeepSeekModels = isDeepSeekAPIKeyVerified
            ? DeepSeekVoicePolishSettings.availableModels
            : []
    }

    private func clearDeepSeekAPIKey() {
        DeepSeekVoicePolishSettings.clearAPIKey()
        isDeepSeekModelExpanded = false
        loadDeepSeekAPIKey()
        deepSeekSettingsMessage = "DeepSeek Key 已从本机移除"
    }

    private func beginEditingDeepSeekAPIKey() {
        deepSeekAPIKey = ""
        isEditingDeepSeekAPIKey = true
        isDeepSeekModelExpanded = false
        deepSeekSettingsMessage = nil
    }

    private func cancelEditingDeepSeekAPIKey() {
        deepSeekAPIKey = ""
        isEditingDeepSeekAPIKey = false
        deepSeekSettingsMessage = nil
    }

    private func selectDeepSeekModel(_ model: DeepSeekVoiceModel) {
        selectedDeepSeekModel = model
        DeepSeekVoicePolishSettings.selectedModel = model
        deepSeekSettingsMessage = "DeepSeek 模型已切换为 \(model.rawValue)"
    }

    @ViewBuilder
    private func validationButtonLabel(_ title: String) -> some View {
        if isValidatingDeepSeekAPIKey {
            HStack(spacing: 8) {
                ProgressView()
                Text("正在验证…")
            }
        } else {
            Text(title)
        }
    }

    private func validateAndSaveDeepSeekAPIKey(_ rawKey: String) async {
        let trimmed = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isValidatingDeepSeekAPIKey else { return }
        let validatingSavedKey = trimmed == DeepSeekVoicePolishSettings.apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let wasEditingKey = isEditingDeepSeekAPIKey

        isValidatingDeepSeekAPIKey = true
        deepSeekSettingsMessage = nil
        defer { isValidatingDeepSeekAPIKey = false }

        do {
            let models = try await DeepSeekAPIValidator(apiKey: trimmed).validateAvailableModels()
            DeepSeekVoicePolishSettings.saveVerifiedAPIKey(trimmed, availableModels: models)
            isDeepSeekModelExpanded = true
            loadDeepSeekAPIKey()
            deepSeekSettingsMessage = "DeepSeek Key 验证通过"
        } catch {
            if validatingSavedKey {
                DeepSeekVoicePolishSettings.resetVerification()
            }
            isDeepSeekModelExpanded = false
            loadDeepSeekAPIKey()
            isEditingDeepSeekAPIKey = wasEditingKey || !hasSavedDeepSeekAPIKey
            deepSeekAPIKey = trimmed
            deepSeekSettingsMessage = error.localizedDescription
        }
    }
}

private struct AccountSettingsRow: View {
    let accountLabel: String
    let authorizationCenter: String
    let isAuthenticated: Bool
    let deviceCount: Int
    let isSyncingDevices: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.14))
                    .frame(width: 42, height: 42)
                Image(systemName: isAuthenticated ? "person.crop.circle.fill" : "person.crop.circle")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text(accountLabel)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if isAuthenticated {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 6, height: 6)
                        Text("已登录")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Text(accountDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var accountDetail: String {
        guard isAuthenticated else { return "登录后自动同步账号下的全部 Mac" }
        if isSyncingDevices { return "正在从授权中心同步设备…" }
        return "\(authorizationCenter) · \(deviceCount) 台 Mac"
    }
}

private struct DeviceSettingsRow: View {
    let config: RelayServerConfig
    let connection: SocketClient.ConnectionState
    let errorMessage: String?
    let isDeleting: Bool
    let onReconnect: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(ConnectionAppearance.color(connection).opacity(0.14))
                        .frame(width: 42, height: 42)
                    Image(systemName: "desktopcomputer")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(ConnectionAppearance.color(connection))
                }

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(config.title)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Circle()
                            .fill(ConnectionAppearance.color(connection))
                            .frame(width: 6, height: 6)
                        Text(ConnectionAppearance.label(connection))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Text("由 \(config.serverHost) 管理")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(connectionDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let errorMessage, !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    if connection != .connected {
                        Button("重新连接", action: onReconnect)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(isDeleting)
                    }

                    Button(role: .destructive, action: onDelete) {
                        if isDeleting {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityLabel("正在删除\(config.title)")
                        } else {
                            Label("删除设备", systemImage: "trash")
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.red)
                    .disabled(isDeleting)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var connectionDetail: String {
        switch connection {
        case .connected:
            "可远程访问，会话已同步"
        case .connecting:
            "正在通过授权中心连接"
        case .retrying:
            "连接异常，正在自动恢复"
        case .waitingForManualRetry:
            "自动重试已停止，请手动重新连接"
        case .disconnected:
            "当前无法访问这台 Mac"
        }
    }
}

private enum DeviceRemovalAlert: Identifiable {
    case confirmation(RelayServerConfig)
    case failure(String)

    var id: String {
        switch self {
        case .confirmation(let config):
            "confirmation-\(config.id)"
        case .failure:
            "failure"
        }
    }
}
