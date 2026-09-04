import Foundation

/// WebSocket 客户端：连接中继的 /d/{deviceId}/ws 隧道，
/// 接收服务端推送事件，断线后指数退避自动重连。
@MainActor
final class SocketClient: NSObject, URLSessionWebSocketDelegate {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case retrying(attempt: Int)
        case waitingForManualRetry
        case connected
    }

    var onEvent: ((ServerEventEnvelope) -> Void)?
    var onStateChange: ((ConnectionState) -> Void)?
    var onAuthorizationRevoked: (() -> Void)?

    private(set) var state: ConnectionState = .disconnected {
        didSet {
            if oldValue != state { onStateChange?(state) }
        }
    }

    private var task: URLSessionWebSocketTask?
    private var request: URLRequest?
    private var wantsConnection = false
    private var reconnectAttempts = 0
    /// 世代号：connect/disconnect 之后旧连接的回调全部失效
    private var generation = 0
    private var reconnectTask: Task<Void, Never>?
    private var delayedDisconnectTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private static let maxReconnectAttempts = 12
    private static let heartbeatIntervalSeconds = 20
    private static let delayedDisconnectGraceSeconds = 8
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func connect(request: URLRequest, force: Bool = false) {
        if !force, wantsConnection, isSameRequest(request), (state == .connecting || state == .connected) {
            return
        }

        reconnectTask?.cancel()
        delayedDisconnectTask?.cancel()
        heartbeatTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        self.request = request
        wantsConnection = true
        generation += 1
        reconnectAttempts = 0
        openSocket(generation: generation)
    }

    func disconnect(publishState: Bool = true) {
        wantsConnection = false
        generation += 1
        reconnectTask?.cancel()
        delayedDisconnectTask?.cancel()
        heartbeatTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if publishState {
            state = .disconnected
        }
    }

    private func openSocket(generation gen: Int) {
        guard wantsConnection, gen == generation, let request else { return }
        if state != .connected && state != .retrying(attempt: reconnectAttempts) {
            state = .connecting
        }

        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()
        receiveNext(task, generation: gen)
    }

    private func receiveNext(_ task: URLSessionWebSocketTask, generation gen: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation, self.task === task else { return }
                switch result {
                case .failure:
                    self.handleDrop(task, generation: gen, shouldCancel: false)
                case .success(let message):
                    self.delayedDisconnectTask?.cancel()
                    self.state = .connected
                    self.reconnectAttempts = 0
                    if case .string(let text) = message, let event = ServerEventEnvelope.decode(from: text) {
                        self.onEvent?(event)
                    }
                    self.receiveNext(task, generation: gen)
                }
            }
        }
    }

    private func handleDrop(
        _ droppedTask: URLSessionWebSocketTask,
        generation gen: Int,
        shouldCancel: Bool = true
    ) {
        guard gen == generation, task === droppedTask else { return }
        let wasConnected = state == .connected
        heartbeatTask?.cancel()
        heartbeatTask = nil
        if shouldCancel {
            task?.cancel(with: .abnormalClosure, reason: nil)
        }
        task = nil
        if wasConnected, wantsConnection {
            scheduleDelayedDisconnect(generation: gen)
        } else {
            state = .disconnected
        }
        guard wantsConnection else { return }

        guard reconnectAttempts < Self.maxReconnectAttempts else {
            state = .waitingForManualRetry
            delayedDisconnectTask?.cancel()
            reconnectTask?.cancel()
            reconnectTask = nil
            return
        }

        let delay = min(pow(2.0, Double(reconnectAttempts)), 30)
        let nextAttempt = reconnectAttempts + 1
        reconnectAttempts += 1
        state = .retrying(attempt: nextAttempt)
        reconnectTask?.cancel()
        reconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            guard let self, gen == self.generation, self.wantsConnection else { return }
            self.openSocket(generation: gen)
        }
    }

    private func scheduleDelayedDisconnect(generation gen: Int) {
        delayedDisconnectTask?.cancel()
        delayedDisconnectTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.delayedDisconnectGraceSeconds))
            guard !Task.isCancelled else { return }
            guard let self, gen == self.generation, self.wantsConnection, self.task == nil else { return }
            if case .retrying = self.state { return }
            if self.state == .connecting || self.state == .waitingForManualRetry { return }
            self.state = .disconnected
        }
    }

    private func startHeartbeat(_ activeTask: URLSessionWebSocketTask, generation gen: Int) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { @MainActor [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(Self.heartbeatIntervalSeconds))
                guard !Task.isCancelled else { return }
                guard let self, gen == self.generation, self.task === activeTask else { return }
                activeTask.sendPing { error in
                    guard error != nil else { return }
                    Task { @MainActor [weak self] in
                        guard let self, gen == self.generation, self.task === activeTask else { return }
                        self.handleDrop(activeTask, generation: gen, shouldCancel: false)
                    }
                }
            }
        }
    }

    private func isSameRequest(_ other: URLRequest) -> Bool {
        request?.url == other.url &&
            request?.value(forHTTPHeaderField: "Authorization") == other.value(forHTTPHeaderField: "Authorization")
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor [weak self] in
            guard let self, self.task === webSocketTask else { return }
            self.delayedDisconnectTask?.cancel()
            self.state = .connected
            self.reconnectAttempts = 0
            self.startHeartbeat(webSocketTask, generation: self.generation)
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if closeCode == .policyViolation {
                self.wantsConnection = false
                self.reconnectTask?.cancel()
                self.heartbeatTask?.cancel()
                self.task = nil
                self.state = .disconnected
                self.onAuthorizationRevoked?()
                return
            }
            self.handleDrop(webSocketTask, generation: self.generation, shouldCancel: false)
        }
    }
}
