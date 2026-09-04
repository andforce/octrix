@main
struct ChatInputAvailabilityPolicyTests {
    static func main() {
        precondition(
            ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: nil,
                isDirectChat: false,
                isSending: false,
                isPolishingSpeech: false,
                isSpeechInputActive: false
            ),
            "群聊大厅即使没有任务会话，也必须允许启动语音输入"
        )

        precondition(
            !ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: nil,
                isDirectChat: true,
                isSending: false,
                isPolishingSpeech: false,
                isSpeechInputActive: false
            ),
            "没有会话的私聊仍应禁止启动语音输入"
        )

        precondition(
            ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: "session-1",
                isDirectChat: true,
                isSending: false,
                isPolishingSpeech: false,
                isSpeechInputActive: false
            ),
            "已有会话的私聊必须允许启动语音输入"
        )

        precondition(
            !ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: "session-1",
                isDirectChat: false,
                isSending: true,
                isPolishingSpeech: false,
                isSpeechInputActive: false
            ),
            "消息发送期间必须禁止重复启动语音输入"
        )

        precondition(
            !ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: "session-1",
                isDirectChat: false,
                isSending: false,
                isPolishingSpeech: true,
                isSpeechInputActive: false
            ),
            "语音润色期间必须禁止重复启动语音输入"
        )

        precondition(
            !ChatInputAvailabilityPolicy.canStartVoiceInput(
                sessionId: "session-1",
                isDirectChat: false,
                isSending: false,
                isPolishingSpeech: false,
                isSpeechInputActive: true
            ),
            "语音输入已激活时必须禁止重复启动"
        )

        print("ChatInputAvailabilityPolicyTests passed")
    }
}
