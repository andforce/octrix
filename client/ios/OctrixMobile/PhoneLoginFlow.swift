import Foundation

enum PhoneLoginOperation: Equatable {
    case sendingCode
    case verifyingCode
}

struct PhoneLoginSubmissionState {
    private(set) var operation: PhoneLoginOperation?

    var isBusy: Bool { operation != nil }
    var isSendingCode: Bool { operation == .sendingCode }
    var isVerifyingCode: Bool { operation == .verifyingCode }

    mutating func begin(_ newOperation: PhoneLoginOperation) -> Bool {
        guard operation == nil else { return false }
        operation = newOperation
        return true
    }

    mutating func finish(_ completedOperation: PhoneLoginOperation) {
        guard operation == completedOperation else { return }
        operation = nil
    }
}

@MainActor
enum PhoneLoginPageCompletionFlow {
    static func run(
        onAuthorized: () async throws -> Void,
        dismissPage: () -> Void
    ) async rethrows {
        try await onAuthorized()
        dismissPage()
    }
}

@MainActor
enum CloudLoginCompletionFlow {
    static func run(
        isInitial: Bool,
        persistAccount: () -> Void,
        dismissLogin: () -> Void,
        refreshAccount: () async -> Void
    ) async {
        persistAccount()
        if !isInitial {
            dismissLogin()
        }
        await refreshAccount()
    }
}
