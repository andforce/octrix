enum ModelSwitchAvailabilityPolicy {
    enum Result: Equatable {
        case allowed
        case offline
        case busy
        case voiceInputActive
    }

    static func evaluate(
        isRunning: Bool,
        isBusy: Bool,
        isVoiceInputActive: Bool
    ) -> Result {
        if isVoiceInputActive { return .voiceInputActive }
        if isBusy { return .busy }
        return isRunning ? .allowed : .offline
    }
}
