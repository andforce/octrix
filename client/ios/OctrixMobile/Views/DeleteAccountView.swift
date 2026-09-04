import SwiftUI

struct DeleteAccountView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var confirmationText = ""
    @State private var isDeleting = false
    @State private var showFinalConfirmation = false
    @State private var errorMessage: String?

    private var canDelete: Bool {
        confirmationText.trimmingCharacters(in: .whitespacesAndNewlines) == "DELETE"
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Label("这项操作无法撤销", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(.red)

                    Text("删除后，Octrix Cloud 会永久删除你的账号、登录方式、设备授权、网页会话和访问凭证，所有 Mac 和 iPhone 将立即断开。")

                    Text("这不会删除 Mac 上的本地项目文件，也不会删除你在 OpenAI、Anthropic、Google 或其他第三方服务中的账号。")
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            Section {
                TextField("输入 DELETE", text: $confirmationText)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .disabled(isDeleting)
            } header: {
                Text("确认删除")
            } footer: {
                Text("请输入 DELETE 以启用永久删除操作。")
            }

            Section {
                Button(role: .destructive) {
                    showFinalConfirmation = true
                } label: {
                    HStack {
                        if isDeleting {
                            ProgressView()
                        }
                        Text(isDeleting ? "正在删除…" : "永久删除账号")
                    }
                }
                .disabled(!canDelete || isDeleting)
            } footer: {
                Text("服务器确认删除后，这台 iPhone 还会清除 Octrix 凭证、本地会话缓存和已保存的 DeepSeek API Key。")
            }
        }
        .navigationTitle("删除账号")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(isDeleting)
        .alert("确认永久删除？", isPresented: $showFinalConfirmation) {
            Button("永久删除", role: .destructive) {
                Task { await deleteAccount() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("账号与所有 Octrix Cloud 关联数据将被永久删除，所有设备将立即断开。")
        }
        .alert("无法删除账号", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("知道了") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func deleteAccount() async {
        guard canDelete, !isDeleting else { return }
        isDeleting = true
        errorMessage = nil
        do {
            try await store.deleteAccount()
            isDeleting = false
            dismiss()
        } catch is CancellationError {
            isDeleting = false
        } catch {
            isDeleting = false
            errorMessage = error.localizedDescription
        }
    }
}
