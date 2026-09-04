import Foundation

enum WorkspaceDataVersionPolicy {
    static func shouldReset(storedVersion: Int?, incomingVersion: Int?) -> Bool {
        guard let incomingVersion, incomingVersion > 0 else { return false }
        return storedVersion != incomingVersion
    }
}
