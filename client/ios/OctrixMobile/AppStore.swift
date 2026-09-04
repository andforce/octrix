import Combine
import Foundation

struct ConversationRoute: Hashable {
    let serverId: String
    let groupId: String
}

struct ServerConversationSection: Identifiable {
    let config: RelayServerConfig
    let connection: SocketClient.ConnectionState
    let hasLoadedState: Bool
    let lastErrorMessage: String?
    let activeGroups: [AgentGroup]
    let archivedGroups: [AgentGroup]

    var id: String { config.id }
    var totalCount: Int { activeGroups.count + archivedGroups.count }
}

private struct ServerRuntimeState {
    var agents: [Agent] = []
    var groups: [AgentGroup] = []
    var roles: [Role] = []
    var taskSessions: [TaskSession] = []
    var workItems: [WorkItem] = []
    var issues: [CollaborationIssue] = []
    var messages: [Envelope] = []
    var runningAgentIdsByGroup: [String: [String]] = [:]
    var busyAgentIdsByGroup: [String: [String]] = [:]
    var agentErrorsByGroup: [String: [String: String]] = [:]
    var platformInstallState: [String: Bool] = [:]
    var enabledAgentPlatforms: [String] = SupportedAgentCatalog.defaultEnabledPlatforms
    var connection: SocketClient.ConnectionState = .disconnected
    var hasLoadedState = false
    var lastErrorMessage: String?
}

private struct OptimisticConversation {
    let userMessage: Envelope
    let clientMsgId: String
    var userConfirmed = false
    var pendingAssistantMessages: [Envelope]

    var id: String { userMessage.id }
    var groupId: String? { userMessage.groupId }
    var taskSessionId: String? { userMessage.taskSessionId }
    var createdAt: Double { userMessage.ts }

    var unresolvedMessages: [Envelope] {
        var messages: [Envelope] = []
        if !userConfirmed {
            messages.append(userMessage)
        }
        messages.append(contentsOf: pendingAssistantMessages)
        return messages
    }
}

/// 全局状态：按 relay server/device 镜像 Mac 端 /api/state，通过 WebSocket 事件保持增量同步。
@MainActor
final class AppStore: ObservableObject {
    let settings = RelaySettings()
    private var sockets: [String: SocketClient] = [:]
    private var cancellables = Set<AnyCancellable>()
    private var optimisticConversationsByServer: [String: [OptimisticConversation]] = [:]
    private var scheduledStateRefreshTasks: [String: Task<Void, Never>] = [:]
    private var scheduledStateRefreshTokens: [String: UUID] = [:]
    private var missingMessageFetchTasks: [String: Task<Void, Never>] = [:]
    private var eventSyncTasks: [String: Task<Void, Never>] = [:]
    private let localConversations = LocalConversationDatabase.makeDefault()
    private let persistenceQueue = DispatchQueue(label: "com.octrix.mobile.local-conversations")
    private var activeConversationRoute: ConversationRoute?

    @Published private var serverStates: [String: ServerRuntimeState] = [:]
    @Published private var unreadResultMarkers: [String: Double] = AppStore.loadUnreadResultMarkers()

    var isConfigured: Bool { settings.isConfigured }

    var hasLoadedState: Bool {
        !settings.servers.isEmpty && settings.servers.allSatisfy { state(for: $0.id).hasLoadedState }
    }

    var connection: SocketClient.ConnectionState {
        let states = settings.servers.map { state(for: $0.id).connection }
        guard !states.isEmpty else { return .disconnected }
        if states.allSatisfy({ $0 == .connected }) { return .connected }
        if let retrying = states.compactMap({ state -> Int? in
            if case .retrying(let attempt) = state { return attempt }
            return nil
        }).max() {
            return .retrying(attempt: retrying)
        }
        if states.contains(where: {
            if case .connecting = $0 { return true }
            return false
        }) {
            return .connecting
        }
        if states.contains(.waitingForManualRetry) { return .waitingForManualRetry }
        return .disconnected
    }

    var conversationSections: [ServerConversationSection] {
        settings.servers.map { config in
            let runtime = state(for: config.id)
            return ServerConversationSection(
                config: config,
                connection: runtime.connection,
                hasLoadedState: runtime.hasLoadedState,
                lastErrorMessage: runtime.lastErrorMessage,
                activeGroups: runtime.groups
                    .filter { !$0.isArchived }
                    .sorted { $0.createdAt > $1.createdAt },
                archivedGroups: runtime.groups
                    .filter { $0.isArchived }
                    .sorted { ($0.archivedAt ?? $0.createdAt) > ($1.archivedAt ?? $1.createdAt) },
            )
        }
    }

    init() {
        reconcileServers(settings.servers)
        settings.$servers
            .sink { [weak self] servers in
                self?.reconcileServers(servers)
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)
    }

    // MARK: - 账号设备

    @discardableResult
    func saveServer(serverURLString: String, token: String, device: DeviceInfo, accountLabel: String? = nil) -> RelayServerConfig? {
        guard let config = settings.upsertServer(
            serverURLString: serverURLString,
            token: token,
            device: device,
            accountLabel: accountLabel
        ) else {
            return nil
        }
        reconcileServers(settings.servers)
        return config
    }

    func saveCloudAccount(serverURLString: String, token: String, accountLabel: String) {
        settings.saveCloudAccount(serverURLString: serverURLString, token: token, accountLabel: accountLabel)
        objectWillChange.send()
    }

    /// 以授权中心返回的账号设备列表为唯一事实源，同步本地连接目标。
    @discardableResult
    func syncAccountDevices() async throws -> [DeviceInfo] {
        guard let account = settings.cloudAccount,
              let baseURL = account.baseURL,
              !settings.cloudAccountToken.isEmpty else {
            throw RelayAPIError(message: "请先登录 Octrix 账号")
        }
        let accessToken = settings.cloudAccountToken

        let devices = try await RelayAPI(
            baseURL: baseURL,
            token: accessToken
        ).devices()
        guard settings.cloudAccount?.baseURL?.absoluteString == baseURL.absoluteString,
              settings.cloudAccountToken == accessToken else {
            return []
        }
        let authorizedDeviceIds = Set(devices.map(\.deviceId))
        let staleServerIds = settings.servers.compactMap { config -> String? in
            let belongsToAccount = config.baseURL?.absoluteString == baseURL.absoluteString
            return belongsToAccount && authorizedDeviceIds.contains(config.deviceId) ? nil : config.id
        }

        for serverId in staleServerIds {
            removeServer(id: serverId)
        }
        for device in devices {
            saveServer(
                serverURLString: baseURL.absoluteString,
                token: accessToken,
                device: device,
                accountLabel: account.accountLabel
            )
        }

        connectIfConfigured()
        objectWillChange.send()
        return devices
    }

    func removeServer(id: String) {
        disconnect(serverId: id)
        settings.removeServer(id: id)
        scheduledStateRefreshTasks[id]?.cancel()
        scheduledStateRefreshTasks[id] = nil
        scheduledStateRefreshTokens[id] = nil
        clearPersistedSyncMarkers(serverId: id)
        localConversations?.removeServer(serverId: id)
        reconcileServers(settings.servers)
    }

    /// 先在授权中心撤销 Mac，服务端确认后再清理本机连接与缓存。
    func deleteAccountDevice(serverId: String) async throws {
        guard let config = settings.server(id: serverId),
              let account = settings.cloudAccount,
              let baseURL = account.baseURL,
              config.baseURL?.absoluteString == baseURL.absoluteString,
              !settings.cloudAccountToken.isEmpty else {
            throw RelayAPIError(message: "请先登录 Octrix 账号")
        }
        let accessToken = settings.cloudAccountToken
        do {
            try await RelayAPI(baseURL: baseURL, token: accessToken)
                .deleteMacDevice(deviceId: config.deviceId)
        } catch let error as RelayAPIError where error.code == "device_not_found" {
            // 授权中心已经没有该设备时，删除的最终目标已达成。
        }

        guard settings.cloudAccount?.baseURL?.absoluteString == baseURL.absoluteString,
              settings.cloudAccountToken == accessToken else { return }
        removeServer(id: serverId)
        objectWillChange.send()
    }

    func resetServers() {
        disconnectAll()
        for task in scheduledStateRefreshTasks.values {
            task.cancel()
        }
        for task in missingMessageFetchTasks.values {
            task.cancel()
        }
        for task in eventSyncTasks.values {
            task.cancel()
        }
        scheduledStateRefreshTasks.removeAll()
        scheduledStateRefreshTokens.removeAll()
        missingMessageFetchTasks.removeAll()
        eventSyncTasks.removeAll()
        for server in settings.servers {
            clearPersistedSyncMarkers(serverId: server.id)
        }
        settings.reset()
        localConversations?.removeAll()
        clearAllUnreadResultMarkers()
        reconcileServers(settings.servers)
    }

