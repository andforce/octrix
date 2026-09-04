import Foundation

@main
@MainActor
struct PhoneLoginFlowTests {
    static func main() async {
        var failures: [String] = []

        var submission = PhoneLoginSubmissionState()
        if !submission.begin(.verifyingCode) {
            failures.append("首次验证提交应被接受")
        }
        if submission.begin(.verifyingCode) {
            failures.append("验证进行中不得再次提交同一个 challenge")
        }
        submission.finish(.verifyingCode)
        if submission.isBusy {
            failures.append("验证结束后应解除忙碌状态")
        }

        var phonePageEvents: [String] = []
        await PhoneLoginPageCompletionFlow.run(
            onAuthorized: { phonePageEvents.append("authorized") },
            dismissPage: { phonePageEvents.append("dismiss") }
        )
        if phonePageEvents != ["authorized", "dismiss"] {
            failures.append("手机号授权成功后必须由手机号登录页主动退出当前导航层级")
        }

        var completionEvents: [String] = []
        await CloudLoginCompletionFlow.run(
            isInitial: false,
            persistAccount: { completionEvents.append("persist") },
            dismissLogin: { completionEvents.append("dismiss") },
            refreshAccount: { completionEvents.append("refresh") }
        )
        if completionEvents != ["persist", "dismiss", "refresh"] {
            failures.append("非首次登录应在保存账号后立即关闭登录页，再异步刷新账号设备")
        }

        var initialEvents: [String] = []
        await CloudLoginCompletionFlow.run(
            isInitial: true,
            persistAccount: { initialEvents.append("persist") },
            dismissLogin: { initialEvents.append("dismiss") },
            refreshAccount: { initialEvents.append("refresh") }
        )
        if initialEvents != ["persist", "refresh"] {
            failures.append("首次登录由认证状态驱动根页面切换，不应主动 dismiss")
        }

        precondition(failures.isEmpty, failures.joined(separator: "\n"))
        print("PhoneLoginFlowTests passed")
    }
}
