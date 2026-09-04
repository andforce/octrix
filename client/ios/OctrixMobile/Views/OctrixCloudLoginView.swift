import AuthenticationServices
import SwiftUI
import UIKit

struct OctrixCloudLoginView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    let isInitial: Bool

    @StateObject private var webAuthentication = OctrixWebAuthenticationSession()
    @State private var serverURLText = OctrixCloudConfiguration.defaultURL.absoluteString
    @State private var showAdvanced = false
    @State private var showPhoneLogin = false
    @State private var isAuthorizingWebsite = false
    @State private var isAuthorizingApple = false
    @State private var appleNonce: String?
    @State private var errorText: String?

    var body: some View {
        Form {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(Color.accentColor)
                    Text("登录后，账号下的全部 Mac 会自动出现在 iPhone 上，无需逐台添加或配对。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)

                SignInWithAppleButton(.continue) { request in
                    errorText = nil
                    isAuthorizingApple = true
                    appleNonce = OctrixAppleAuthentication.prepare(request)
                } onCompletion: { result in
                    handleAppleAuthorization(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 50)
                .disabled(isBusy)

                Button {
                    Task { await authorizeWithWebsite() }
                } label: {
                    SecondaryLoginButtonLabel(
                        title: isAuthorizingWebsite ? "正在打开登录页面…" : "使用 Google / 网站登录",
                        systemImage: "globe",
                        isLoading: isAuthorizingWebsite
                    )
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .opacity(isBusy ? 0.55 : 1)

                Button {
                    errorText = nil
                    showPhoneLogin = true
                } label: {
                    SecondaryLoginButtonLabel(
                        title: "使用手机号登录",
                        systemImage: "iphone"
                    )
                }
                .buttonStyle(.plain)
                .disabled(isBusy)
                .opacity(isBusy ? 0.55 : 1)
                .accessibilityIdentifier("login.phone")
            } footer: {
                Text("Mac 和 iPhone 只需登录同一个 Octrix 账号，授权中心会统一同步设备权限。")
            }

            if isInitial {
                Section {
                    Link(destination: OctrixCloudConfiguration.page("start")) {
                        Label("还没在 Mac 安装 Octrix Host？查看指南", systemImage: "laptopcomputer")
                    }
                } footer: {
                    Text("先按网页指南安装后台 Host 并完成授权；不需要安装 DMG 或保持 Mac 桌面窗口打开。")
                }
            }

            if store.settings.requiresWebReauthorization {
                Section {
                    Label("旧的手动 Token 已从本机清除，请使用网站重新登录。", systemImage: "exclamationmark.shield")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }

            Section {
                DisclosureGroup("高级：自托管授权中心", isExpanded: $showAdvanced) {
                    TextField("授权中心地址", text: $serverURLText, prompt: Text(verbatim: "https://remote.example.com"))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("自托管授权中心必须支持 Octrix 账号与设备授权协议；旧 Token 不会被自动上传。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let errorText {
                Section {
                    Text(errorText).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("登录 Octrix")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $showPhoneLogin) {
            OctrixPhoneLoginView(
                serverURLText: serverURLText,
                onAuthorized: completeAuthorization
            )
        }
        .toolbar {
            if !isInitial {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }

    private var isBusy: Bool {
        isAuthorizingWebsite || isAuthorizingApple
    }

    private func handleAppleAuthorization(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case let .success(result):
            guard let nonce = appleNonce else {
                isAuthorizingApple = false
                errorText = "Apple 登录随机数已失效，请重试"
                return
            }
            do {
                let authorization = try OctrixAppleAuthentication.authorization(from: result, nonce: nonce)
                Task { await authorizeWithApple(authorization) }
            } catch {
                appleNonce = nil
                isAuthorizingApple = false
                errorText = error.localizedDescription
            }
        case let .failure(error as ASAuthorizationError) where error.code == .canceled:
            appleNonce = nil
            isAuthorizingApple = false
        case let .failure(error):
            appleNonce = nil
            isAuthorizingApple = false
            errorText = error.localizedDescription
        }
    }

    private func authorizeWithApple(_ authorization: OctrixAppleAuthorization) async {
        defer {
            appleNonce = nil
            isAuthorizingApple = false
        }
        guard let baseURL = RelaySettings.normalize(serverURLText) else {
            errorText = "授权中心地址无效"
            return
        }
        do {
            let anonymousAPI = RelayAPI(baseURL: baseURL, token: "")
            let signedIn = try await anonymousAPI.authorizeWithApple(
                authorization,
                deviceId: MobileDeviceIdentity.value,
                deviceName: UIDevice.current.name
            )
            guard let returnedServer = RelaySettings.normalize(signedIn.serverURL) else {
                throw RelayAPIError(message: "授权中心返回的地址无效")
            }
            let authorized = try await RelayAPI(baseURL: returnedServer, token: "")
                .exchangeMobileAuthorization(code: signedIn.authorizationCode)
            try await completeAuthorization(authorized)
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func authorizeWithWebsite() async {
        errorText = nil
        guard let baseURL = RelaySettings.normalize(serverURLText) else {
            errorText = "授权中心地址无效"
            return
        }
        isAuthorizingWebsite = true
        defer { isAuthorizingWebsite = false }
        do {
            let callback = try await webAuthentication.authorize(baseURL: baseURL)
            let anonymousAPI = RelayAPI(baseURL: callback.serverURL, token: "")
            let authorized = try await anonymousAPI.exchangeMobileAuthorization(code: callback.code)
            try await completeAuthorization(authorized)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func completeAuthorization(_ authorized: MobileAuthorizationTokenResponse) async throws {
        guard let serverURL = RelaySettings.normalize(authorized.serverURL) else {
            throw RelayAPIError(message: "授权中心返回的地址无效")
        }
        let label = authorized.user.name ?? authorized.user.primaryLabel
        await CloudLoginCompletionFlow.run(
            isInitial: isInitial,
            persistAccount: {
                store.saveCloudAccount(
                    serverURLString: serverURL.absoluteString,
                    token: authorized.accessToken,
                    accountLabel: label
                )
            },
            dismissLogin: { dismiss() },
            refreshAccount: {
                _ = try? await store.syncAccountDevices()
                await store.refreshState()
            }
        )
    }
}

private struct SecondaryLoginButtonLabel: View {
    let title: String
    let systemImage: String
    var isLoading = false

    var body: some View {
        HStack(spacing: 10) {
            if isLoading {
                ProgressView()
            } else {
                Image(systemName: systemImage)
            }
            Text(title)
                .font(.body.weight(.medium))
        }
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator), lineWidth: 1)
        }
    }
}
