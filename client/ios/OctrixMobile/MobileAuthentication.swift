import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

enum MobileDeviceIdentity {
    private static let key = "octrix.mobile.authorizationDeviceId"

    static var value: String {
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let created = UUID().uuidString
        UserDefaults.standard.set(created, forKey: key)
        return created
    }
}

struct OctrixAppleAuthorization {
    let code: String
    let nonce: String
    let firstName: String?
    let lastName: String?
}

enum OctrixAppleAuthentication {
    private static let nonceCharacters = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")

    static func prepare(_ request: ASAuthorizationAppleIDRequest) -> String {
        let nonce = String((0..<32).compactMap { _ in nonceCharacters.randomElement() })
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce(nonce)
        return nonce
    }

    static func authorization(from result: ASAuthorization, nonce: String) throws -> OctrixAppleAuthorization {
        guard let credential = result.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.authorizationCode,
              let code = String(data: data, encoding: .utf8),
              !code.isEmpty else {
            throw RelayAPIError(message: "Apple 没有返回有效的授权码")
        }
        return OctrixAppleAuthorization(
            code: code,
            nonce: nonce,
            firstName: credential.fullName?.givenName,
            lastName: credential.fullName?.familyName
        )
    }

    private static func hashedNonce(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
final class OctrixWebAuthenticationSession: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authorize(baseURL: URL) async throws -> (code: String, serverURL: URL) {
        var components = URLComponents(url: baseURL.appending(path: "/auth/mobile/start"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "return_uri", value: "octrix://auth"),
            URLQueryItem(name: "device_id", value: MobileDeviceIdentity.value),
            URLQueryItem(name: "device_name", value: UIDevice.current.name),
        ]
        guard let authorizationURL = components?.url else {
            throw RelayAPIError(message: "授权中心地址无效")
        }

        let callbackURL: URL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(url: authorizationURL, callbackURLScheme: "octrix") { [weak self] url, error in
                Task { @MainActor in
                    self?.session = nil
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: RelayAPIError(message: "网站没有返回授权结果"))
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: RelayAPIError(message: "无法打开 Octrix 登录页面"))
            }
        }

        guard callbackURL.scheme == "octrix", callbackURL.host == "auth",
              let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false) else {
            throw RelayAPIError(message: "网站返回的授权结果无效")
        }
        if callback.queryItems?.first(where: { $0.name == "error" })?.value == "access_denied" {
            throw RelayAPIError(message: "你已拒绝这台 iPhone 的授权")
        }
        guard
              let code = callback.queryItems?.first(where: { $0.name == "code" })?.value,
              !code.isEmpty else {
            throw RelayAPIError(message: "网站返回的授权码无效")
        }
        let returnedServer = callback.queryItems?.first(where: { $0.name == "server" })?.value
        guard let serverURL = RelaySettings.normalize(returnedServer ?? baseURL.absoluteString) else {
            throw RelayAPIError(message: "授权中心返回的地址无效")
        }
        return (code, serverURL)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first {
            return window
        }
        return ASPresentationAnchor()
    }
}
