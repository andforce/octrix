import Foundation

/// 由 Xcode 的 `OCTRIX_CLOUD_URL` 构建设置提供默认授权中心地址。
/// 用户仍可在 iOS 登录页的“高级”区域临时改用其他自托管地址。
enum OctrixCloudConfiguration {
    static let defaultURL: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "OCTRIX_CLOUD_URL") as? String
        return configured.flatMap(RelaySettings.normalize)
            ?? URL(string: "https://octrix.work")!
    }()

    static func page(_ path: String, baseURL: URL? = nil) -> URL {
        (baseURL ?? defaultURL).appendingPathComponent(path)
    }
}
