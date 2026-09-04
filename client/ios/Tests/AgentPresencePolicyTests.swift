@main
struct AgentPresencePolicyTests {
    static func main() {
        precondition(
            AgentPresencePolicy.resolve(
                hasError: false,
                isInitializing: false,
                isHostBusy: true,
                isStreaming: false,
                isRunning: true
            ) == .busy,
            "Host 从 Codex PTY 检测为忙碌时，iOS 必须显示忙碌"
        )
        precondition(
            AgentPresencePolicy.resolve(
                hasError: true,
                isInitializing: true,
                isHostBusy: true,
                isStreaming: true,
                isRunning: true
            ) == .error,
            "异常状态优先于所有忙碌信号"
        )
        precondition(
            AgentPresencePolicy.resolve(
                hasError: false,
                isInitializing: false,
                isHostBusy: false,
                isStreaming: false,
                isRunning: true
            ) == .online,
            "没有活动信号的运行中 Agent 应显示在线"
        )
        precondition(
            AgentPresencePolicy.resolve(
                hasError: false,
                isInitializing: false,
                isHostBusy: false,
                isStreaming: false,
                isRunning: false
            ) == .offline,
            "未运行的 Agent 应显示离线"
        )
        print("AgentPresencePolicyTests passed")
    }
}
