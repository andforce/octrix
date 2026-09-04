import SwiftUI
import UIKit

struct OctrixPhoneLoginView: View {
    @Environment(\.dismiss) private var dismiss

    private enum Field: Hashable {
        case phone
        case code
    }

    private struct ErrorAlert: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    let serverURLText: String
    let onAuthorized: (MobileAuthorizationTokenResponse) async throws -> Void

    @State private var phoneNumber = ""
    @State private var smsCode = ""
    @State private var smsChallengeId = ""
    @State private var submissionState = PhoneLoginSubmissionState()
    @State private var errorAlert: ErrorAlert?
    @FocusState private var focusedField: Field?

    var body: some View {
        Form {
            Section {
                Label {
                    Text(smsChallengeId.isEmpty
                        ? "输入中国大陆手机号，我们会发送一条短信验证码。"
                        : "验证码已发送至 +86 \(phoneNumber)，请输入短信中的 6 位数字。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: smsChallengeId.isEmpty ? "iphone" : "message.badge")
                        .font(.title2)
                        .foregroundStyle(Color.accentColor)
                }
                .padding(.vertical, 4)
            }

            if smsChallengeId.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        Text("+86")
                            .foregroundStyle(.secondary)
                        TextField("中国大陆手机号", text: $phoneNumber)
                            .keyboardType(.phonePad)
                            .textContentType(.telephoneNumber)
                            .focused($focusedField, equals: .phone)
                            .onChange(of: phoneNumber) { _, value in
                                phoneNumber = String(value.filter(\.isNumber).prefix(11))
                            }
                            .accessibilityIdentifier("phone-login.number")
                    }

                    Button {
                        Task { await sendSMSCode() }
                    } label: {
                        HStack(spacing: 8) {
                            if isSendingSMS { ProgressView() }
                            Text(isSendingSMS ? "正在发送…" : "获取验证码")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy || phoneNumber.count != 11)
                    .accessibilityIdentifier("phone-login.send-code")
                } header: {
                    Text("手机号")
                } footer: {
                    Text("验证码 5 分钟内有效，仅支持登录白名单中的中国大陆手机号。")
                }
            } else {
                Section {
                    TextField("6 位验证码", text: $smsCode)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title2.monospacedDigit())
                        .focused($focusedField, equals: .code)
                        .onChange(of: smsCode) { _, value in
                            smsCode = String(value.filter(\.isNumber).prefix(6))
                        }
                        .accessibilityIdentifier("phone-login.code")

                    Button {
                        Task { await verifySMSCode() }
                    } label: {
                        HStack(spacing: 8) {
                            if isVerifyingSMS { ProgressView() }
                            Text(isVerifyingSMS ? "正在验证…" : "验证并登录")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isBusy || smsCode.count != 6)
                    .accessibilityIdentifier("phone-login.verify")

                    Button("更换手机号") {
                        smsChallengeId = ""
                        smsCode = ""
                        errorAlert = nil
                        focusedField = .phone
                    }
                    .disabled(isBusy)
                } header: {
                    Text("短信验证码")
                }
            }
        }
        .navigationTitle("手机号登录")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .alert(item: $errorAlert) { alert in
            Alert(
                title: Text(alert.title),
                message: Text(alert.message),
                dismissButton: .default(Text("知道了")) {
                    focusedField = smsChallengeId.isEmpty ? .phone : .code
                }
            )
        }
        .onAppear {
            if smsChallengeId.isEmpty {
                focusedField = .phone
            }
        }
    }

    private var isBusy: Bool {
        submissionState.isBusy
    }

    private var isSendingSMS: Bool {
        submissionState.isSendingCode
    }

    private var isVerifyingSMS: Bool {
        submissionState.isVerifyingCode
    }

    private func sendSMSCode() async {
        guard submissionState.begin(.sendingCode) else { return }
        defer { submissionState.finish(.sendingCode) }
        errorAlert = nil
        guard phoneNumber.count == 11 else {
            presentError(title: "手机号格式有误", message: "请输入 11 位中国大陆手机号")
            return
        }
        guard let baseURL = RelaySettings.normalize(serverURLText) else {
            presentError(title: "发送失败", message: "授权中心地址无效")
            return
        }
        do {
            let challenge = try await RelayAPI(baseURL: baseURL, token: "").createMobileSMSChallenge(
                phone: phoneNumber,
                deviceId: MobileDeviceIdentity.value,
                deviceName: UIDevice.current.name
            )
            smsChallengeId = challenge.challengeId
            smsCode = ""
            focusedField = .code
        } catch {
            presentError(title: "发送失败", message: error.localizedDescription)
        }
    }

    private func verifySMSCode() async {
        guard submissionState.begin(.verifyingCode) else { return }
        defer { submissionState.finish(.verifyingCode) }
        errorAlert = nil
        guard let baseURL = RelaySettings.normalize(serverURLText) else {
            presentError(title: "登录失败", message: "授权中心地址无效")
            return
        }
        do {
            let verified = try await RelayAPI(baseURL: baseURL, token: "").verifyMobileSMSChallenge(
                challengeId: smsChallengeId,
                code: smsCode
            )
            guard let returnedServer = RelaySettings.normalize(verified.serverURL) else {
                throw RelayAPIError(message: "授权中心返回的地址无效")
            }
            let authorized = try await RelayAPI(baseURL: returnedServer, token: "")
                .exchangeMobileAuthorization(code: verified.authorizationCode)
            try await PhoneLoginPageCompletionFlow.run(
                onAuthorized: { try await onAuthorized(authorized) },
                dismissPage: { dismiss() }
            )
        } catch {
            presentError(title: "登录失败", message: error.localizedDescription)
        }
    }

    private func presentError(title: String, message: String) {
        focusedField = nil
        errorAlert = ErrorAlert(title: title, message: message)
    }
}
