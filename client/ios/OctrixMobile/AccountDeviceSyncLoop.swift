import Foundation

/// App 位于前台时，定期以授权中心的设备列表刷新本地 Mac。
/// 任务取消（例如进入后台）后立即停止，不留下额外轮询。
enum AccountDeviceSyncLoop {
    static let foregroundInterval: Duration = .seconds(10)

    @MainActor
    @discardableResult
    static func refresh(
        syncDevices: () async -> Bool,
        syncSessions: () async -> Void
    ) async -> Bool {
        guard await syncDevices(), !Task.isCancelled else { return false }
        await syncSessions()
        return true
    }

    @MainActor
    static func run(
        interval: Duration = foregroundInterval,
        syncDevices: () async -> Bool,
        syncSessions: () async -> Void
    ) async {
        while !Task.isCancelled {
            _ = await refresh(syncDevices: syncDevices, syncSessions: syncSessions)
            do {
                try await Task.sleep(for: interval)
            } catch {
                return
            }
        }
    }
}
