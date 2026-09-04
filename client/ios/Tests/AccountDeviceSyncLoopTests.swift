import Foundation

@main
@MainActor
struct AccountDeviceSyncLoopTests {
    static func main() async {
        var visibleDeviceIds = ["revoked-mac", "current-mac"]
        var syncOrder: [String] = []

        await AccountDeviceSyncLoop.refresh(
            syncDevices: {
                syncOrder.append("devices")
                visibleDeviceIds = ["current-mac"]
                return true
            },
            syncSessions: {
                syncOrder.append("sessions:\(visibleDeviceIds.joined(separator: ","))")
            }
        )

        precondition(
            syncOrder == ["devices", "sessions:current-mac"],
            "同步会话前必须先以授权中心列表移除已撤销 Mac"
        )

        var failedRefreshSessionCount = 0
        await AccountDeviceSyncLoop.refresh(
            syncDevices: { false },
            syncSessions: { failedRefreshSessionCount += 1 }
        )
        precondition(failedRefreshSessionCount == 0, "设备列表同步失败时不得继续同步本地旧 Mac 会话")

        var deviceSyncCount = 0
        var sessionSyncCount = 0
        let loop = Task { @MainActor in
            await AccountDeviceSyncLoop.run(
                interval: .milliseconds(10),
                syncDevices: {
                    deviceSyncCount += 1
                    return true
                },
                syncSessions: { sessionSyncCount += 1 }
            )
        }

        try? await Task.sleep(for: .milliseconds(35))
        precondition(deviceSyncCount >= 2, "前台期间应重复同步账号设备")
        precondition(sessionSyncCount == deviceSyncCount, "每轮设备同步后应同步一次会话")

        loop.cancel()
        await loop.value
        let countsWhenCancelled = (deviceSyncCount, sessionSyncCount)

        try? await Task.sleep(for: .milliseconds(30))
        precondition(
            deviceSyncCount == countsWhenCancelled.0 && sessionSyncCount == countsWhenCancelled.1,
            "同步循环取消后不应继续运行"
        )

        print("AccountDeviceSyncLoopTests passed")
    }
}
