import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var navigationPath = NavigationPath()
    @State private var presentedStartupPrompt: PresentedAgentStartupPrompt?
    @AppStorage("onboarding.activation.v1.completed") private var hasCompletedActivationGuide = false

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if store.settings.isAuthenticated {
                    GroupListView { route in
                        navigationPath = NavigationPath([route])
                    }
                } else if !hasCompletedActivationGuide {
                    MacSetupGuideView(presentation: .firstRun) {
                        hasCompletedActivationGuide = true
                    }
                } else {
                    SettingsView(isOnboarding: true)
                }
            }
            .navigationDestination(for: ConversationRoute.self) { route in
                ChatView(serverId: route.serverId, groupId: route.groupId) { newRoute in
                    navigationPath = NavigationPath([newRoute])
                }
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await AccountDeviceSyncLoop.run(
                syncDevices: {
                    guard store.settings.isAuthenticated else { return false }
                    do {
                        _ = try await store.syncAccountDevices()
                        return true
                    } catch {
                        return false
                    }
                },
                syncSessions: {
                    store.connectIfConfigured()
                    await store.refreshState()
                    #if DEBUG
                    // 自动化测试钩子：SIMCTL_CHILD_OCTRIX_OPEN_GROUP=<id> simctl launch …
                    if let groupId = ProcessInfo.processInfo.environment["OCTRIX_OPEN_GROUP"], !groupId.isEmpty,
                       let route = store.route(forGroupId: groupId) {
                        navigationPath = NavigationPath([route])
                    }
                    #endif
                }
            )
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await pollAgentStartupPrompts()
        }
        .sheet(item: $presentedStartupPrompt) { presentation in
            AgentStartupPromptSheet(presentation: presentation)
                .environmentObject(store)
                .interactiveDismissDisabled()
                .presentationDetents([.medium, .large])
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                store.disconnectAll(publishState: false)
            default:
                break
            }
        }
        .onOpenURL { url in
            // octrix://group/<groupId> 或 octrix://group/<serverId>/<groupId> 直达指定群聊
            guard url.scheme == "octrix", url.host == "group" else { return }
            let components = url.pathComponents.filter { $0 != "/" }
            if components.count >= 2 {
                navigationPath = NavigationPath([
                    ConversationRoute(serverId: components[0], groupId: components[1])
                ])
                return
            }
            let groupId = url.lastPathComponent
            guard !groupId.isEmpty, groupId != "/", let route = store.route(forGroupId: groupId) else { return }
            navigationPath = NavigationPath([route])
        }
    }

    private func pollAgentStartupPrompts() async {
        while !Task.isCancelled {
            if store.settings.isAuthenticated, presentedStartupPrompt == nil {
                await presentNextAgentStartupPrompt()
            }
            try? await Task.sleep(for: .milliseconds(750))
        }
    }

    private func presentNextAgentStartupPrompt() async {
        for section in store.conversationSections {
            for group in section.activeGroups where !store.runningAgentIds(in: group, serverId: section.id).isEmpty {
                guard let prompt = try? await store.agentStartupPrompts(serverId: section.id, groupId: group.id),
                      let firstPrompt = prompt.first else { continue }
                presentedStartupPrompt = PresentedAgentStartupPrompt(
                    serverId: section.id,
                    serverName: section.config.title,
                    groupName: group.name,
                    prompt: firstPrompt
                )
                return
            }
        }
    }
}

private struct PresentedAgentStartupPrompt: Identifiable {
    let serverId: String
    let serverName: String
    let groupName: String
    let prompt: AgentStartupPrompt

    var id: String { "\(serverId):\(prompt.id)" }
}

private struct AgentStartupPromptSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let presentation: PresentedAgentStartupPrompt

    @State private var isResolving = false
    @State private var isPromptVerified = false
    @State private var errorMessage: String?

    private var isWorkspaceTrust: Bool {
        presentation.prompt.kind == .workspaceTrust
    }

    var body: some View {
        NavigationStack {
            if isPromptVerified {
                VStack(alignment: .leading, spacing: 20) {
                    Label {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Claude Code · Security guide")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(isWorkspaceTrust ? "确认工作目录信任" : "确认权限模式")
                                .font(.title2.bold())
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.shield.fill")
                            .font(.title2)
                            .foregroundStyle(.orange)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text(isWorkspaceTrust ? "Claude Code 正在等待你确认是否信任此目录。确认前，它不会继续进入会话。" : "Claude Code 正在等待你确认以跳过权限提示运行。")
                            .font(.body)
                        Text(presentation.prompt.directory)
                            .font(.system(.callout, design: .monospaced).weight(.semibold))
                            .textSelection(.enabled)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text(presentation.prompt.agentName)
                            .font(.subheadline.weight(.semibold))
                        Text("\(presentation.groupName) · \(presentation.serverName)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    Spacer(minLength: 0)

                    VStack(spacing: 10) {
                        Button {
                            resolve(.accept)
                        } label: {
                            Text(isWorkspaceTrust ? "信任并继续" : "允许并继续")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isResolving)

                        Button(role: .destructive) {
                            resolve(.decline)
                        } label: {
                            Text("退出 Claude Code")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(isResolving)
                    }
                }
                .padding(24)
                .overlay {
                    if isResolving {
                        ProgressView()
                            .padding(18)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
            } else {
                ProgressView("正在确认启动状态…")
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: presentation.id) {
            await monitorPrompt()
        }
    }

    @MainActor
    private func monitorPrompt() async {
        while !Task.isCancelled {
            do {
                let prompts = try await store.agentStartupPrompts(
                    serverId: presentation.serverId,
                    groupId: presentation.prompt.groupId
                )
                guard prompts.contains(where: { $0.id == presentation.prompt.id }) else {
                    dismiss()
                    return
                }
                isPromptVerified = true
            } catch {
                // 保留已有提示；连接错误由操作按钮或现有连接状态展示。
                isPromptVerified = true
            }

            do {
                try await Task.sleep(for: .milliseconds(750))
            } catch {
                return
            }
        }
    }

    private func resolve(_ action: AgentStartupPromptAction) {
        guard !isResolving else { return }
        isResolving = true
        errorMessage = nil
        Task {
            do {
                _ = try await store.resolveAgentStartupPrompts(
                    serverId: presentation.serverId,
                    groupId: presentation.prompt.groupId,
                    action: action,
                    agentIds: [presentation.prompt.agentId],
                    expectedPrompts: [presentation.prompt]
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isResolving = false
            }
        }
    }
}
