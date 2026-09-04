import SwiftUI

/// 首次使用与空状态共享的激活引导：先让用户完成真实连接，再介绍会话功能。
struct MacSetupGuideView: View {
    enum Presentation {
        case firstRun
        case help
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var store: AppStore

    let presentation: Presentation
    let onContinue: () -> Void

    private var guideURL: URL {
        OctrixCloudConfiguration.page("start", baseURL: store.settings.cloudAccount?.baseURL)
    }

    private var authorizationCenterURL: URL {
        OctrixCloudConfiguration.page("dashboard", baseURL: store.settings.cloudAccount?.baseURL)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                connectionPreview

                VStack(spacing: 0) {
                    SetupStep(
                        number: 1,
                        icon: "laptopcomputer",
                        title: "在 Mac 安装 Octrix Host",
                        detail: "在 Safari 打开安装指南，将一行命令粘贴到 Mac 终端。Host 会在后台管理 AI、会话和 Web 终端，不必安装 DMG。"
                    ) {
                        Button {
                            openURL(guideURL)
                        } label: {
                            Label("打开 Host 安装指南", systemImage: "safari")
                        }
                        .buttonStyle(.bordered)
                    }

                    Divider().padding(.leading, 54)

                    SetupStep(
                        number: 2,
                        icon: "person.badge.key",
                        title: "授权 Octrix Host",
                        detail: "安装完成后会自动打开网页登录。也可在 Mac 终端运行 octrix auth。确认设备名称后，Mac 会自动上线。"
                    ) {
                        Label("不需要公网 IP，也不需要配置服务器", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Divider().padding(.leading, 54)

                    SetupStep(
                        number: 3,
                        icon: "iphone",
                        title: "回到 iPhone 登录",
                        detail: "登录完成后，账号下的全部 Mac 会自动显示。选择一台 Mac 后，就可以发起第一条对话。"
                    ) {
                        EmptyView()
                    }
                }
                .padding(.horizontal, 18)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                MacTerminalGuide()

                VStack(alignment: .leading, spacing: 10) {
                    Label("连接不上？", systemImage: "questionmark.circle")
                        .font(.headline)
                    Text("确认 Mac 与 iPhone 登录的是同一个 Octrix 账号。先用 octrix status 检查连接；Host 未运行时用 octrix restart，尚未登录时用 octrix auth。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("打开授权中心") {
                        openURL(authorizationCenterURL)
                    }
                    .font(.subheadline.weight(.semibold))
                }
                .padding(.horizontal, 4)
            }
            .padding(20)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(presentation == .firstRun ? "开始使用" : "连接一台 Mac")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if presentation == .help {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                Button {
                    if presentation == .firstRun {
                        onContinue()
                    } else {
                        dismiss()
                    }
                } label: {
                    Text(presentation == .firstRun ? "我已在 Mac 上完成授权" : "完成")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                if presentation == .firstRun {
                    Button("已有 Mac，直接登录") {
                        onContinue()
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .background(.bar)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("约 3 分钟", systemImage: "clock")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            Text("把 Mac 上的 AI，带到 iPhone。")
                .font(.largeTitle.bold())
                .fixedSize(horizontal: false, vertical: true)
            Text("先让 Octrix Host 在一台 Mac 后台运行，再在 iPhone 登录同一个账号。不需要保持 Mac 桌面窗口打开。")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var connectionPreview: some View {
        HStack(spacing: 12) {
            GuideDevice(icon: "laptopcomputer", title: "你的 Mac", detail: "Host 后台运行")
            Image(systemName: "arrow.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
            GuideDevice(icon: "person.crop.circle.badge.checkmark", title: "Octrix 账号", detail: "统一授权")
            Image(systemName: "arrow.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
            GuideDevice(icon: "iphone", title: "这台 iPhone", detail: "自动同步")
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(Color.accentColor.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct MacTerminalGuide: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 32, height: 32)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Octrix 命令行工具")
                        .font(.headline)
                    Text("安装 Host 时会自动安装，可在终端管理后台服务和 Web TUI。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(spacing: 0) {
                TerminalCommandRow(command: "octrix status", detail: "检查连接")
                Divider().padding(.leading, 12)
                TerminalCommandRow(command: "octrix auth", detail: "网页登录")
                Divider().padding(.leading, 12)
                TerminalCommandRow(command: "octrix webtui", detail: "打开 Web TUI")
                Divider().padding(.leading, 12)
                TerminalCommandRow(command: "octrix restart", detail: "重启 Host")
            }
            .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct TerminalCommandRow: View {
    let command: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Text(command)
                .font(.caption.monospaced())
                .foregroundStyle(.primary)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

private struct SetupStep<Accessory: View>: View {
    let number: Int
    let icon: String
    let title: String
    let detail: String
    @ViewBuilder let accessory: () -> Accessory

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.13))
                    .frame(width: 40, height: 40)
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text("\(number)")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(3)
                    .background(Color.accentColor, in: Circle())
                    .offset(x: 14, y: 14)
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(title)
                    .font(.body.weight(.semibold))
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                accessory()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 18)
        }
    }
}

private struct GuideDevice: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}
