enum AgentPresencePolicy {
    enum State: Equatable {
        case offline
        case online
        case busy
        case error
    }

    static func resolve(
        hasError: Bool,
        isInitializing: Bool,
        isHostBusy: Bool,
        isStreaming: Bool,
        isRunning: Bool
    ) -> State {
        if hasError { return .error }
        if isInitializing || isHostBusy || isStreaming { return .busy }
        return isRunning ? .online : .offline
    }
}
