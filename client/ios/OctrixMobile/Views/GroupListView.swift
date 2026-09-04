import SwiftUI

struct GroupListView: View {
    @EnvironmentObject private var store: AppStore
    @State private var showSettings = false
    @State private var showCreateServerPicker = false
    @State private var showCreateMenu = false
    @State private var selectedCreateServerId: String?
    @State private var createGroupRequest: CreateGroupRequest?
    @State private var createMissionRequest: CreateMissionRequest?
    @State private var showMacSetupGuide = false
    @State private var expandedArchivedServerIds = Set<String>()
    @State private var pendingRoute: ConversationRoute?
    @State private var deleteCandidate: ScopedGroup?
    @State private var managementError: String?

    let onOpenGroup: (ConversationRoute) -> Void

    var body: some View {
        List {
            if store.conversationSections.isEmpty {
                Section {
                    AccountMacEmptyState(
                        onOpenGuide: { showMacSetupGuide = true },
                        onRefresh: {
                            Task {
                                if store.settings.isAuthenticated {
                                    _ = try? await store.syncAccountDevices()
                                }
                                await store.refreshState()
                            }
                        }
                    )
                }
            } else {
                ForEach(store.conversationSections) { section in
                    serverConversationSections(section)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color(.systemGroupedBackground))
        .navigationTitle("会话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showCreateServerPicker = true
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(store.conversationSections.isEmpty)

                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView(isOnboarding: false)
            }
        }
        .sheet(isPresented: $showMacSetupGuide) {
            NavigationStack {
                MacSetupGuideView(presentation: .help) {}
            }
        }
        .confirmationDialog("选择 Mac", isPresented: $showCreateServerPicker, titleVisibility: .visible) {
            ForEach(store.conversationSections) { section in
                Button(section.config.title) {
                    selectedCreateServerId = section.id
                    showCreateMenu = true
                }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("新建", isPresented: $showCreateMenu, titleVisibility: .visible) {
            Button("新任务") {
                if let selectedCreateServerId {
                    createMissionRequest = CreateMissionRequest(serverId: selectedCreateServerId)
                }
            }
            Button("单聊") {
                if let selectedCreateServerId {
                    createGroupRequest = CreateGroupRequest(serverId: selectedCreateServerId, mode: .direct)
                }
            }
            Button("建群") {
                if let selectedCreateServerId {
                    createGroupRequest = CreateGroupRequest(serverId: selectedCreateServerId, mode: .group)
                }
            }
            Button("取消", role: .cancel) {}
        }
        .sheet(item: $createGroupRequest) { request in
            NavigationStack {
                CreateGroupView(serverId: request.serverId, mode: request.mode) { group in
                    createGroupRequest = nil
                    onOpenGroup(ConversationRoute(serverId: request.serverId, groupId: group.id))
                }
            }
        }
        .sheet(item: $createMissionRequest) { request in
            NavigationStack {
                CreateMissionView(serverId: request.serverId) { group, _ in
                    createMissionRequest = nil
                    onOpenGroup(ConversationRoute(serverId: request.serverId, groupId: group.id))
                }
            }
        }
        .refreshable {
            if store.settings.isAuthenticated {
                _ = try? await store.syncAccountDevices()
            }
            await store.refreshState()
        }
        .alert("删除会话", isPresented: Binding(
            get: { deleteCandidate != nil },
            set: { if !$0 { deleteCandidate = nil } },
        )) {
            Button("删除", role: .destructive) {
                let candidate = deleteCandidate
                deleteCandidate = nil
                if let candidate {
                    runGroupAction(.delete, scoped: candidate)
                }
            }
            Button("取消", role: .cancel) {
                deleteCandidate = nil
            }
        } message: {
            Text("确定要删除「\(deleteCandidate?.group.name ?? "该会话")」吗？此操作无法撤销。")
        }
        .alert("出错了", isPresented: Binding(
            get: { managementError != nil },
            set: { if !$0 { managementError = nil } },
        )) {
            Button("好", role: .cancel) { managementError = nil }
        } message: {
            Text(managementError ?? "")
        }
    }

    @ViewBuilder
    private func serverConversationSections(_ section: ServerConversationSection) -> some View {
        let archivedExpanded = expandedArchivedServerIds.contains(section.id)

        Section {
            if !section.hasLoadedState {
                SyncingStateRow()
            } else if section.activeGroups.isEmpty {
                EmptyConversationRow(
                    title: "没有最近会话",
                    detail: "可以在这台 Mac 上新建单聊或群聊"
                ) {
                    createGroupRequest = CreateGroupRequest(serverId: section.id, mode: .direct)
                } onCreateGroup: {
                    createGroupRequest = CreateGroupRequest(serverId: section.id, mode: .group)
                }
            } else {
                ForEach(section.activeGroups) { group in
                    groupLink(serverId: section.id, group: group)
                }
            }

            if !section.archivedGroups.isEmpty {
                Button {
                    if archivedExpanded {
                        expandedArchivedServerIds.remove(section.id)
                    } else {
                        expandedArchivedServerIds.insert(section.id)
                    }
                } label: {
                    Label(
                        archivedExpanded
                            ? "收起已归档会话（\(section.archivedGroups.count)）"
                            : "查看已归档会话（\(section.archivedGroups.count)）",
                        systemImage: archivedExpanded ? "chevron.up" : "archivebox"
                    )
                }

                if archivedExpanded {
                    ForEach(section.archivedGroups) { group in
                        groupLink(serverId: section.id, group: group)
                    }
                }
            }
        } header: {
            ConversationServerHeader(
                section: section,
                title: conversationHeaderTitle(for: section),
                count: conversationHeaderCount(for: section),
            )
        }
    }

    private func conversationHeaderTitle(for section: ServerConversationSection) -> String {
        if !section.hasLoadedState {
            return "同步中"
        }
        if section.activeGroups.isEmpty && !section.archivedGroups.isEmpty {
            return "已归档"
        }
        return "最近会话"
    }

    private func conversationHeaderCount(for section: ServerConversationSection) -> Int {
        if !section.hasLoadedState {
            return 0
        }
        if section.activeGroups.isEmpty && !section.archivedGroups.isEmpty {
            return section.archivedGroups.count
        }
        return section.activeGroups.count
    }

    private func groupLink(serverId: String, group: AgentGroup) -> some View {
        let route = ConversationRoute(serverId: serverId, groupId: group.id)
        let scoped = ScopedGroup(serverId: serverId, group: group)
        return NavigationLink(value: route) {
            GroupRow(serverId: serverId, group: group, isPending: pendingRoute == route)
        }
        .disabled(pendingRoute == route)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                deleteCandidate = scoped
            } label: {
                Label("删除", systemImage: "trash")
            }

            if group.isArchived {
                Button {
                    runGroupAction(.unarchive, scoped: scoped)
                } label: {
                    Label("恢复", systemImage: "arrow.uturn.backward")
                }
                .tint(.green)
            } else {
                Button {
                    runGroupAction(.archive, scoped: scoped)
                } label: {
                    Label("归档", systemImage: "archivebox")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            if group.isArchived {
                Button {
                    runGroupAction(.unarchive, scoped: scoped)
                } label: {
                    Label("恢复", systemImage: "arrow.uturn.backward")
                }
            } else {
                Button {
                    runGroupAction(.archive, scoped: scoped)
                } label: {
                    Label("归档", systemImage: "archivebox")
                }
            }
            Button(role: .destructive) {
                deleteCandidate = scoped
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
    }

    private func runGroupAction(_ action: GroupManagementAction, scoped: ScopedGroup) {
        let route = ConversationRoute(serverId: scoped.serverId, groupId: scoped.group.id)
        guard pendingRoute == nil else { return }
        pendingRoute = route
        Task { @MainActor in
            defer { pendingRoute = nil }
            do {
                switch action {
                case .archive:
                    try await store.archiveGroup(scoped.group, serverId: scoped.serverId)
                case .unarchive:
                    try await store.unarchiveGroup(scoped.group, serverId: scoped.serverId)
                case .delete:
                    try await store.deleteGroup(scoped.group, serverId: scoped.serverId)
                }
            } catch {
                managementError = error.localizedDescription
            }
        }
    }
}

private struct AccountMacEmptyState: View {
    let onOpenGuide: () -> Void
    let onRefresh: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.system(size: 34, weight: .medium))
                .foregroundStyle(Color.accentColor)
                .padding(.top, 8)

            VStack(spacing: 6) {
                Text("先让一台 Mac 上线")
                    .font(.headline)
                Text("在 Mac 安装 Octrix Host，并登录同一个账号。Host 会后台常驻，授权后这里会自动出现所有 Mac。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: onOpenGuide) {
                Label("查看安装与授权步骤", systemImage: "list.number")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button(action: onRefresh) {
                Label("我已完成授权，重新检查", systemImage: "arrow.clockwise")
            }
            .font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.horizontal, 18)
    }
}

private struct ScopedGroup: Identifiable {
    let serverId: String
    let group: AgentGroup

    var id: String { "\(serverId):\(group.id)" }
}

private struct CreateGroupRequest: Identifiable {
    let serverId: String
    let mode: CreateConversationMode

    var id: String { "\(serverId):\(mode.rawValue)" }
}

private struct CreateMissionRequest: Identifiable {
    let serverId: String

    var id: String { serverId }
}

private struct ConversationServerHeader: View {
    let section: ServerConversationSection
    let title: String
    let count: Int

    private var statusColor: Color {
        switch section.connection {
        case .connected:
            return .green
        case .connecting:
            return .orange
        case .retrying:
            return .orange
        case .waitingForManualRetry:
            return .red
        case .disconnected:
            return .red
        }
    }

    private var statusLabel: String {
        switch section.connection {
        case .connected:
            return "Mac 在线"
        case .connecting:
            return "Mac 连接中"
        case .retrying(let attempt):
            return "Mac 重连中，第 \(attempt) 次"
        case .waitingForManualRetry:
            return "Mac 等待手动重连"
        case .disconnected:
            return "Mac 离线"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .accessibilityLabel(statusLabel)

            VStack(alignment: .leading, spacing: 3) {
                Text(section.config.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(statusLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text("\(title) \(count)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .textCase(nil)
        .padding(.top, 6)
    }
}

struct GroupRow: View {
    @EnvironmentObject private var store: AppStore
    let serverId: String
    let group: AgentGroup
    var isPending = false

    var body: some View {
        let agents = store.uniqueAgents(in: group, serverId: serverId)
        let presences = agents.map {
            store.agentPresence(agent: $0, in: group, serverId: serverId)
        }
        let running = presences.filter { $0 == .online || $0 == .busy }.count
        let busy = presences.filter { $0 == .busy }.count
        let memberCount = agents.count
        let last = store.lastMessage(in: group, serverId: serverId)
        let singleAgent = agents.count == 1 ? agents[0] : nil
        let rowPresence = aggregatePresence(presences)
        let displayPresence: AgentPresenceState = rowPresence == .busy
            ? rowPresence
            : (store.hasUnreadResult(serverId: serverId, groupId: group.id) ? .unreadResult : rowPresence)
        let displayPresenceDetail = displayPresence == .unreadResult
            ? "AI 已有结果，未查看"
            : groupPresenceDetail(presences)

        HStack(spacing: 12) {
            if let singleAgent {
                AgentAvatarView(
                    platform: singleAgent.platform,
                    name: singleAgent.name,
                    color: AgentColorPalette.color(for: singleAgent.avatarColor),
                    size: 44,
                    cornerRadius: 10,
                )
                .overlay(alignment: .bottomLeading) {
                    AgentPresenceIndicator(
                        state: displayPresence,
                        detail: displayPresence == .unreadResult
                            ? displayPresenceDetail
                            : store.agentError(agent: singleAgent, in: group, serverId: serverId),
                        size: 12,
                        borderWidth: 2,
                    )
                    .offset(x: -2, y: 2)
                }
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.accentColor.opacity(0.15))
                        .frame(width: 44, height: 44)
                    Text(String(group.name.prefix(1)))
                        .font(.headline)
                        .foregroundStyle(Color.accentColor)
                }
                .overlay(alignment: .bottomLeading) {
                    AgentPresenceIndicator(
                        state: displayPresence,
                        detail: displayPresenceDetail,
                        size: 12,
                        borderWidth: 2,
                    )
                    .offset(x: -2, y: 2)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(group.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    if let last {
                        Text(last.date, style: .time)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    if busy > 0 {
                        Text(busy == 1 ? "忙碌中" : "\(busy) 忙碌")
                        .font(.caption)
                        .foregroundStyle(AgentPresenceState.busy.color)
                    } else if running > 0 {
                        Text("\(running) 在线")
                        .font(.caption)
                        .foregroundStyle(AgentPresenceState.online.color)
                    }
                    if group.isArchived {
                        Text("已归档")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Text(group.isDirectChat ? "单聊" : "\(memberCount) 名成员")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let last {
                    Text("\(last.from == "user" ? "我" : last.from)：\(last.body)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if isPending {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func aggregatePresence(_ presences: [AgentPresenceState]) -> AgentPresenceState {
        if presences.contains(.error) { return .error }
        if presences.contains(.busy) { return .busy }
        if presences.contains(.online) { return .online }
        return .offline
    }

    private func groupPresenceDetail(_ presences: [AgentPresenceState]) -> String? {
        let busy = presences.filter { $0 == .busy }.count
        if busy > 0 { return busy == 1 ? "1 名 AI 忙碌中" : "\(busy) 名 AI 忙碌中" }
        let online = presences.filter { $0 == .online }.count
        if online > 0 { return online == 1 ? "1 名 AI 在线" : "\(online) 名 AI 在线" }
        return nil
    }
}

private enum GroupManagementAction {
    case archive
    case unarchive
    case delete
}

enum ConnectionAppearance {
    static func color(_ state: SocketClient.ConnectionState) -> Color {
        switch state {
        case .connected: .green
        case .connecting: .orange
        case .retrying: .orange
        case .waitingForManualRetry: .red
        case .disconnected: .red
        }
    }

    static func label(_ state: SocketClient.ConnectionState) -> String {
        switch state {
        case .connected: "已连接"
        case .connecting: "连接中…"
        case .retrying(let attempt): "重连中 · 第 \(attempt) 次"
        case .waitingForManualRetry: "等待手动重连"
        case .disconnected: "未连接"
        }
    }

    static func title(_ state: SocketClient.ConnectionState) -> String {
        switch state {
        case .connected: "中继已连接"
        case .connecting: "正在连接中继"
        case .retrying(let attempt): "正在重连中继（第 \(attempt) 次）"
        case .waitingForManualRetry: "中继连接已暂停"
        case .disconnected: "中继未连接"
        }
    }

    static func detail(_ state: SocketClient.ConnectionState) -> String {
        switch state {
        case .connected: "Mac 状态已同步"
        case .connecting: "正在建立和 Mac 的连接"
        case .retrying: "短时异常时会自动恢复"
        case .waitingForManualRetry: "自动重试已停止，请在设置中手动重连"
        case .disconnected: "尚未建立连接"
        }
    }

    static func icon(_ state: SocketClient.ConnectionState) -> String {
        switch state {
        case .connected: "checkmark.circle.fill"
        case .connecting: "dot.radiowaves.left.and.right"
        case .retrying: "arrow.trianglehead.clockwise"
        case .waitingForManualRetry: "exclamationmark.triangle.fill"
        case .disconnected: "wifi.slash"
        }
    }
}

struct SyncingStateRow: View {
    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .frame(width: 40, height: 40)
                ProgressView()
                    .controlSize(.small)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text("正在同步会话")
                    .font(.subheadline.weight(.semibold))
                Text("从 Mac 中继读取会话、Agent 和运行状态")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
    }
}

struct EmptyConversationRow: View {
    var title = "还没有会话"
    var detail = "选择 Mac 文件夹后，可以直连一个 AI，或创建带角色的群聊。"
    let onCreateDirect: () -> Void
    let onCreateGroup: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                        .frame(width: 42, height: 42)
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 10) {
                Button(action: onCreateDirect) {
                    Label("单聊", systemImage: "person.fill")
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Button(action: onCreateGroup) {
                    Label("建群", systemImage: "person.3.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .controlSize(.regular)
        }
        .padding(.vertical, 10)
    }
}
