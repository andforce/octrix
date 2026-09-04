enum DirectoryVisibilityPolicy {
    static func isVisible(name: String, showHiddenFiles: Bool) -> Bool {
        showHiddenFiles || !name.hasPrefix(".")
    }
}