    /// 先清理本机连接与钥匙串，再尽力撤销云端 iPhone 令牌。
    /// 返回 false 表示本机已经退出，但至少一个云端撤销请求未成功。
    func logout() async -> Bool {
        var seen = Set<String>()
        var revokeTargets: [(baseURL: URL, token: String)] = []

        if let account = settings.cloudAccount,
           let baseURL = account.baseURL,
           !settings.cloudAccountToken.isEmpty {
            let key = "\(baseURL.absoluteString)\u{0}\(settings.cloudAccountToken)"
            seen.insert(key)
            revokeTargets.append((baseURL, settings.cloudAccountToken))
        }

        revokeTargets.append(contentsOf: settings.servers.compactMap { config in
            guard let baseURL = config.baseURL else { return nil }
            let token = settings.token(for: config.id)
            guard !token.isEmpty else { return nil }
            let key = "\(baseURL.absoluteString)\u{0}\(token)"
            guard seen.insert(key).inserted else { return nil }
            return (baseURL, token)
        })

        resetServers()

        var allRevoked = true
        for target in revokeTargets {
            do {
                try await RelayAPI(baseURL: target.baseURL, token: target.token).revokeCurrentDevice()
            } catch let error as RelayAPIError where error.statusCode == 401 {
                // 令牌已经失效，退出目标同样达成。
            } catch {
                allRevoked = false
            }
        }
        return allRevoked
    }

    /// 服务端确认永久删除后，再清理本机凭证和账号相关缓存。
    func deleteAccount() async throws {
        guard let account = settings.cloudAccount,
              let baseURL = account.baseURL,
              !settings.cloudAccountToken.isEmpty else {
            throw RelayAPIError(message: "请先登录 Octrix 账号")
        }
        let accessToken = settings.cloudAccountToken
        try await RelayAPI(baseURL: baseURL, token: accessToken).deleteAccount()
        resetServers()
        DeepSeekVoicePolishSettings.clearAPIKey()
    }

    func route(forGroupId groupId: String) -> ConversationRoute? {
        for config in settings.servers {
            if groups(serverId: config.id).contains(where: { $0.id == groupId }) {
                return ConversationRoute(serverId: config.id, groupId: groupId)
            }
        }
        return nil
    }

    // MARK: - 连接

    func connectIfConfigured(force: Bool = false) {
        for config in settings.servers {
            connect(serverId: config.id, force: force)
        }
    }

    func connect(serverId: String, force: Bool = false) {
        guard let config = settings.server(id: serverId),
              let base = config.baseURL,
              !settings.token(for: serverId).isEmpty,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path += "/d/\(config.deviceId)/ws"
        components.queryItems = [URLQueryItem(name: "initial", value: "0")]
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(settings.token(for: serverId))", forHTTPHeaderField: "Authorization")
        socket(for: serverId).connect(request: request, force: force)
    }

    func disconnect(serverId: String, publishState: Bool = true) {
        sockets[serverId]?.disconnect(publishState: publishState)
        if publishState {
            updateState(serverId: serverId) { $0.connection = .disconnected }
        }
    }

    func disconnectAll(publishState: Bool = true) {
        for serverId in sockets.keys {
            disconnect(serverId: serverId, publishState: publishState)
        }
    }

    func refreshState() async {
        for config in settings.servers {
            await refreshState(serverId: config.id)
        }
    }

    func refreshState(serverId: String) async {
        do {
            let context = try apiContext(serverId: serverId)
            let state = try await context.api.mobileState(deviceId: context.config.deviceId)
            applyMobileState(state, serverId: serverId)
            updateState(serverId: serverId) { $0.lastErrorMessage = nil }
        } catch {
            updateState(serverId: serverId) { $0.lastErrorMessage = error.localizedDescription }
        }
    }

    func refreshFullState(serverId: String) async {
        do {
            let context = try apiContext(serverId: serverId)
            let state = try await context.api.state(deviceId: context.config.deviceId)
            applyState(state, serverId: serverId)
            updateState(serverId: serverId) { $0.lastErrorMessage = nil }
        } catch {
            updateState(serverId: serverId) { $0.lastErrorMessage = error.localizedDescription }
        }
    }

    private func reconcileServers(_ servers: [RelayServerConfig]) {
        let serverIds = Set(servers.map(\.id))
        for id in serverStates.keys where !serverIds.contains(id) {
            sockets[id]?.disconnect(publishState: false)
            sockets[id] = nil
            scheduledStateRefreshTasks[id]?.cancel()
            scheduledStateRefreshTasks[id] = nil
            scheduledStateRefreshTokens[id] = nil
            for key in Array(missingMessageFetchTasks.keys) where key.hasPrefix("\(id):") {
                missingMessageFetchTasks[key]?.cancel()
                missingMessageFetchTasks[key] = nil
            }
            eventSyncTasks[id]?.cancel()
            eventSyncTasks[id] = nil
            clearPersistedSyncMarkers(serverId: id)
            clearUnreadResultMarkers(serverId: id)
            serverStates[id] = nil
        }
        for server in servers where serverStates[server.id] == nil {
            serverStates[server.id] = restoredRuntimeState(serverId: server.id)
        }
    }

    private func restoredRuntimeState(serverId: String) -> ServerRuntimeState {
        var runtime = ServerRuntimeState()
        guard let cached = localConversations?.restore(serverId: serverId), !cached.isEmpty else {
            return runtime
        }
        runtime.agents = cached.agents
        runtime.groups = cached.groups
        runtime.roles = cached.roles
        runtime.taskSessions = cached.taskSessions
        runtime.messages = cached.messages
        runtime.hasLoadedState = true
        return runtime
    }

    private func socket(for serverId: String) -> SocketClient {
        if let socket = sockets[serverId] { return socket }
        let socket = SocketClient()
        socket.onEvent = { [weak self] envelope in
            self?.apply(envelope, serverId: serverId)
        }
        socket.onStateChange = { [weak self] state in
            self?.updateState(serverId: serverId) { $0.connection = state }
            if state == .connected {
                self?.syncEventsSinceLastSeq(serverId: serverId)
                if self?.state(for: serverId).hasLoadedState != true {
                    Task { await self?.refreshState(serverId: serverId) }
                }
            }
        }
        socket.onAuthorizationRevoked = { [weak self] in
            self?.resetServers()
        }
        sockets[serverId] = socket
        return socket
    }

    private func apiContext(serverId: String) throws -> (api: RelayAPI, config: RelayServerConfig) {
        guard let config = settings.server(id: serverId),
              let base = config.baseURL,
              !settings.token(for: serverId).isEmpty else {
            throw RelayAPIError(message: "当前没有可访问的 Mac")
        }
        return (RelayAPI(baseURL: base, token: settings.token(for: serverId)), config)
    }

    private func state(for serverId: String) -> ServerRuntimeState {
        serverStates[serverId] ?? ServerRuntimeState()
    }

    private func updateState(serverId: String, _ mutate: (inout ServerRuntimeState) -> Void) {
        var state = serverStates[serverId] ?? ServerRuntimeState()
        mutate(&state)
        serverStates[serverId] = state
    }

    private func logRealtime(_ message: String) {
        #if DEBUG
        let ts = String(format: "%.3f", Date().timeIntervalSince1970)
        print("[iOS-realtime \(ts)] \(message)")
        #endif
    }

    private func persist(_ work: @escaping (LocalConversationDatabase) -> Void) {
        guard let localConversations else { return }
        persistenceQueue.async {
            work(localConversations)
        }
    }

    // MARK: - 事件应用（对齐 client/web/src/hooks/useWebSocket.ts 的 reducer）

    private func apply(_ envelope: ServerEventEnvelope, serverId: String) {
        apply(envelope.event, serverId: serverId)
        if let seq = envelope.seq {
            saveLastSeq(seq, serverId: serverId)
        }
    }

    private func apply(_ event: ServerEvent, serverId: String) {
        switch event {
        case .state(let state):
            applyState(state, serverId: serverId)
        case .newMessage(let envelope):
            logRealtime("messages:new id=\(envelope.id) from=\(envelope.from) body=\(envelope.body.count) status=\(envelope.status ?? "nil")")
            upsertServerMessage(envelope, serverId: serverId)
            markUnreadResultIfNeeded(for: envelope, serverId: serverId)
        case .updateMessage(let update):
            logRealtime("messages:update id=\(update.id) body=\(update.body?.count ?? -1) status=\(update.status ?? "nil")")
            if let updatedMessage = applyMessageUpdate(update, serverId: serverId) {
                markUnreadResultIfNeeded(for: updatedMessage, serverId: serverId)
            } else {
                fetchMissingMessage(update: update, serverId: serverId)
            }
        case .processStatus(let status):
            markUnreadResultsForProcessStatusChange(status, serverId: serverId)
            updateState(serverId: serverId) { state in
                state.runningAgentIdsByGroup = status.runningAgentIdsByGroup
                state.busyAgentIdsByGroup = status.busyAgentIdsByGroup ?? [:]
                state.agentErrorsByGroup = status.agentErrorsByGroup ?? [:]
            }
        case .other:
            break
        }
    }

