import SwiftUI

enum CreateConversationMode: String, Identifiable {
    case direct
    case group

    var id: String { rawValue }

    var groupType: String {
        switch self {
        case .direct: "direct"
        case .group: "collaboration"
        }
    }

    var title: String {
        switch self {
        case .direct: "单聊"
        case .group: "建群"
        }
    }
}

private struct SelectedAgentInstance: Identifiable {
    let platform: String
    let index: Int
    let agent: SupportedAgent

    var id: String { "\(platform)#\(index)" }
    var displayName: String { index == 0 ? agent.name : "\(agent.name) \(index + 1)" }
}

struct CreateGroupView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let mode: CreateConversationMode
    let onCreated: (AgentGroup) -> Void

    @State private var groupName = ""
    @State private var workingDirectory = ""
    @State private var selectedPlatforms = Set<String>()
    @State private var instanceCountByPlatform: [String: Int] = [:]
    @State private var roleByMemberKey: [String: String] = [:]
    @State private var leaderMemberKeyByRole: [String: String] = [:]
    @State private var showDirectoryPicker = false
    @State private var isCreating = false
    @State private var isResolvingStartupPrompt = false
    @State private var pendingStartupPromptGroup: AgentGroup?
    @State private var pendingStartupPrompts: [AgentStartupPrompt] = []
    @State private var errorText: String?

    private var availableAgents: [SupportedAgent] {
        store.availableSupportedAgents(serverId: serverId)
    }

    private var selectedAgents: [SupportedAgent] {
        availableAgents.filter { selectedPlatforms.contains($0.platform) }
    }

    private var directoryConflict: AgentGroup? {
        guard mode == .group else { return nil }
        return store.groupUsingWorkingDirectory(
            workingDirectory,
            serverId: serverId,
            groupType: "collaboration"
        )
    }

    private var resolvedGroupName: String {
        let trimmed = groupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty else { return trimmed }
        if mode == .direct, let agent = selectedAgents.first {
            let basename = directoryBasename(workingDirectory)
            return basename.isEmpty ? agent.name : "\(agent.name) · \(basename)"
        }
        return directoryBasename(workingDirectory)
    }

    private var hasMissingRole: Bool {
        guard mode == .group else { return false }
        return selectedInstances.contains { (roleByMemberKey[$0.id] ?? "").isEmpty }
    }

    private var selectedInstances: [SelectedAgentInstance] {
        selectedAgents.flatMap { agent in
            (0..<(instanceCountByPlatform[agent.platform] ?? 1)).map { index in
                SelectedAgentInstance(platform: agent.platform, index: index, agent: agent)
            }
        }
    }

    private var hasValidRoleLeaders: Bool {
        guard mode == .group else { return true }
        let grouped = Dictionary(grouping: selectedInstances) { roleByMemberKey[$0.id] ?? "" }
        return grouped.allSatisfy { roleId, members in
            !roleId.isEmpty
                && (members.count == 1 || members.filter { leaderMemberKeyByRole[roleId] == $0.id }.count == 1)
        }
    }

    private var hasSingleCommitter: Bool {
        selectedInstances.filter { roleByMemberKey[$0.id] == "role-committer" }.count <= 1
    }

    private var hasValidAgentSelection: Bool {
        switch mode {
        case .direct:
            selectedAgents.count == 1
        case .group:
            selectedInstances.count >= 2
        }
    }

    private var canCreate: Bool {
        !isCreating
            && !isResolvingStartupPrompt
            && pendingStartupPromptGroup == nil
            && !workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !resolvedGroupName.isEmpty
            && hasValidAgentSelection
            && !hasMissingRole
            && hasValidRoleLeaders
            && hasSingleCommitter
            && directoryConflict == nil
    }

    var body: some View {
        Form {
            Section {
                Button {
                    showDirectoryPicker = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "folder")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(workingDirectory.isEmpty ? "选择 Mac 文件夹" : workingDirectory)
                                .foregroundStyle(workingDirectory.isEmpty ? .secondary : .primary)
                                .lineLimit(2)
                            if let directoryConflict {
                                Text("已被协作群「\(directoryConflict.name)」使用")
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                TextField(
                    mode == .direct ? "会话名称（留空自动生成）" : "群名称（留空使用文件夹名）",
                    text: $groupName
                )
            } header: {
                Text("工作目录")
            }

            Section {
                if availableAgents.isEmpty {
                    ContentUnavailableView(
                        "没有可用 AI",
                        systemImage: "terminal",
                        description: Text("请先在 Mac 上安装并配置支持的 CLI"),
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    ForEach(availableAgents) { agent in
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(isOn: platformBinding(agent.platform)) {
                                HStack(spacing: 10) {
                                    AgentAvatarView(
                                        platform: agent.platform,
                                        name: agent.name,
                                        size: 32,
                                        cornerRadius: 8,
                                    )
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(agent.name)
                                        Text(agent.platform)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            if mode == .group && selectedPlatforms.contains(agent.platform) {
                                Stepper(
                                    "独立实例：\(instanceCountByPlatform[agent.platform] ?? 1)",
                                    value: instanceCountBinding(agent.platform),
                                    in: 1...8,
                                )
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text(mode == .direct ? "选择 AI" : "支持的 AI")
            } footer: {
                if mode == .direct {
                    Text("单聊只连接一个 AI，不分配角色，也不启用任务交接。")
                }
            }

            if mode == .group && !selectedAgents.isEmpty {
                Section {
                    ForEach(selectedInstances) { instance in
                        VStack(alignment: .leading, spacing: 8) {
                            Picker(instance.displayName, selection: roleBinding(for: instance.id)) {
                                Text("选择角色").tag("")
                                ForEach(store.roles(serverId: serverId)) { role in
                                    Text(role.name).tag(role.id)
                                }
                            }
                            let roleId = roleByMemberKey[instance.id] ?? ""
                            let peers = selectedInstances.filter { roleByMemberKey[$0.id] == roleId }
                            if !roleId.isEmpty && peers.count > 1 {
                                Button {
                                    leaderMemberKeyByRole[roleId] = instance.id
                                } label: {
                                    Label(
                                        leaderMemberKeyByRole[roleId] == instance.id ? "Leader" : "设为该角色 Leader",
                                        systemImage: leaderMemberKeyByRole[roleId] == instance.id ? "crown.fill" : "crown",
                                    )
                                }
                                .font(.caption)
                            }
                        }
                    }
                } header: {
                    Text("成员角色")
                } footer: {
                    if !hasSingleCommitter {
                        Text("每个群最多只能有一个提交专员。")
                            .foregroundStyle(.red)
                    } else {
                        Text("一个 AI 只有一个角色；同角色多人时由 Leader 对外交接。AI 会在主任务启动时获得干净会话。")
                    }
                }
            }

            if let errorText {
                Section {
                    Text(errorText)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(mode.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { cancelCreation() }
                    .disabled(isCreating || isResolvingStartupPrompt)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    createGroup()
                } label: {
                    if isCreating || isResolvingStartupPrompt {
                        ProgressView()
                    } else {
                        Text(mode == .direct ? "开始" : "创建")
                    }
                }
                .disabled(!canCreate)
            }
        }
        .alert(startupPromptTitle, isPresented: Binding(
            get: { pendingStartupPromptGroup != nil && !pendingStartupPrompts.isEmpty },
            set: { _ in },
        )) {
            Button(startupPromptAcceptLabel) {
                acceptPendingStartupPrompts()
            }
            Button("取消创建", role: .destructive) {
                cancelPendingStartupPrompts()
            }
        } message: {
            Text(startupPromptAlertMessage)
        }
        .sheet(isPresented: $showDirectoryPicker) {
            NavigationStack {
                DirectoryPickerView(serverId: serverId, initialPath: workingDirectory.isEmpty ? nil : workingDirectory) { path in
                    workingDirectory = path
                    if groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        groupName = directoryBasename(path)
                    }
                }
            }
        }
    }

    private var startupPromptTitle: String {
        pendingStartupPrompts.contains { $0.kind == .bypassPermissions }
            ? "确认 Bypass Permissions 模式"
            : "需要授权工作目录"
    }

    private var startupPromptAcceptLabel: String {
        pendingStartupPrompts.contains { $0.kind == .bypassPermissions }
            ? "我了解风险，继续"
            : "授权并继续"
    }

    private var startupPromptAlertMessage: String {
        let agentNames = pendingStartupPrompts
            .map { $0.agentName.isEmpty ? $0.agentId : $0.agentName }
            .joined(separator: "、")
        if pendingStartupPrompts.contains(where: { $0.kind == .bypassPermissions }) {
            return "\(agentNames) 首次启用 Bypass Permissions 模式。此模式不会在执行潜在危险命令前请求批准，仅应在网络受限、可轻松恢复的沙箱或虚拟机中使用。\n\n继续即表示你了解并接受相关风险。"
        }
        let directories = Array(Set(pendingStartupPrompts.map(\.directory)))
            .filter { !$0.isEmpty }
            .sorted()
            .joined(separator: "\n")
        let directoryText = directories.isEmpty ? workingDirectory : directories
        return "\(agentNames) 需要确认是否信任此工作目录：\n\(directoryText)"
    }

    private func platformBinding(_ platform: String) -> Binding<Bool> {
        Binding {
            selectedPlatforms.contains(platform)
        } set: { isSelected in
            if isSelected {
                if mode == .direct {
                    selectedPlatforms = [platform]
                    roleByMemberKey.removeAll()
                    leaderMemberKeyByRole.removeAll()
                } else {
                    selectedPlatforms.insert(platform)
                    instanceCountByPlatform[platform] = max(1, instanceCountByPlatform[platform] ?? 1)
                    let key = "\(platform)#0"
                    if roleByMemberKey[key] == nil {
                        roleByMemberKey[key] = store.roles(serverId: serverId).first?.id ?? ""
                    }
                    normalizeLeaders()
                }
            } else {
                selectedPlatforms.remove(platform)
                instanceCountByPlatform.removeValue(forKey: platform)
                for key in Array(roleByMemberKey.keys) where key.hasPrefix("\(platform)#") {
                    roleByMemberKey.removeValue(forKey: key)
                }
                normalizeLeaders()
            }
        }
    }

    private func instanceCountBinding(_ platform: String) -> Binding<Int> {
        Binding {
            instanceCountByPlatform[platform] ?? 1
        } set: { count in
            let previous = instanceCountByPlatform[platform] ?? 1
            instanceCountByPlatform[platform] = count
            let defaultRole = store.roles(serverId: serverId).first?.id ?? ""
            if count > previous {
                for index in previous..<count {
                    roleByMemberKey["\(platform)#\(index)"] = defaultRole
                }
            } else if count < previous {
                for index in count..<previous {
                    roleByMemberKey.removeValue(forKey: "\(platform)#\(index)")
                }
            }
            normalizeLeaders()
        }
    }

    private func roleBinding(for memberKey: String) -> Binding<String> {
        Binding {
            roleByMemberKey[memberKey] ?? store.roles(serverId: serverId).first?.id ?? ""
        } set: { roleId in
            roleByMemberKey[memberKey] = roleId
            normalizeLeaders()
        }
    }

    private func normalizeLeaders() {
        let grouped = Dictionary(grouping: selectedInstances) { roleByMemberKey[$0.id] ?? "" }
        let validRoleIds = Set(grouped.keys.filter { !$0.isEmpty })
        leaderMemberKeyByRole = leaderMemberKeyByRole.filter { validRoleIds.contains($0.key) }
        for (roleId, members) in grouped where !roleId.isEmpty {
            if !members.contains(where: { $0.id == leaderMemberKeyByRole[roleId] }) {
                leaderMemberKeyByRole[roleId] = members.first?.id
            }
        }
    }

    private func createGroup() {
        guard canCreate else { return }
        errorText = nil
        isCreating = true

        let members: [(platform: String, roleId: String?, isLeader: Bool)]
        if mode == .direct {
            members = selectedAgents.map { (platform: $0.platform, roleId: nil, isLeader: false) }
        } else {
            members = selectedInstances.map { instance in
                let roleId = roleByMemberKey[instance.id] ?? ""
                return (
                    platform: instance.platform,
                    roleId: roleId,
                    isLeader: leaderMemberKeyByRole[roleId] == instance.id
                )
            }
        }

        Task {
            defer { isCreating = false }
            do {
                let group = try await store.createGroup(
                    serverId: serverId,
                    name: resolvedGroupName,
                    workingDirectory: workingDirectory,
                    members: members,
                    groupType: mode.groupType,
                )
                let prompts = try await waitForAgentStartupPrompts(groupId: group.id)
                if prompts.isEmpty {
                    completeCreation(group)
                } else {
                    pendingStartupPromptGroup = group
                    pendingStartupPrompts = prompts
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func waitForAgentStartupPrompts(groupId: String) async throws -> [AgentStartupPrompt] {
        let pollIntervalMs: UInt64 = 250
        let maxAttempts = 12
        for _ in 0..<maxAttempts {
            let prompts = try await store.agentStartupPrompts(serverId: serverId, groupId: groupId)
            if !prompts.isEmpty {
                return prompts
            }
            try await Task.sleep(for: .milliseconds(pollIntervalMs))
        }
        // 旧版 Claude Code 可能不会询问工作目录信任；未检测到提示时直接完成创建。
        return try await store.agentStartupPrompts(serverId: serverId, groupId: groupId)
    }

    private func completeCreation(_ group: AgentGroup) {
        pendingStartupPromptGroup = nil
        pendingStartupPrompts = []
        onCreated(group)
        dismiss()
    }

    private func acceptPendingStartupPrompts() {
        guard let group = pendingStartupPromptGroup else { return }
        guard !isResolvingStartupPrompt else { return }
        isResolvingStartupPrompt = true
        errorText = nil
        let agentIds = pendingStartupPrompts.map(\.agentId)

        Task {
            defer { isResolvingStartupPrompt = false }
            do {
                _ = try await store.resolveAgentStartupPrompts(
                    serverId: serverId,
                    groupId: group.id,
                    action: .accept,
                    agentIds: agentIds,
                    expectedPrompts: pendingStartupPrompts,
                )
                pendingStartupPrompts = []
                let nextPrompts = try await waitForAgentStartupPrompts(groupId: group.id)
                if nextPrompts.isEmpty {
                    completeCreation(group)
                } else {
                    pendingStartupPrompts = nextPrompts
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func cancelCreation() {
        if pendingStartupPromptGroup != nil {
            cancelPendingStartupPrompts()
        } else {
            dismiss()
        }
    }

    private func cancelPendingStartupPrompts() {
        guard let group = pendingStartupPromptGroup else {
            dismiss()
            return
        }
        guard !isResolvingStartupPrompt else { return }
        isResolvingStartupPrompt = true
        errorText = nil
        let agentIds = Array(Set(group.members.map(\.agentId)))

        Task {
            defer { isResolvingStartupPrompt = false }
            do {
                try await store.deleteGroup(group, serverId: serverId)
                for agentId in agentIds {
                    try? await store.deleteAgent(serverId: serverId, agentId: agentId, refresh: false)
                }
                await store.refreshState(serverId: serverId)
                pendingStartupPromptGroup = nil
                pendingStartupPrompts = []
                dismiss()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

private struct DirectoryPickerView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let initialPath: String?
    let onSelect: (String) -> Void

    @State private var current: DirectoryListResponse?
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var showHiddenFiles = false

    private var visibleEntries: [DirectoryEntry] {
        current?.entries.filter {
            DirectoryVisibilityPolicy.isVisible(
                name: $0.name,
                showHiddenFiles: showHiddenFiles
            )
        } ?? []
    }

    var body: some View {
        List {
            if let current {
                Section {
                    Text(current.path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                Section {
                    Toggle(isOn: $showHiddenFiles) {
                        Label("显示隐藏文件", systemImage: "eye")
                    }
                }

                if let parentPath = current.parentPath {
                    Section {
                        Button {
                            load(path: parentPath)
                        } label: {
                            Label("上一级", systemImage: "arrow.up")
                        }
                    }
                }

                Section {
                    if visibleEntries.isEmpty {
                        Text("没有子文件夹")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(visibleEntries) { entry in
                            Button {
                                load(path: entry.path)
                            } label: {
                                HStack {
                                    Label(entry.name, systemImage: "folder")
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .foregroundStyle(.primary)
                        }
                    }
                } header: {
                    Text("文件夹")
                }
            }

            if isLoading {
                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在读取…")
                    }
                }
            }

            if let errorText {
                Section {
                    Text(errorText)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("选择文件夹")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("选择此文件夹") {
                    if let path = current?.path {
                        onSelect(path)
                        dismiss()
                    }
                }
                .disabled(current == nil || isLoading)
            }
        }
        .task {
            if current == nil {
                await loadInitial()
            }
        }
        .refreshable {
            await loadCurrent()
        }
    }

    private func load(path: String?) {
        Task { await loadDirectory(path: path) }
    }

    private func loadInitial() async {
        await loadDirectory(path: initialPath)
    }

    private func loadCurrent() async {
        await loadDirectory(path: current?.path ?? initialPath)
    }

    private func loadDirectory(path: String?) async {
        isLoading = true
        errorText = nil
        defer { isLoading = false }
        do {
            current = try await store.listDirectories(serverId: serverId, path: path)
        } catch {
            errorText = error.localizedDescription
        }
    }
}

private func directoryBasename(_ directory: String) -> String {
    let trimmed = directory.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !normalized.isEmpty else { return "" }
    return normalized.split(separator: "/").last.map(String.init) ?? ""
}
