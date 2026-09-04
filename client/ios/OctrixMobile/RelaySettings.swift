import Foundation
import Security

// MARK: - Keychain（token 存储）

enum Keychain {
    private static let service = "com.octrix.mobile"

    static func string(for key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for key: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(attributes as CFDictionary, nil)
        }
    }

    static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - 中继连接配置

struct RelayServerConfig: Codable, Identifiable, Hashable {
    let id: String
    var serverURLString: String
    var deviceId: String
    var deviceName: String
    var displayName: String?
    var accountLabel: String?
    var authorizationVersion: Int?

    var baseURL: URL? { RelaySettings.normalize(serverURLString) }

    var serverHost: String {
        guard let url = baseURL else { return "未配置中继" }
        var host = url.host ?? url.absoluteString
        if let port = url.port {
            host += ":\(port)"
        }
        return host
    }

    var title: String {
        let display = (displayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !display.isEmpty { return display }
        let device = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !device.isEmpty { return device }
        return serverHost
    }

    var detail: String {
        baseURL?.absoluteString ?? serverURLString
    }
}

struct CloudAccountSession: Codable, Hashable {
    var serverURLString: String
    var accountLabel: String

    var baseURL: URL? { RelaySettings.normalize(serverURLString) }
}

@MainActor
final class RelaySettings: ObservableObject {
    private enum Keys {
        static let servers = "relay.servers.v1"
        static let legacyServerURL = "relay.serverURL"
        static let legacyDeviceId = "relay.deviceId"
        static let legacyDeviceName = "relay.deviceName"
        static let legacyToken = "relay.token"
        static let requiresWebReauthorization = "relay.requiresWebReauthorization"
        static let cloudAccount = "relay.cloudAccount.v1"
        static let cloudAccountToken = "relay.cloudAccountToken.v1"
    }

    @Published private(set) var servers: [RelayServerConfig]
    @Published private(set) var cloudAccount: CloudAccountSession?

    init() {
        let defaults = UserDefaults.standard
        cloudAccount = nil
        if let data = defaults.data(forKey: Keys.servers),
           let decoded = try? JSONDecoder().decode([RelayServerConfig].self, from: data) {
            let stale = decoded.filter {
                $0.authorizationVersion != 2 || Self.normalize($0.serverURLString) == nil
            }
            for server in stale {
                Keychain.delete(Self.tokenKey(server.id))
            }
            servers = decoded.filter {
                $0.authorizationVersion == 2 && Self.normalize($0.serverURLString) != nil
            }
            if !stale.isEmpty {
                defaults.set(true, forKey: Keys.requiresWebReauthorization)
            }
        } else {
            servers = Self.migrateLegacyConfig(defaults: defaults)
            persist()
        }

        if let data = defaults.data(forKey: Keys.cloudAccount),
           let decoded = try? JSONDecoder().decode(CloudAccountSession.self, from: data),
           Self.normalize(decoded.serverURLString) != nil,
           Keychain.string(for: Keys.cloudAccountToken)?.isEmpty == false {
            cloudAccount = decoded
        } else if let first = servers.first,
                  let token = Keychain.string(for: Self.tokenKey(first.id)),
                  !token.isEmpty {
            cloudAccount = CloudAccountSession(
                serverURLString: first.serverURLString,
                accountLabel: first.accountLabel ?? "Octrix 用户"
            )
            Keychain.set(token, for: Keys.cloudAccountToken)
            persistCloudAccount()
        } else {
            cloudAccount = nil
            if defaults.data(forKey: Keys.cloudAccount) != nil {
                Keychain.delete(Keys.cloudAccountToken)
                defaults.removeObject(forKey: Keys.cloudAccount)
                defaults.set(true, forKey: Keys.requiresWebReauthorization)
            }
        }
    }

    var isConfigured: Bool {
        isAuthenticated || servers.contains { !token(for: $0.id).isEmpty }
    }

    var isAuthenticated: Bool {
        cloudAccount != nil && !cloudAccountToken.isEmpty
    }

    var cloudAccountToken: String {
        Keychain.string(for: Keys.cloudAccountToken) ?? ""
    }

    var requiresWebReauthorization: Bool {
        UserDefaults.standard.bool(forKey: Keys.requiresWebReauthorization)
    }

    func server(id: String) -> RelayServerConfig? {
        servers.first { $0.id == id }
    }

    func token(for serverId: String) -> String {
        if let server = server(id: serverId),
           server.baseURL?.absoluteString == cloudAccount?.baseURL?.absoluteString,
           !cloudAccountToken.isEmpty {
            return cloudAccountToken
        }
        return Keychain.string(for: Self.tokenKey(serverId)) ?? ""
    }