    private func applyState(_ state: AppState, serverId: String) {
        prepareForWorkspaceDataVersion(state.workspaceDataVersion, serverId: serverId)
        reconcileOptimisticConversations(with: state.messages, serverId: serverId)
        persist { db in
            db.mergeState(serverId: serverId, state: state)
        }
        updateState(serverId: serverId) { runtime in
            runtime.agents = state.agents
            runtime.groups = state.groups
            runtime.roles = state.roles
            runtime.taskSessions = state.taskSessions
            runtime.workItems = state.workItems ?? []
            runtime.issues = state.issues ?? []
            runtime.messages = (state.messages + unresolvedOptimisticMessages(serverId: serverId))
                .sorted { $0.ts < $1.ts }
            runtime.runningAgentIdsByGroup = state.runningAgentIdsByGroup
            runtime.busyAgentIdsByGroup = state.busyAgentIdsByGroup ?? [:]
            runtime.agentErrorsByGroup = state.agentErrorsByGroup ?? [:]
            runtime.platformInstallState = state.platformInstallState ?? [:]
            runtime.enabledAgentPlatforms = state.enabledAgentPlatforms
                ?? SupportedAgentCatalog.defaultEnabledPlatforms
            runtime.hasLoadedState = true
        }
    }

    private func applyMobileState(_ state: MobileAppState, serverId: String) {
        prepareForWorkspaceDataVersion(state.workspaceDataVersion, serverId: serverId)
        updateState(serverId: serverId) { runtime in
            runtime.agents = state.agents
            runtime.groups = state.groups
            runtime.roles = state.roles
            runtime.taskSessions = state.taskSessions
            runtime.workItems = state.workItems ?? []
            runtime.issues = state.issues ?? []
            runtime.runningAgentIdsByGroup = state.runningAgentIdsByGroup
            runtime.busyAgentIdsByGroup = state.busyAgentIdsByGroup ?? [:]
            runtime.agentErrorsByGroup = state.agentErrorsByGroup ?? [:]
            runtime.platformInstallState = state.platformInstallState ?? [:]
            runtime.enabledAgentPlatforms = state.enabledAgentPlatforms
                ?? SupportedAgentCatalog.defaultEnabledPlatforms
            runtime.hasLoadedState = true
        }
    }

    private func upsertServerMessage(_ envelope: Envelope, serverId: String) {
        updateState(serverId: serverId) { state in
            if let index = state.messages.firstIndex(where: { $0.id == envelope.id }) {
                state.messages[index] = envelope
            } else if let clientMsgId = envelope.clientMsgId,
                      let index = state.messages.firstIndex(where: { $0.clientMsgId == clientMsgId }) {
                state.messages[index] = envelope
            } else {
                state.messages.append(envelope)
            }
            state.messages.sort { $0.ts < $1.ts }
        }
        reconcileOptimisticConversations(with: envelope, serverId: serverId)
        persist { db in
            db.upsertMessage(serverId: serverId, message: envelope)
        }
    }

    private func mergeServerMessages(_ messages: [Envelope], serverId: String) {
        guard !messages.isEmpty else { return }
        reconcileOptimisticConversations(with: messages, serverId: serverId)
        updateState(serverId: serverId) { state in
            for message in messages {
                if let index = state.messages.firstIndex(where: { $0.id == message.id }) {
                    state.messages[index] = message
                } else if let clientMsgId = message.clientMsgId,
                          let index = state.messages.firstIndex(where: { $0.clientMsgId == clientMsgId }) {
                    state.messages[index] = message
                } else {
                    state.messages.append(message)
                }
            }
            state.messages.sort { $0.ts < $1.ts }
        }
        persist { db in
            for message in messages {
                db.upsertMessage(serverId: serverId, message: message)
            }
        }
    }

    @discardableResult
    private func applyMessageUpdate(_ update: MessageUpdate, serverId: String) -> Envelope? {
        var updatedMessage: Envelope?
        updateState(serverId: serverId) { state in
            guard let index = state.messages.firstIndex(where: { $0.id == update.id }) else { return }
            if let body = update.body { state.messages[index].body = body }
            if let entries = update.entries { state.messages[index].entries = entries }
            if let status = update.status { state.messages[index].status = status }
            updatedMessage = state.messages[index]
        }
        if updatedMessage != nil {
            persist { db in
                db.updateMessage(serverId: serverId, update: update)
            }
        }
        return updatedMessage
    }

    private func fetchMissingMessage(update: MessageUpdate, serverId: String) {
        let key = "\(serverId):\(update.id)"
        guard missingMessageFetchTasks[key] == nil else { return }
        logRealtime("messages:update missing local id=\(update.id); fetching single message")
        missingMessageFetchTasks[key] = Task { @MainActor [weak self] in
            defer { self?.missingMessageFetchTasks[key] = nil }
            guard let self else { return }
            do {
                let context = try self.apiContext(serverId: serverId)
                let envelope = try await context.api.message(deviceId: context.config.deviceId, id: update.id)
                self.logRealtime("single message fetched id=\(envelope.id) from=\(envelope.from) body=\(envelope.body.count)")
                self.upsertServerMessage(envelope, serverId: serverId)
                self.markUnreadResultIfNeeded(for: envelope, serverId: serverId)
                if let updatedMessage = self.applyMessageUpdate(update, serverId: serverId) {
                    self.markUnreadResultIfNeeded(for: updatedMessage, serverId: serverId)
                }
            } catch {
                self.logRealtime("single message fetch failed id=\(update.id): \(error.localizedDescription)")
                self.scheduleStateRefresh(serverId: serverId, delays: [.milliseconds(250), .seconds(2)])
            }
        }
    }

    private func syncEventsSinceLastSeq(serverId: String) {
        guard eventSyncTasks[serverId] == nil else { return }
        eventSyncTasks[serverId] = Task { @MainActor [weak self] in
            defer { self?.eventSyncTasks[serverId] = nil }
            guard let self else { return }
            do {
                let context = try self.apiContext(serverId: serverId)
                let since = self.lastSeq(serverId: serverId)
                let response = try await context.api.events(deviceId: context.config.deviceId, since: since)
                if response.resetRequired {
                    await self.refreshState(serverId: serverId)
                    self.setLastSeq(response.latestSeq, serverId: serverId)
                    return
                }
                for event in response.events {
                    self.apply(event, serverId: serverId)
                }
                if response.events.isEmpty, response.latestSeq > since {
                    self.saveLastSeq(response.latestSeq, serverId: serverId)
                }
                self.updateState(serverId: serverId) { $0.lastErrorMessage = nil }
            } catch {
                self.updateState(serverId: serverId) { $0.lastErrorMessage = error.localizedDescription }
            }
        }
    }

    private func lastSeq(serverId: String) -> Int {
        UserDefaults.standard.integer(forKey: lastSeqKey(serverId: serverId))
    }

    private func saveLastSeq(_ seq: Int, serverId: String) {
        guard seq > lastSeq(serverId: serverId) else { return }
        setLastSeq(seq, serverId: serverId)
    }

    private func setLastSeq(_ seq: Int, serverId: String) {
        UserDefaults.standard.set(seq, forKey: lastSeqKey(serverId: serverId))
    }

    private func lastSeqKey(serverId: String) -> String {
        "relay.lastSeq.\(serverId)"
    }

    private func prepareForWorkspaceDataVersion(_ version: Int?, serverId: String) {
        let key = workspaceDataVersionKey(serverId: serverId)
        let storedVersion = UserDefaults.standard.object(forKey: key) as? Int
        guard WorkspaceDataVersionPolicy.shouldReset(
            storedVersion: storedVersion,
            incomingVersion: version
        ), let version else { return }

        localConversations?.removeServer(serverId: serverId)
        optimisticConversationsByServer[serverId] = nil
        scheduledStateRefreshTasks[serverId]?.cancel()
        scheduledStateRefreshTasks[serverId] = nil
        scheduledStateRefreshTokens[serverId] = nil
        eventSyncTasks[serverId]?.cancel()
        eventSyncTasks[serverId] = nil
        for taskKey in Array(missingMessageFetchTasks.keys) where taskKey.hasPrefix("\(serverId):") {
            missingMessageFetchTasks[taskKey]?.cancel()
            missingMessageFetchTasks[taskKey] = nil
        }
        UserDefaults.standard.removeObject(forKey: lastSeqKey(serverId: serverId))
        clearUnreadResultMarkers(serverId: serverId)
        updateState(serverId: serverId) { runtime in
            runtime.agents = []
            runtime.groups = []
            runtime.roles = []
            runtime.taskSessions = []
            runtime.workItems = []
            runtime.issues = []
            runtime.messages = []
            runtime.runningAgentIdsByGroup = [:]
            runtime.busyAgentIdsByGroup = [:]
            runtime.agentErrorsByGroup = [:]
            runtime.platformInstallState = [:]
            runtime.enabledAgentPlatforms = SupportedAgentCatalog.defaultEnabledPlatforms
            runtime.hasLoadedState = false
        }
        UserDefaults.standard.set(version, forKey: key)
    }

