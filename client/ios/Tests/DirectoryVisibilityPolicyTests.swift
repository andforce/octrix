@main
struct DirectoryVisibilityPolicyTests {
    static func main() {
        precondition(
            DirectoryVisibilityPolicy.isVisible(
                name: "Projects",
                showHiddenFiles: false
            ),
            "普通文件夹默认必须可见"
        )

        precondition(
            !DirectoryVisibilityPolicy.isVisible(
                name: ".agents",
                showHiddenFiles: false
            ),
            "以点号开头的文件夹默认必须隐藏"
        )

        precondition(
            DirectoryVisibilityPolicy.isVisible(
                name: ".agents",
                showHiddenFiles: true
            ),
            "用户打开显示隐藏文件后，点号文件夹必须可见"
        )

        print("DirectoryVisibilityPolicyTests passed")
    }
}
