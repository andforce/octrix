import Foundation

@main
struct WorkspaceDataVersionPolicyTests {
    static func main() {
        precondition(
            !WorkspaceDataVersionPolicy.shouldReset(storedVersion: 1, incomingVersion: nil),
            "旧 Host 缺少版本字段时必须保留现有缓存"
        )
        precondition(
            WorkspaceDataVersionPolicy.shouldReset(storedVersion: nil, incomingVersion: 1),
            "首次收到新版 Host 数据版本时必须清理旧缓存"
        )
        precondition(
            !WorkspaceDataVersionPolicy.shouldReset(storedVersion: 1, incomingVersion: 1),
            "同版本刷新不得重复清理缓存"
        )
        precondition(
            WorkspaceDataVersionPolicy.shouldReset(storedVersion: 1, incomingVersion: 2),
            "Host 数据版本变化时必须清理缓存"
        )
        print("WorkspaceDataVersionPolicyTests passed")
    }
}