    private func workspaceDataVersionKey(serverId: String) -> String {
        "relay.workspaceDataVersion.\(serverId)"
    }

    private func clearPersistedSyncMarkers(serverId: String) {
        UserDefaults.standard.removeObject(forKey: lastSeqKey(serverId: serverId))
        UserDefaults.standard.removeObject(forKey: workspaceDataVersionKey(serverId: serverId))
    }

    // MARK: - 待查看结果

    func hasUnreadResult(serverId: String, groupId: String) -> Bool {
        unreadResultMarkers[unreadResultKey(serverId: serverId, groupId: groupId)] != nil
    }

    func beginViewingConversation(serverId: String, groupId: String) {
        activeConversationRoute = ConversationRoute(serverId: serverId, groupId: groupId)
        clearUnreadResult(serverId: serverId, groupId: groupId)
    }

    func endViewingConversation(serverId: String, groupId: String) {
        guard activeConversationRoute == ConversationRoute(serverId: serverId, groupId: groupId) else { return }
        activeConversationRoute = nil
    }

    private func markUnreadResultIfNeeded(for message: Envelope, serverId: String) {
        guard isUnreadResultMessage(message),
              let groupId = message.groupId else { return }
        markUnreadResult(serverId: serverId, groupId: groupId)
    }

    private func isUnreadResultMessage(_ message: Envelope) -> Bool {
        guard message.from != "user",
              message.from != "system",
              !message.id.hasPrefix("local-assistant-"),
              message.status != "streaming" else { return false }
        return true
    }

    private func markUnreadResultsForProcessStatusChange(_ status: ProcessStatus, serverId: String) {
        let previousState = state(for: serverId)
        let previousRunningByGroup = previousState.runningAgentIdsByGroup
        let nextRunningByGroup = status.runningAgentIdsByGroup
        let previousErrorsByGroup = previousState.agentErrorsByGroup
        let nextErrorsByGroup = status.agentErrorsByGroup ?? [:]
        let groupIds = Set(previousRunningByGroup.keys)
            .union(nextRunningByGroup.keys)
            .union(previousErrorsByGroup.keys)
            .union(nextErrorsByGroup.keys)

        for groupId in groupIds {
            let previousRunning = Set(previousRunningByGroup[groupId] ?? [])
            let nextRunning = Set(nextRunningByGroup[groupId] ?? [])
            let hasStoppedAgent = !previousRunning.subtracting(nextRunning).isEmpty

            let previousErrorAgents = Set(previousErrorsByGroup[groupId].map { Array($0.keys) } ?? [])
            let nextErrorAgents = Set(nextErrorsByGroup[groupId].map { Array($0.keys) } ?? [])
            let hasNewError = !nextErrorAgents.subtracting(previousErrorAgents).isEmpty

            if hasStoppedAgent || hasNewError {
                markUnreadResult(serverId: serverId, groupId: groupId)
            }
        }
    }

    private func markUnreadResult(serverId: String, groupId: String) {
        guard activeConversationRoute != ConversationRoute(serverId: serverId, groupId: groupId) else { return }
        let key = unreadResultKey(serverId: serverId, groupId: groupId)
        var markers = unreadResultMarkers
        markers[key] = Date().timeIntervalSince1970
        unreadResultMarkers = markers
        saveUnreadResultMarkers()
    }

    private func clearUnreadResult(serverId: String, groupId: String) {
        let key = unreadResultKey(serverId: serverId, groupId: groupId)
        guard unreadResultMarkers[key] != nil else { return }
        var markers = unreadResultMarkers
        markers.removeValue(forKey: key)
        unreadResultMarkers = markers
        saveUnreadResultMarkers()
    }

    private func clearUnreadResultMarkers(serverId: String) {
        let prefix = "\(serverId):"
        let filtered = unreadResultMarkers.filter { !$0.key.hasPrefix(prefix) }
        guard filtered.count != unreadResultMarkers.count else { return }
        unreadResultMarkers = filtered
        saveUnreadResultMarkers()
    }

    private func clearAllUnreadResultMarkers() {
        guard !unreadResultMarkers.isEmpty else { return }
        unreadResultMarkers = [:]
        saveUnreadResultMarkers()
    }

    private func unreadResultKey(serverId: String, groupId: String) -> String {
        "\(serverId):\(groupId)"
    }

    private func saveUnreadResultMarkers() {
        UserDefaults.standard.set(unreadResultMarkers, forKey: Self.unreadResultMarkersDefaultsKey)
    }

    private static let unreadResultMarkersDefaultsKey = "conversation.unreadResultMarkers.v1"

    private static func loadUnreadResultMarkers() -> [String: Double] {
        UserDefaults.standard.dictionary(forKey: unreadResultMarkersDefaultsKey) as? [String: Double] ?? [:]
    }

    // MARK: - 查询辅助

    func connectionState(serverId: String) -> SocketClient.ConnectionState {
        state(for: serverId).connection
    }

    func lastErrorMessage(serverId: String) -> String? {
        state(for: serverId).lastErrorMessage
    }

    func groups(serverId: String) -> [AgentGroup] {
        state(for: serverId).groups
    }

    func agents(serverId: String) -> [Agent] {
        state(for: serverId).agents
    }

    func roles(serverId: String) -> [Role] {
        state(for: serverId).roles
    }

    func group(serverId: String, groupId: String) -> AgentGroup? {
        state(for: serverId).groups.first { $0.id == groupId }
    }

    func agent(serverId: String, id: String) -> Agent? {
        state(for: serverId).agents.first { $0.id == id }
    }

    func agent(serverId: String, named name: String) -> Agent? {
        state(for: serverId).agents.first { $0.name == name }
    }

    func role(serverId: String, id: String) -> Role? {
        state(for: serverId).roles.first { $0.id == id }
    }

    /// 群成员去重后的 agent 列表（同一 agent 可能以多个角色入群）
    func uniqueAgents(in group: AgentGroup, serverId: String) -> [Agent] {
        var seen = Set<String>()
        return group.members.compactMap { member in
            guard !seen.contains(member.agentId),
                  let agent = agent(serverId: serverId, id: member.agentId) else { return nil }
            seen.insert(member.agentId)
            return agent
        }
    }

    func runningAgentIds(in group: AgentGroup, serverId: String) -> [String] {
        state(for: serverId).runningAgentIdsByGroup[group.id] ?? []
    }

    func busyAgentIds(in group: AgentGroup, serverId: String) -> [String] {
        state(for: serverId).busyAgentIdsByGroup[group.id] ?? []
    }

    func agentError(agent: Agent?, in group: AgentGroup, serverId: String) -> String? {
        guard let agent else { return nil }
        return state(for: serverId).agentErrorsByGroup[group.id]?[agent.id]
    }

    func streamingAgentNames(
        in group: AgentGroup,
        taskSessionId: String? = nil,
        serverId: String
    ) -> [String] {
        var seen = Set<String>()
        return streamingAgentMessages(
            in: group,
            taskSessionId: taskSessionId,
            serverId: serverId,
        ).compactMap { message in
            guard seen.insert(message.from).inserted else { return nil }
            return message.from
        }
    }

    func streamingAgentTargets(
        in group: AgentGroup,
        taskSessionId: String,
        serverId: String
    ) -> [AgentResponseTarget] {
        var responseIdsByAgentName: [String: String] = [:]
        for message in streamingAgentMessages(
            in: group,
            taskSessionId: taskSessionId,
            serverId: serverId,
        ) {
            responseIdsByAgentName[message.from] = message.clientMsgId ?? message.id
        }
        return uniqueAgents(in: group, serverId: serverId).compactMap { agent in
            guard let responseId = responseIdsByAgentName[agent.name] else { return nil }
            return AgentResponseTarget(agentId: agent.id, responseId: responseId)
        }
    }

    private func streamingAgentMessages(
        in group: AgentGroup,
        taskSessionId: String?,
        serverId: String
    ) -> [Envelope] {
        state(for: serverId).messages.filter { message in
            message.groupId == group.id
                && (taskSessionId == nil || message.taskSessionId == taskSessionId)
                && message.isStreaming
                && message.from != "user"
                && message.from != "system"
        }
    }

