import Foundation

enum ChatInputAvailabilityPolicy {
    static func canStartVoiceInput(
        sessionId: String?,
        isDirectChat: Bool,
        isSending: Bool,
        isPolishingSpeech: Bool,
        isSpeechInputActive: Bool
    ) -> Bool {
        (sessionId != nil || !isDirectChat)
            && !isSending
            && !isPolishingSpeech
            && !isSpeechInputActive
    }
}
