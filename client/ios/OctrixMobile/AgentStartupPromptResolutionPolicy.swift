import Foundation

enum AgentStartupPromptResolutionPolicy {
    static func isResolved(
        resolvedCount: Int,
        expectedPromptIDs: Set<String>,
        remainingPromptIDs: Set<String>
    ) -> Bool {
        if resolvedCount > 0 {
            return true
        }
        guard !expectedPromptIDs.isEmpty else {
            return false
        }
        return expectedPromptIDs.isDisjoint(with: remainingPromptIDs)
    }
}