    func agentPresence(
        agent: Agent?,
        in group: AgentGroup,
        serverId: String,
        initializingAgentIds: Set<String> = []
    ) -> AgentPresenceState {
        guard let agent else { return .offline }
        let resolved = AgentPresencePolicy.resolve(
            hasError: agentError(agent: agent, in: group, serverId: serverId) != nil,
            isInitializing: initializingAgentIds.contains(agent.id),
            isHostBusy: busyAgentIds(in: group, serverId: serverId).contains(agent.id),
            isStreaming: streamingAgentNames(in: group, serverId: serverId).contains(agent.name),
            isRunning: runningAgentIds(in: group, serverId: serverId).contains(agent.id)
        )
        switch resolved {
        case .error: return .error
        case .busy: return .busy
        case .online: return .online
        case .offline: return .offline
        }
    }

    func roleName(of agentName: String, in group: AgentGroup, serverId: String) -> String? {
        guard let agent = agent(serverId: serverId, named: agentName) else { return nil }
        for member in group.members where member.agentId == agent.id {
            if let roleId = member.roleId, let role = role(serverId: serverId, id: roleId) {
                return role.name
            }
        }
        return nil
    }

    func sessions(for group: AgentGroup, serverId: String) -> [TaskSession] {
        state(for: serverId).taskSessions
            .filter { $0.groupId == group.id }
            .sorted { $0.createdAt > $1.createdAt }
    }

    func session(serverId: String, id: String?) -> TaskSession? {
        guard let id else { return nil }
        return state(for: serverId).taskSessions.first { $0.id == id }
    }

    func activeMission(for group: AgentGroup, serverId: String) -> TaskSession? {
        guard !group.isDirectChat else { return nil }
        return session(serverId: serverId, id: group.activeTaskSessionId)
    }

