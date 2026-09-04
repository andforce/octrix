import Foundation

@main
struct AgentStartupPromptResolutionPolicyTests {
    static func main() {
        let workspaceTrustPrompt = "group-1:agent-1:workspace-trust"
        let bypassPrompt = "group-1:agent-1:bypass-permissions"

        precondition(
            AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 1,
                expectedPromptIDs: [workspaceTrustPrompt],
                remainingPromptIDs: []
            ),
            "Host 明确处理提示时应视为成功"
        )
        precondition(
            AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 0,
                expectedPromptIDs: [workspaceTrustPrompt],
                remainingPromptIDs: []
            ),
            "提示已由其他入口处理时应保持幂等"
        )
        precondition(
            !AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 0,
                expectedPromptIDs: [workspaceTrustPrompt],
                remainingPromptIDs: [workspaceTrustPrompt]
            ),
            "目标提示仍存在时不应误报成功"
        )
        precondition(
            AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 0,
                expectedPromptIDs: [workspaceTrustPrompt],
                remainingPromptIDs: [bypassPrompt]
            ),
            "同一 Agent 已进入下一种启动提示时，旧提示应视为完成"
        )
        precondition(
            !AgentStartupPromptResolutionPolicy.isResolved(
                resolvedCount: 0,
                expectedPromptIDs: [],
                remainingPromptIDs: []
            ),
            "没有预期提示时应保留 resolved=0 的失败语义"
        )

        print("AgentStartupPromptResolutionPolicyTests passed")
    }
}