    func saveCloudAccount(serverURLString: String, token: String, accountLabel: String) {
        guard let normalized = Self.normalize(serverURLString)?.absoluteString else {
            cloudAccount = nil
            Keychain.delete(Keys.cloudAccountToken)
            UserDefaults.standard.set(true, forKey: Keys.requiresWebReauthorization)
            persistCloudAccount()
            return
        }
        cloudAccount = CloudAccountSession(serverURLString: normalized, accountLabel: accountLabel)
        Keychain.set(token, for: Keys.cloudAccountToken)
        for server in servers where server.baseURL?.absoluteString == Self.normalize(normalized)?.absoluteString {
            Keychain.set(token, for: Self.tokenKey(server.id))
        }
        persistCloudAccount()
    }

    @discardableResult
    func upsertServer(
        serverURLString: String,
        token: String,
        device: DeviceInfo,
        accountLabel: String? = nil,
        authorizationVersion: Int = 2
    ) -> RelayServerConfig? {
        guard let normalized = Self.normalize(serverURLString)?.absoluteString else {
            return nil
        }
        let existingIndex = servers.firstIndex { config in
            config.deviceId == device.deviceId && config.baseURL?.absoluteString == normalized
        }

        let serverId = existingIndex.map { servers[$0].id } ?? UUID().uuidString
        let config = RelayServerConfig(
            id: serverId,
            serverURLString: normalized,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            displayName: nil,
            accountLabel: accountLabel,
            authorizationVersion: authorizationVersion,
        )

        if let existingIndex {
            servers[existingIndex] = config
        } else {
            servers.append(config)
        }
        Keychain.set(token, for: Self.tokenKey(serverId))
        UserDefaults.standard.set(false, forKey: Keys.requiresWebReauthorization)
        persist()
        return config
    }

    func removeServer(id: String) {
        servers.removeAll { $0.id == id }
        Keychain.delete(Self.tokenKey(id))
        persist()
    }

    func reset() {
        for server in servers {
            Keychain.delete(Self.tokenKey(server.id))
        }
        servers = []
        cloudAccount = nil
        Keychain.delete(Keys.cloudAccountToken)
        UserDefaults.standard.removeObject(forKey: Keys.cloudAccount)
        UserDefaults.standard.set(false, forKey: Keys.requiresWebReauthorization)
        persist()
    }

    private func persist() {
        let defaults = UserDefaults.standard
        if let data = try? JSONEncoder().encode(servers) {
            defaults.set(data, forKey: Keys.servers)
        }
        defaults.removeObject(forKey: Keys.legacyServerURL)
        defaults.removeObject(forKey: Keys.legacyDeviceId)
        defaults.removeObject(forKey: Keys.legacyDeviceName)
        defaults.removeObject(forKey: Keys.legacyToken)
        Keychain.delete(Keys.legacyToken)
    }

    private func persistCloudAccount() {
        if let cloudAccount, let data = try? JSONEncoder().encode(cloudAccount) {
            UserDefaults.standard.set(data, forKey: Keys.cloudAccount)
        } else {
            UserDefaults.standard.removeObject(forKey: Keys.cloudAccount)
        }
    }

    private static func tokenKey(_ serverId: String) -> String {
        "relay.token.\(serverId)"
    }

    private static func migrateLegacyConfig(defaults: UserDefaults) -> [RelayServerConfig] {
        let serverURL = defaults.string(forKey: Keys.legacyServerURL) ?? ""
        let deviceId = defaults.string(forKey: Keys.legacyDeviceId) ?? ""
        let token = Keychain.string(for: Keys.legacyToken) ?? defaults.string(forKey: Keys.legacyToken) ?? ""
        guard normalize(serverURL) != nil, !deviceId.isEmpty, !token.isEmpty else {
            return []
        }
        Keychain.delete(Keys.legacyToken)
        defaults.removeObject(forKey: Keys.legacyToken)
        defaults.set(true, forKey: Keys.requiresWebReauthorization)
        return []
    }

    /// 规整用户输入的 HTTPS 服务器地址：补全 https:// 前缀、去掉末尾斜杠。
    nonisolated static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") {
            text = "https://" + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              scheme == "https",
              components.host?.isEmpty == false else { return nil }
        components.scheme = "https"
        while components.path.hasSuffix("/") {
            components.path = String(components.path.dropLast())
        }
        return components.url
    }

}