    func workItems(missionId: String, serverId: String) -> [WorkItem] {
        state(for: serverId).workItems
            .filter { $0.taskSessionId == missionId }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func issues(missionId: String, serverId: String) -> [CollaborationIssue] {
        state(for: serverId).issues
            .filter { $0.missionId == missionId }
            .sorted { $0.createdAt < $1.createdAt }
    }

    func messagesFor(serverId: String, groupId: String, taskSessionId: String?) -> [Envelope] {
        state(for: serverId).messages
            .filter { $0.groupId == groupId && $0.taskSessionId == taskSessionId }
            .sorted { $0.ts < $1.ts }
    }

    func loadRecentMessages(serverId: String, groupId: String, taskSessionId: String?, limit: Int = 50) async {
        do {
            let context = try apiContext(serverId: serverId)
            let response = try await context.api.groupMessages(
                deviceId: context.config.deviceId,
                groupId: groupId,
                taskSessionId: taskSessionId,
                limit: limit
            )
            mergeServerMessages(response.messages, serverId: serverId)
            updateState(serverId: serverId) { $0.lastErrorMessage = nil }
        } catch {
            updateState(serverId: serverId) { $0.lastErrorMessage = error.localizedDescription }
        }
    }

    func lastMessage(in group: AgentGroup, serverId: String) -> Envelope? {
        state(for: serverId).messages.last { $0.groupId == group.id }
    }

    func availableSupportedAgents(serverId: String) -> [SupportedAgent] {
        let state = state(for: serverId)
        return SupportedAgentCatalog.enabled(platforms: state.enabledAgentPlatforms).filter { supported in
            state.platformInstallState[supported.platform] == true
                || state.agents.contains { $0.platform == supported.platform }
        }
    }

    func groupUsingWorkingDirectory(
        _ directory: String,
        serverId: String,
        groupType: String? = nil
    ) -> AgentGroup? {
        let normalized = normalizeDirectory(directory)
        guard !normalized.isEmpty else { return nil }
        return groups(serverId: serverId).first { group in
            if let groupType, group.groupType != groupType { return false }
            guard let workingDirectory = group.workingDirectory else { return false }
            return normalizeDirectory(workingDirectory) == normalized
        }
    }

    // MARK: - 操作

    func sendMessage(text: String, group: AgentGroup, taskSessionId: String?, serverId: String) async throws {
        let unique = uniqueAgents(in: group, serverId: serverId)
        let running = runningAgentIds(in: group, serverId: serverId)

        var mentioned: [Agent] = []
        var isAll = false
        if text.contains("@所有人") {
            mentioned = unique
            isAll = true
        } else {
            mentioned = unique.filter { text.contains("@\($0.name)") }
        }

        let mentionedRoles = Set(group.members.compactMap { member -> String? in
            guard let roleId = member.roleId,
                  let role = role(serverId: serverId, id: roleId),
                  text.contains("@\(role.name)") else { return nil }
            return role.name
        })
        let targetIds: [String]
        if group.isDirectChat || isAll {
            targetIds = unique.map(\.id).filter { running.contains($0) }
        } else if !mentioned.isEmpty {
            targetIds = mentioned.map(\.id)
        } else {
            // 协作群无 @ 默认由服务端路由到当前阶段 Leader；@角色也由任务 Leader 快照裁决。
            targetIds = []
        }
        let displayTo: String
        if isAll {
            displayTo = "所有人"
        } else if !mentioned.isEmpty {
            displayTo = mentioned.map(\.name).joined(separator: ", ")
        } else if !mentionedRoles.isEmpty {
            displayTo = mentionedRoles.sorted().joined(separator: ", ")
        } else {
            displayTo = ""
        }

        try await sendMessage(
            text: text,
            group: group,
            taskSessionId: taskSessionId,
            to: displayTo,
            agentIds: targetIds,
            serverId: serverId,
        )
    }

    func sendMessage(
        text: String,
        group: AgentGroup,
        taskSessionId: String?,
        to: String,
        agentIds: [String],
        serverId: String,
    ) async throws {
        let context = try apiContext(serverId: serverId)
        let startedAt = Date().timeIntervalSince1970
        let clientMsgId = "ios-\(UUID().uuidString)"
        logRealtime("send start group=\(group.id) task=\(taskSessionId ?? "lobby") agents=\(agentIds.count)")
        let optimisticId = appendOptimisticConversation(
            text: text,
            group: group,
            taskSessionId: taskSessionId,
            to: to,
            agentIds: agentIds,
            serverId: serverId,
            clientMsgId: clientMsgId,
        )
        do {
            try await context.api.sendMessage(
                deviceId: context.config.deviceId,
                body: text,
                groupId: group.id,
                taskSessionId: taskSessionId,
                to: to,
                agentIds: agentIds,
                clientMsgId: clientMsgId,
            )
            let elapsedMs = Int((Date().timeIntervalSince1970 - startedAt) * 1000)
            logRealtime("send POST completed in \(elapsedMs)ms")
            if connectionState(serverId: serverId) != .connected {
                syncEventsSinceLastSeq(serverId: serverId)
            }
        } catch {
            removeOptimisticConversation(id: optimisticId, serverId: serverId)
            throw error
        }
    }

    func interruptAgents(
        in group: AgentGroup,
        taskSessionId: String,
        targets: [AgentResponseTarget],
        serverId: String
    ) async throws {
        guard !targets.isEmpty else { return }

        let context = try apiContext(serverId: serverId)
        let response = try await context.api.interruptAgents(
            deviceId: context.config.deviceId,
            groupId: group.id,
            taskSessionId: taskSessionId,
            targets: targets,
        )

        let requestedTargetsByAgentId = Dictionary(
            uniqueKeysWithValues: targets.map { ($0.agentId, $0) }
        )
        let interruptedTargets = response.interruptedAgentIds.compactMap {
            requestedTargetsByAgentId[$0]
        }
        finishInterruptedResponses(
            groupId: group.id,
            taskSessionId: taskSessionId,
            targets: interruptedTargets,
            serverId: serverId,
        )
    }

    private func appendOptimisticConversation(
        text: String,
        group: AgentGroup,
        taskSessionId: String?,
        to: String,
        agentIds: [String],
        serverId: String,
        clientMsgId: String,
    ) -> String {
        let now = Date().timeIntervalSince1970
        let runningAgentIds = Set(state(for: serverId).runningAgentIdsByGroup[group.id] ?? [])
        let pendingAssistantMessages = agentIds
            .filter { runningAgentIds.contains($0) }
            .compactMap { agent(serverId: serverId, id: $0) }
            .enumerated()
            .map { index, agent in
                Envelope(
                    id: "local-assistant-\(UUID().uuidString)",
                    from: agent.name,
                    to: "user",
                    body: "",
                    ts: now + 0.001 + Double(index) * 0.001,
                    groupId: group.id,
                    taskSessionId: taskSessionId,
                    clientMsgId: clientMsgId,
                    entries: nil,
                    status: "streaming",
                )
            }
        let userMessage = Envelope(
            id: "local-user-\(UUID().uuidString)",
            from: "user",
            to: to,
            body: text,
            ts: now,
            groupId: group.id,
            taskSessionId: taskSessionId,
            clientMsgId: clientMsgId,
            entries: nil,
            status: nil,
        )
        let optimistic = OptimisticConversation(
            userMessage: userMessage,
            clientMsgId: clientMsgId,
            pendingAssistantMessages: pendingAssistantMessages,
        )
        optimisticConversationsByServer[serverId, default: []].append(optimistic)
        updateState(serverId: serverId) { state in
            state.messages.append(userMessage)
            state.messages.append(contentsOf: pendingAssistantMessages)
            state.messages.sort { $0.ts < $1.ts }
        }
        return optimistic.id
    }

    private func removeOptimisticConversation(id: String, serverId: String) {
        guard var optimisticConversations = optimisticConversationsByServer[serverId],
              let conversation = optimisticConversations.first(where: { $0.id == id }) else { return }
        optimisticConversations.removeAll { $0.id == id }
        optimisticConversationsByServer[serverId] = optimisticConversations
        let optimisticMessageIds = Set(conversation.unresolvedMessages.map(\.id))
        updateState(serverId: serverId) { state in
            state.messages.removeAll { optimisticMessageIds.contains($0.id) }
        }
    }

    private func finishInterruptedResponses(
        groupId: String,
        taskSessionId: String,
        targets: [AgentResponseTarget],
        serverId: String
    ) {
        let responseIdsByAgentName = Dictionary(uniqueKeysWithValues: targets.compactMap { target in
            agent(serverId: serverId, id: target.agentId).map { ($0.name, target.responseId) }
        })
        guard !responseIdsByAgentName.isEmpty else { return }

        if var optimisticConversations = optimisticConversationsByServer[serverId],
           !optimisticConversations.isEmpty {
            let original = optimisticConversations
            for index in optimisticConversations.indices {
                guard optimisticConversations[index].groupId == groupId,
                      optimisticConversations[index].taskSessionId == taskSessionId else { continue }
                optimisticConversations[index].pendingAssistantMessages.removeAll {
                    responseIdsByAgentName[$0.from] == ($0.clientMsgId ?? $0.id)
                }
            }
            optimisticConversations.removeAll {
                $0.userConfirmed && $0.pendingAssistantMessages.isEmpty
            }
            optimisticConversationsByServer[serverId] = optimisticConversations
            removeResolvedOptimisticMessages(
                previous: original,
                current: optimisticConversations,
                serverId: serverId,
            )
            syncUnresolvedOptimisticMessages(optimisticConversations, serverId: serverId)
        }

        var completedUpdates: [MessageUpdate] = []
        updateState(serverId: serverId) { state in
            for index in state.messages.indices {
                guard state.messages[index].groupId == groupId,
                      state.messages[index].taskSessionId == taskSessionId,
                      state.messages[index].isStreaming,
                      responseIdsByAgentName[state.messages[index].from]
                        == (state.messages[index].clientMsgId ?? state.messages[index].id) else { continue }
                state.messages[index].status = "complete"
                if !state.messages[index].id.hasPrefix("local-assistant-") {
                    completedUpdates.append(MessageUpdate(
                        id: state.messages[index].id,
                        body: nil,
                        entries: nil,
                        status: "complete",
                        clientMsgId: nil,
                    ))
                }
            }
        }
        persist { db in
            for update in completedUpdates {
                db.updateMessage(serverId: serverId, update: update)
            }
        }
    }

    private func reconcileOptimisticConversations(with envelope: Envelope, serverId: String) {
        guard var optimisticConversations = optimisticConversationsByServer[serverId],
              !optimisticConversations.isEmpty else { return }
        let original = optimisticConversations
        for index in optimisticConversations.indices {
            var conversation = optimisticConversations[index]
            if isServerUserConfirmation(envelope, for: conversation) {
                conversation.userConfirmed = true
                reanchorPendingAssistantMessages(&conversation, after: envelope)
            }
            let matchingConversation = conversation
            conversation.pendingAssistantMessages.removeAll {
                isServerAssistantResponse(envelope, replacing: $0, for: matchingConversation)
            }
            optimisticConversations[index] = conversation
        }
        optimisticConversations.removeAll {
            $0.userConfirmed && $0.pendingAssistantMessages.isEmpty
        }
        optimisticConversationsByServer[serverId] = optimisticConversations
        removeResolvedOptimisticMessages(previous: original, current: optimisticConversations, serverId: serverId)
        syncUnresolvedOptimisticMessages(optimisticConversations, serverId: serverId)
    }

    private func reconcileOptimisticConversations(with serverMessages: [Envelope], serverId: String) {
        guard var optimisticConversations = optimisticConversationsByServer[serverId],
              !optimisticConversations.isEmpty else { return }
        let original = optimisticConversations
        for index in optimisticConversations.indices {
            var conversation = optimisticConversations[index]
            if let userConfirmation = serverMessages.first(where: { isServerUserConfirmation($0, for: conversation) }) {
                conversation.userConfirmed = true
                reanchorPendingAssistantMessages(&conversation, after: userConfirmation)
            }
            let matchingConversation = conversation
            conversation.pendingAssistantMessages.removeAll { pending in
                serverMessages.contains {
                    isServerAssistantResponse($0, replacing: pending, for: matchingConversation)
                }
            }
            optimisticConversations[index] = conversation
        }
        optimisticConversations.removeAll {
            $0.userConfirmed && $0.pendingAssistantMessages.isEmpty
        }
        optimisticConversationsByServer[serverId] = optimisticConversations
        removeResolvedOptimisticMessages(previous: original, current: optimisticConversations, serverId: serverId)
        syncUnresolvedOptimisticMessages(optimisticConversations, serverId: serverId)
    }

    private func unresolvedOptimisticMessages(serverId: String) -> [Envelope] {
        optimisticConversationsByServer[serverId, default: []].flatMap(\.unresolvedMessages)
    }

    private func removeResolvedOptimisticMessages(
        previous: [OptimisticConversation],
        current: [OptimisticConversation],
        serverId: String,
    ) {
        let previousMessageIds = Set(previous.flatMap(\.unresolvedMessages).map(\.id))
        let currentMessageIds = Set(current.flatMap(\.unresolvedMessages).map(\.id))
        let idsToRemove = previousMessageIds.subtracting(currentMessageIds)

        guard !idsToRemove.isEmpty else { return }
        updateState(serverId: serverId) { state in
            state.messages.removeAll { idsToRemove.contains($0.id) }
        }
    }

    private func syncUnresolvedOptimisticMessages(_ conversations: [OptimisticConversation], serverId: String) {
        let unresolvedById = Dictionary(
            uniqueKeysWithValues: conversations
                .flatMap(\.unresolvedMessages)
                .map { ($0.id, $0) }
        )
        guard !unresolvedById.isEmpty else { return }
        updateState(serverId: serverId) { state in
            for index in state.messages.indices {
                guard let replacement = unresolvedById[state.messages[index].id] else { continue }
                state.messages[index] = replacement
            }
            state.messages.sort { $0.ts < $1.ts }
        }
    }

    private func reanchorPendingAssistantMessages(_ conversation: inout OptimisticConversation, after userMessage: Envelope) {
        guard !conversation.pendingAssistantMessages.isEmpty else { return }
        let baseTime = max(userMessage.ts, conversation.createdAt)
        conversation.pendingAssistantMessages = conversation.pendingAssistantMessages.enumerated().map { index, pending in
            Envelope(
                id: pending.id,
                from: pending.from,
                to: pending.to,
                body: pending.body,
                ts: baseTime + 0.001 + Double(index) * 0.001,
                groupId: pending.groupId,
                taskSessionId: pending.taskSessionId,
                clientMsgId: pending.clientMsgId,
                entries: pending.entries,
                status: pending.status,
            )
        }
    }

    private func isServerUserConfirmation(_ envelope: Envelope, for conversation: OptimisticConversation) -> Bool {
        if let clientMsgId = envelope.clientMsgId, clientMsgId == conversation.clientMsgId {
            return true
        }
        return envelope.id != conversation.userMessage.id
            && envelope.from == "user"
            && envelope.body == conversation.userMessage.body
            && envelope.groupId == conversation.groupId
            && envelope.taskSessionId == conversation.taskSessionId
            && envelope.ts >= conversation.createdAt - 5
    }

    private func isServerAssistantResponse(
        _ envelope: Envelope,
        replacing pending: Envelope,
        for conversation: OptimisticConversation
    ) -> Bool {
        envelope.id != pending.id
            && envelope.from == pending.from
            && envelope.from != "user"
            && envelope.from != "system"
            && envelope.groupId == conversation.groupId
            && envelope.taskSessionId == conversation.taskSessionId
            && envelope.ts >= conversation.createdAt - 5
    }

    private func scheduleStateRefresh(
        serverId: String,
        delays: [Duration] = [.seconds(1), .seconds(4), .seconds(12)]
    ) {
        scheduledStateRefreshTasks[serverId]?.cancel()
        let token = UUID()
        scheduledStateRefreshTokens[serverId] = token
        scheduledStateRefreshTasks[serverId] = Task { @MainActor [weak self] in
            defer {
                if self?.scheduledStateRefreshTokens[serverId] == token {
                    self?.scheduledStateRefreshTasks[serverId] = nil
                    self?.scheduledStateRefreshTokens[serverId] = nil
                }
            }
            for delay in delays {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
                await self?.refreshState(serverId: serverId)
            }
        }
    }

    func listSkills(serverId: String, refresh: Bool = false) async throws -> [SkillListItem] {
        let context = try apiContext(serverId: serverId)
        return try await context.api.skills(deviceId: context.config.deviceId, refresh: refresh)
    }

    func listCliCommands(serverId: String, platform: String) async throws -> [CliCommandItem] {
        let context = try apiContext(serverId: serverId)
        return try await context.api.cliCommands(deviceId: context.config.deviceId, platform: platform)
    }

    func startModelPicker(
        serverId: String,
        groupId: String,
        agentId: String,
        mode: String = "model"
    ) async throws -> ModelPickerSnapshot {
        let context = try apiContext(serverId: serverId)
        return try await context.api.startModelPicker(
            deviceId: context.config.deviceId,
            agentId: agentId,
            groupId: groupId,
            mode: mode,
        )
    }

    func modelPicker(serverId: String, groupId: String, agentId: String) async throws -> ModelPickerSnapshot {
        let context = try apiContext(serverId: serverId)
        return try await context.api.modelPicker(
            deviceId: context.config.deviceId,
            agentId: agentId,
            groupId: groupId,
        )
    }

    func chooseModel(
        serverId: String,
        groupId: String,
        agentId: String,
        optionIndex: Int,
    ) async throws -> ModelPickerSnapshot {
        let context = try apiContext(serverId: serverId)
        return try await context.api.chooseModel(
            deviceId: context.config.deviceId,
            agentId: agentId,
            groupId: groupId,
            optionIndex: optionIndex,
        )
    }

    func sendModelPickerInput(
        serverId: String,
        groupId: String,
        agentId: String,
        action: ModelPickerInputAction,
    ) async throws -> ModelPickerSnapshot {
        let context = try apiContext(serverId: serverId)
        return try await context.api.sendModelPickerInput(
            deviceId: context.config.deviceId,
            agentId: agentId,
            groupId: groupId,
            action: action,
        )
    }

    func loadMissionDetail(groupId: String, missionId: String, serverId: String) async throws {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.mission(
            deviceId: context.config.deviceId,
            groupId: groupId,
            missionId: missionId,
        )
        applyMissionMutation(
            response.mission,
            workItems: response.workItems,
            issues: response.issues,
            serverId: serverId,
        )
    }

    func createMission(
        group: AgentGroup,
        title: String,
        objective: String,
        template: String,
        acceptanceCriteria: [String],
        qualityPolicy: MissionQualityPolicy,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.createMission(
            deviceId: context.config.deviceId,
            groupId: group.id,
            title: title,
            objective: objective,
            template: template,
            acceptanceCriteria: acceptanceCriteria,
            qualityPolicy: qualityPolicy,
        )
        applyMissionMutation(response.mission, serverId: serverId)
        await refreshState(serverId: serverId)
        return response.mission
    }

    func previewMission(
        group: AgentGroup,
        goal: String,
        serverId: String,
    ) async throws -> GeneratedMissionDraft {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.previewMission(
            deviceId: context.config.deviceId,
            groupId: group.id,
            goal: goal,
        )
        return response.draft
    }

    func updateMissionCharter(
        group: AgentGroup,
        mission: TaskSession,
        title: String,
        objective: String,
        acceptanceCriteria: [String],
        qualityPolicy: MissionQualityPolicy,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.updateMissionCharter(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            title: title,
            objective: objective,
            acceptanceCriteria: acceptanceCriteria,
            qualityPolicy: qualityPolicy,
        )
        applyMissionMutation(response.mission, serverId: serverId)
        return response.mission
    }

    func updateMissionPlan(
        group: AgentGroup,
        mission: TaskSession,
        roleIds: [String],
        autoMergeAuthorized: Bool,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.updateMissionPlan(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            roleIds: roleIds,
            autoMergeAuthorized: autoMergeAuthorized,
        )
        applyMissionMutation(response.mission, serverId: serverId)
        return response.mission
    }

    func resolveMissingRole(
        group: AgentGroup,
        mission: TaskSession,
        roleId: String,
        resolution: String,
        note: String,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.resolveMissingRole(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            roleId: roleId,
            resolution: resolution,
            note: note,
        )
        applyMissionMutation(response.mission, serverId: serverId)
        return response.mission
    }

    func startMission(group: AgentGroup, mission: TaskSession, serverId: String) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.startMission(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 } + (response.collaborationWorkItems ?? []),
            serverId: serverId,
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    func missionOwnerAction(
        group: AgentGroup,
        mission: TaskSession,
        action: String,
        note: String,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.missionOwnerAction(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            action: action,
            note: note,
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 } + (response.collaborationWorkItems ?? []),
            serverId: serverId,
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    func acceptMissionRisk(
        group: AgentGroup,
        mission: TaskSession,
        issueIds: [String],
        note: String,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.acceptMissionRisk(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            issueIds: issueIds,
            note: note,
        )
        applyMissionMutation(response.mission, serverId: serverId)
        await refreshState(serverId: serverId)
        return response.mission
    }

    func extendMissionRework(
        group: AgentGroup,
        mission: TaskSession,
        additionalRounds: Int,
        note: String,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.extendMissionRework(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            additionalRounds: additionalRounds,
            note: note,
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 },
            serverId: serverId,
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    func reassignMissionWorkItem(
        group: AgentGroup,
        mission: TaskSession,
        workItem: WorkItem,
        targetMemberId: String,
        note: String,
        serverId: String,
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.reassignMissionWorkItem(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            workItemId: workItem.id,
            targetMemberId: targetMemberId,
            note: note,
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 },
            serverId: serverId,
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    func resolveMissionExternalChanges(
        group: AgentGroup,
        mission: TaskSession,
        decision: String,
        note: String,
        serverId: String
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.resolveMissionExternalChanges(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            decision: decision,
            note: note
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 } + (response.collaborationWorkItems ?? []),
            serverId: serverId
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    func importMissionExternalImplementation(
        group: AgentGroup,
        mission: TaskSession,
        note: String,
        serverId: String
    ) async throws -> TaskSession {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.importMissionExternalImplementation(
            deviceId: context.config.deviceId,
            groupId: group.id,
            missionId: mission.id,
            note: note
        )
        applyMissionMutation(
            response.mission,
            workItems: [response.workItem].compactMap { $0 } + (response.collaborationWorkItems ?? []),
            serverId: serverId
        )
        await refreshState(serverId: serverId)
        return response.mission
    }

    private func applyMissionMutation(
        _ mission: TaskSession,
        workItems: [WorkItem] = [],
        issues: [CollaborationIssue] = [],
        serverId: String,
    ) {
        updateState(serverId: serverId) { runtime in
            if let index = runtime.taskSessions.firstIndex(where: { $0.id == mission.id }) {
                runtime.taskSessions[index] = mission
            } else {
                runtime.taskSessions.append(mission)
            }
            for workItem in workItems {
                if let index = runtime.workItems.firstIndex(where: { $0.id == workItem.id }) {
                    runtime.workItems[index] = workItem
                } else {
                    runtime.workItems.append(workItem)
                }
            }
            for issue in issues {
                if let index = runtime.issues.firstIndex(where: { $0.id == issue.id && $0.missionId == issue.missionId }) {
                    runtime.issues[index] = issue
                } else {
                    runtime.issues.append(issue)
                }
            }
        }
        localConversations?.upsertTaskSession(serverId: serverId, session: mission)
    }

    func archiveGroup(_ group: AgentGroup, serverId: String) async throws {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.archiveGroup(deviceId: context.config.deviceId, groupId: group.id)
        localConversations?.upsertGroup(serverId: serverId, group: response.group)
        await refreshState(serverId: serverId)
    }

    func unarchiveGroup(_ group: AgentGroup, serverId: String) async throws {
        let context = try apiContext(serverId: serverId)
        let response = try await context.api.unarchiveGroup(deviceId: context.config.deviceId, groupId: group.id)
        localConversations?.upsertGroup(serverId: serverId, group: response.group)
        await refreshState(serverId: serverId)
    }

    func deleteGroup(_ group: AgentGroup, serverId: String) async throws {
        let context = try apiContext(serverId: serverId)
        try await context.api.deleteGroup(deviceId: context.config.deviceId, groupId: group.id)
        localConversations?.removeGroup(serverId: serverId, groupId: group.id)
        await refreshState(serverId: serverId)
    }

    func deleteAgent(serverId: String, agentId: String, refresh: Bool = true) async throws {
        let context = try apiContext(serverId: serverId)
        try await context.api.deleteAgent(deviceId: context.config.deviceId, agentId: agentId)
        if refresh {
            await refreshState(serverId: serverId)
        }
    }

    func agentStartupPrompts(serverId: String, groupId: String) async throws -> [AgentStartupPrompt] {
        let context = try apiContext(serverId: serverId)
        do {
            return try await context.api.agentStartupPrompts(deviceId: context.config.deviceId, groupId: groupId)
        } catch let error as RelayAPIError where error.statusCode == 404 {
            return try await context.api.workspaceTrustPrompts(deviceId: context.config.deviceId, groupId: groupId)
        }
    }

    func resolveAgentStartupPrompts(
        serverId: String,
        groupId: String,
        action: AgentStartupPromptAction,
        agentIds: [String]? = nil,
        expectedPrompts: [AgentStartupPrompt] = [],
    ) async throws -> AgentStartupPromptResolutionResponse {
        let context = try apiContext(serverId: serverId)
        let expectedPromptIDs = Set(expectedPrompts.map(\.id))

        // 创建流程、会话页和全局 Sheet 可能同时观察到同一条提示。
        // 操作前先复核；若提示已由另一入口处理，则按幂等成功返回，避免再次向 CLI 写按键。
        if !expectedPromptIDs.isEmpty,
           let currentPrompts = try? await agentStartupPrompts(serverId: serverId, groupId: groupId),
           AgentStartupPromptResolutionPolicy.isResolved(
               resolvedCount: 0,
               expectedPromptIDs: expectedPromptIDs,
               remainingPromptIDs: Set(currentPrompts.map(\.id))
           ) {
            return AgentStartupPromptResolutionResponse(ok: true, resolved: 0, prompts: currentPrompts)
        }

        let response: AgentStartupPromptResolutionResponse
        do {
            response = try await context.api.resolveAgentStartupPrompts(
                deviceId: context.config.deviceId,
                groupId: groupId,
                action: action,
                agentIds: agentIds,
            )
        } catch let error as RelayAPIError where error.statusCode == 404 {
            // 旧 Host 只有 workspace-trust API。先复核目标仍存在，尤其避免过期的拒绝操作
            // 把已经进入会话的旧版 Claude Code 错误地下线。
            let legacyPrompts = try await context.api.workspaceTrustPrompts(
                deviceId: context.config.deviceId,
                groupId: groupId
            )
            if AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 0,
                expectedPromptIDs: expectedPromptIDs,
                remainingPromptIDs: Set(legacyPrompts.map(\.id))
            ) {
                return AgentStartupPromptResolutionResponse(ok: true, resolved: 0, prompts: legacyPrompts)
            }

            switch action {
            case .accept:
                response = try await context.api.confirmWorkspaceTrust(
                    deviceId: context.config.deviceId,
                    groupId: groupId,
                    agentIds: agentIds
                )
            case .decline:
                guard let group = group(serverId: serverId, groupId: groupId) else { throw error }
                let requestedAgentIds = Set(agentIds ?? group.members.map(\.agentId))
                var seenMemberIds = Set<String>()
                let matchingMembers = group.members.filter { member in
                    requestedAgentIds.contains(member.agentId) && seenMemberIds.insert(member.id).inserted
                }
                guard !matchingMembers.isEmpty else { throw error }
                for member in matchingMembers {
                    try await context.api.goOffline(
                        deviceId: context.config.deviceId,
                        groupId: groupId,
                        memberId: member.id
                    )
                }
                let remaining = (try? await context.api.workspaceTrustPrompts(
                    deviceId: context.config.deviceId,
                    groupId: groupId
                )) ?? []
                response = AgentStartupPromptResolutionResponse(
                    ok: true,
                    resolved: matchingMembers.count,
                    prompts: remaining
                )
            }
        }
        guard AgentStartupPromptResolutionPolicy.isResolved(
            resolvedCount: response.resolved,
            expectedPromptIDs: expectedPromptIDs,
            remainingPromptIDs: Set(response.prompts.map(\.id))
        ) else {
            throw RelayAPIError(message: "Claude Code 启动确认未生效，请重试")
        }
        await refreshState(serverId: serverId)
        return response
    }

    func goOnline(member: GroupMember, in group: AgentGroup, serverId: String) async throws {
        let context = try apiContext(serverId: serverId)
        try await context.api.goOnline(deviceId: context.config.deviceId, groupId: group.id, memberId: member.id)
        await refreshState(serverId: serverId)
    }

    func listDirectories(serverId: String, path: String?) async throws -> DirectoryListResponse {
        let context = try apiContext(serverId: serverId)
        return try await context.api.directories(deviceId: context.config.deviceId, path: path)
    }

    func listGroupFiles(serverId: String, groupId: String, subpath: String? = nil) async throws -> WorkspaceFileListResponse {
        let context = try apiContext(serverId: serverId)
        return try await context.api.groupFiles(deviceId: context.config.deviceId, groupId: groupId, subpath: subpath)
    }

    func readGroupFile(serverId: String, groupId: String, path: String) async throws -> WorkspaceFileContentResponse {
        let context = try apiContext(serverId: serverId)
        return try await context.api.groupFileContent(deviceId: context.config.deviceId, groupId: groupId, path: path)
    }

    func importWorkspaceFiles(
        serverId: String,
        groupId: String,
        files: [WorkspaceUploadFile],
        targetSubpath: String?,
    ) async throws -> WorkspaceImportResponse {
        let context = try apiContext(serverId: serverId)
        return try await context.api.importWorkspaceFiles(
            deviceId: context.config.deviceId,
            groupId: groupId,
            files: files,
            targetSubpath: targetSubpath,
        )
    }

    func gitStatus(serverId: String, groupId: String) async throws -> GitWorkspaceStatus {
        let context = try apiContext(serverId: serverId)
        return try await context.api.gitStatus(deviceId: context.config.deviceId, groupId: groupId)
    }

    func createGroup(
        serverId: String,
        name: String,
        workingDirectory: String,
        members: [(platform: String, roleId: String?, isLeader: Bool)],
        groupType: String = "collaboration",
    ) async throws -> AgentGroup {
        let context = try apiContext(serverId: serverId)
        let directory = workingDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        let groupName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !directory.isEmpty else {
            throw RelayAPIError(message: "请选择 Mac 文件夹")
        }
        guard !groupName.isEmpty else {
            throw RelayAPIError(message: "群名称不能为空")
        }
        guard !members.isEmpty else {
            throw RelayAPIError(message: "请选择至少一个 AI")
        }
        if groupType == "direct", members.count != 1 {
            throw RelayAPIError(message: "单聊只能选择一个 AI")
        }
        if groupType != "direct", members.count < 2 {
            throw RelayAPIError(message: "协作群至少需要两个 AI；一个 AI 请使用单聊")
        }
        if members.filter({ $0.roleId == "role-committer" }).count > 1 {
            throw RelayAPIError(message: "每个协作群最多只能有一个提交专员")
        }
        if groupType != "direct" {
            for roleId in Set(members.compactMap(\.roleId)) {
                let sameRole = members.filter { $0.roleId == roleId }
                let leaders = sameRole.filter(\.isLeader)
                if sameRole.count > 1, leaders.count != 1 {
                    throw RelayAPIError(message: "同角色多人时必须明确指定一个 Leader")
                }
            }
            if let existing = groupUsingWorkingDirectory(
                directory,
                serverId: serverId,
                groupType: "collaboration"
            ) {
                throw RelayAPIError(message: "该工作目录已被协作群「\(existing.name)」使用")
            }
        }
        let colors = ["blue", "green", "orange", "purple", "pink", "red", "teal", "indigo", "mint", "cyan"]
        var createdMembers: [(agentId: String, roleId: String?, isLeader: Bool)] = []
        for (index, member) in members.enumerated() {
            let agent = try await context.api.addAgent(
                deviceId: context.config.deviceId,
                platform: member.platform,
                avatarColor: colors[index % colors.count],
            )
            createdMembers.append((agentId: agent.id, roleId: member.roleId, isLeader: member.isLeader))
        }

        var roleLeaders: [String: String] = [:]
        if groupType != "direct" {
            for roleId in Set(createdMembers.compactMap(\.roleId)) {
                let sameRole = createdMembers.filter { $0.roleId == roleId }
                let leader = sameRole.first(where: \.isLeader) ?? sameRole.first
                if let leader {
                    roleLeaders[roleId] = leader.agentId
                }
            }
        }

        let group = try await context.api.createGroup(
            deviceId: context.config.deviceId,
            name: groupName,
            ownerName: "群主",
            members: createdMembers.map { (agentId: $0.agentId, roleId: $0.roleId) },
            workingDirectory: directory,
            groupType: groupType,
            roleLeaders: roleLeaders,
        )
        localConversations?.trackGroup(serverId: serverId, group: group)
        await refreshState(serverId: serverId)
        return group
    }

    private func normalizeDirectory(_ directory: String) -> String {
        var value = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.count > 1 && value.hasSuffix("/") {
            value.removeLast()
        }
        return value
    }
}
