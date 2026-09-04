@main
struct ModelSwitchAvailabilityPolicyTests {
    static func main() {
        precondition(
            ModelSwitchAvailabilityPolicy.evaluate(
                isRunning: true,
                isBusy: false,
                isVoiceInputActive: false
            ) == .allowed,
            "在线且空闲的 AI 必须允许切换模型"
        )

        precondition(
            ModelSwitchAvailabilityPolicy.evaluate(
                isRunning: true,
                isBusy: true,
                isVoiceInputActive: false
            ) == .busy,
            "忙碌中的 AI 必须禁止切换模型"
        )

        precondition(
            ModelSwitchAvailabilityPolicy.evaluate(
                isRunning: false,
                isBusy: false,
                isVoiceInputActive: false
            ) == .offline,
            "离线 AI 必须禁止切换模型"
        )

        precondition(
            ModelSwitchAvailabilityPolicy.evaluate(
                isRunning: true,
                isBusy: false,
                isVoiceInputActive: true
            ) == .voiceInputActive,
            "语音输入期间必须禁止切换模型"
        )

        print("ModelSwitchAvailabilityPolicyTests passed")
    }
}
