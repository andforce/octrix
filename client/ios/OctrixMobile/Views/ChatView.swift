import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

private struct WorkspaceFileReference: Identifiable, Equatable {
    let id = UUID()
    let text: String
}

private enum MissionDecisionAction: String, Identifiable {
    case pause
    case resume
    case requestChanges
    case complete
    case cancel
    case acceptRisk
    case extendRework
    case incorporateExternalChanges
    case discardExternalChanges
    case importExternalImplementation
    case reassign

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pause: return "暂停任务"
        case .resume: return "恢复任务"
        case .requestChanges: return "退回修改"
        case .complete: return "验收并完成"
        case .cancel: return "取消任务"
        case .acceptRisk: return "接受风险"
        case .extendRework: return "追加返工轮次"
        case .incorporateExternalChanges: return "纳入外部变更"
        case .discardExternalChanges: return "移除外部变更"
        case .importExternalImplementation: return "导入外部实现"
        case .reassign: return "改派工作项"
        }
    }

    var notePrompt: String {
        switch self {
        case .pause: return "暂停原因"
        case .resume: return "工作区与外部状态核对结果"
        case .requestChanges: return "修改范围与验收预期"
        case .complete: return "验收、合并或接受结论"
        case .cancel: return "取消原因"
        case .acceptRisk: return "风险依据与后续安排"
        case .extendRework: return "追加理由与收敛条件"
        case .incorporateExternalChanges: return "纳入范围、来源与技术 Leader 核对要求"
        case .discardExternalChanges: return "确认移除范围与恢复依据"
        case .importExternalImplementation: return "外部实现来源、范围与核对结果"
        case .reassign: return "改派原因与交接要求"
        }
    }
}

private struct MissionReassignment {
    let workItem: WorkItem
    let targetMemberId: String
}

private struct MissionControlView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let groupId: String
    let missionId: String

    @State private var decision: MissionDecisionAction?
    @State private var decisionNote = ""
    @State private var additionalRounds = 1
    @State private var reassignment: MissionReassignment?
    @State private var isWorking = false
    @State private var errorText: String?

    private var group: AgentGroup? {
        store.group(serverId: serverId, groupId: groupId)
    }

    private var mission: TaskSession? {
        store.session(serverId: serverId, id: missionId)
    }

    private var workItems: [WorkItem] {
        store.workItems(missionId: missionId, serverId: serverId)
    }

    private var issues: [CollaborationIssue] {
        store.issues(missionId: missionId, serverId: serverId)
    }

    private var unresolvedIssues: [CollaborationIssue] {
        issues.filter { ["open", "reopened"].contains($0.status) }
    }

    var body: some View {
        Group {
            if let group, let mission {
                List {
                    missionSummary(mission)
                    phaseSection(mission)
                    workItemSection(group: group, mission: mission)
                    issueSection
                    if let submission = mission.submission {
                        Section("Draft PR") {
                            Link(submission.prUrl, destination: URL(string: submission.prUrl)!)
                            LabeledContent("分支", value: submission.branch)
                            LabeledContent("Commit", value: String(submission.commitSha.prefix(12)))
                        }
                    }
                    ownerControls(group: group, mission: mission)
                    if let errorText {
                        Section {
                            Text(errorText)
                                .foregroundStyle(.red)
                        }
                    }
                }
                .refreshable {
                    try? await store.loadMissionDetail(
                        groupId: group.id,
                        missionId: mission.id,
                        serverId: serverId,
                    )
                }
            } else {
                ContentUnavailableView("任务不存在", systemImage: "checklist")
            }
        }
        .navigationTitle("主任务控制台")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("完成") { dismiss() }
            }
        }
        .task {
            try? await store.loadMissionDetail(
                groupId: groupId,
                missionId: missionId,
                serverId: serverId,
            )
        }
        .alert(
            decision?.title ?? "群主决策",
            isPresented: Binding(
                get: { decision != nil },
                set: {
                    if !$0 {
                        decision = nil
                        decisionNote = ""
                        reassignment = nil
                    }
                },
            ),
        ) {
            TextField(decision?.notePrompt ?? "说明", text: $decisionNote, axis: .vertical)
            Button("确认") {
                runDecision()
            }
            .disabled(decisionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
            Button("取消", role: .cancel) {
                decision = nil
                reassignment = nil
            }
        } message: {
            Text("说明会追加到不可覆盖的任务事件和群主决策记录。")
        }
    }

    private func missionSummary(_ mission: TaskSession) -> some View {
        Section("任务") {
            Text(mission.title)
                .font(.headline)
            if let objective = mission.objective {
                Text(objective)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Circle()
                    .fill(missionStatusColor(mission.status))
                    .frame(width: 8, height: 8)
                Text(missionStatusLabel(mission.status))
                Spacer()
                if (mission.reworkRound ?? 0) > 0 {
                    Text("返工 \(mission.reworkRound ?? 0)/\(mission.maxReworkRounds ?? 3)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let branch = mission.gitBaseline?.taskBranch {
                LabeledContent("任务分支", value: branch)
            }
        }
    }

    private func phaseSection(_ mission: TaskSession) -> some View {
        Section("阶段") {
            ForEach((mission.phases ?? []).sorted { $0.order < $1.order }) { phase in
                HStack {
                    Text("\(phase.order). \(phase.name)")
                    Spacer()
                    Text(phase.status)
                        .font(.caption)
                        .foregroundStyle(phase.status == "blocked" ? .orange : .secondary)
                }
            }
        }
    }

    private func workItemSection(group: AgentGroup, mission: TaskSession) -> some View {
        Section("工作项") {
            if workItems.isEmpty {
                Text("暂无工作项")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(workItems) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(item.title)
                                .lineLimit(2)
                            Spacer()
                            Text(item.status)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Text(store.agent(serverId: serverId, id: item.ownerAgentId)?.name ?? item.ownerAgentId)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            let replacements = group.members.filter {
                                $0.roleId == item.roleId && $0.id != item.ownerMemberId
                            }
                            if !item.isTerminal && !replacements.isEmpty {
                                Menu("改派") {
                                    ForEach(replacements) { member in
                                        Button(store.agent(serverId: serverId, id: member.agentId)?.name ?? member.agentId) {
                                            reassignment = MissionReassignment(
                                                workItem: item,
                                                targetMemberId: member.id,
                                            )
                                            decision = .reassign
                                        }
                                    }
                                }
                                .font(.caption)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var issueSection: some View {
        if !issues.isEmpty {
            Section("问题") {
                ForEach(issues) { issue in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(issue.id)
                                .font(.caption.monospaced())
                            Text(issue.severity)
                                .font(.caption2)
                                .foregroundStyle(issue.severity == "blocker" ? .red : .orange)
                            Spacer()
                            Text(issue.status)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Text(issue.title)
                        Text(issue.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func ownerControls(group: AgentGroup, mission: TaskSession) -> some View {
        Section("群主操作") {
            if mission.status == "active" {
                Button("暂停任务") { decision = .pause }
            }
            if ["interrupted", "stalled", "protocol_error"].contains(mission.status)
                || (mission.status == "waiting_human" && (
                    mission.interruptionReason == "owner_paused"
                        || mission.interruptionReason?.hasPrefix("required_member_offline:") == true
                        || mission.interruptionReason?.hasPrefix("owner_attention:") == true
                )) {
                Button("恢复任务") { decision = .resume }
            }
            if mission.status == "external_change_detected" {
                if mission.phases?.contains(where: {
                    $0.roleId == "role-developer" && $0.leaderMemberId != nil
                }) == true {
                    Button("纳入并交研发核对") { decision = .incorporateExternalChanges }
                }
                Button("移除外部变更") { decision = .discardExternalChanges }
            }
            if mission.status == "waiting_human",
               mission.interruptionReason == "awaiting_external_implementation" {
                Button("导入外部实现修订") { decision = .importExternalImplementation }
            }
            if mission.status == "ready_for_owner" {
                Button("退回研发修改") { decision = .requestChanges }
                Button("验收并完成") { decision = .complete }
            }
            if mission.status == "waiting_human", mission.interruptionReason?.contains("fuse") == true {
                Stepper("追加返工轮次：\(additionalRounds)", value: $additionalRounds, in: 1...10)
                Button("追加返工轮次") { decision = .extendRework }
                if !unresolvedIssues.isEmpty {
                    Button("接受当前未解决风险") { decision = .acceptRisk }
                }
            }
            if !mission.isTerminal {
                Button("取消任务", role: .destructive) { decision = .cancel }
            }
        }
    }

    private func runDecision() {
        guard let group, let mission, let decision, !isWorking else { return }
        let note = decisionNote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty else { return }
        isWorking = true
        errorText = nil
        self.decision = nil

        Task { @MainActor in
            defer {
                isWorking = false
                decisionNote = ""
                reassignment = nil
            }
            do {
                switch decision {
                case .acceptRisk:
                    _ = try await store.acceptMissionRisk(
                        group: group,
                        mission: mission,
                        issueIds: unresolvedIssues.map(\.id),
                        note: note,
                        serverId: serverId,
                    )
                case .extendRework:
                    _ = try await store.extendMissionRework(
                        group: group,
                        mission: mission,
                        additionalRounds: additionalRounds,
                        note: note,
                        serverId: serverId,
                    )
                case .incorporateExternalChanges:
                    _ = try await store.resolveMissionExternalChanges(
                        group: group,
                        mission: mission,
                        decision: "incorporate",
                        note: note,
                        serverId: serverId
                    )
                case .discardExternalChanges:
                    _ = try await store.resolveMissionExternalChanges(
                        group: group,
                        mission: mission,
                        decision: "discard",
                        note: note,
                        serverId: serverId
                    )
                case .importExternalImplementation:
                    _ = try await store.importMissionExternalImplementation(
                        group: group,
                        mission: mission,
                        note: note,
                        serverId: serverId
                    )
                case .reassign:
                    guard let reassignment else { return }
                    _ = try await store.reassignMissionWorkItem(
                        group: group,
                        mission: mission,
                        workItem: reassignment.workItem,
                        targetMemberId: reassignment.targetMemberId,
                        note: note,
                        serverId: serverId,
                    )
                default:
                    let action: String
                    switch decision {
                    case .pause: action = "pause"
                    case .resume: action = "resume"
                    case .requestChanges: action = "request-changes"
                    case .complete: action = "complete"
                    case .cancel: action = "cancel"
                    default: return
                    }
                    _ = try await store.missionOwnerAction(
                        group: group,
                        mission: mission,
                        action: action,
                        note: note,
                        serverId: serverId,
                    )
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}

private struct ChatMentionReference: Identifiable, Equatable {
    let id = UUID()
    let text: String
}

private struct ChatMissionRequest: Identifiable {
    let groupId: String
    let missionId: String?

    var id: String { "\(groupId):\(missionId ?? "new")" }
}

private struct ChatModelPickerRequest: Identifiable {
    let groupId: String
    let agentId: String

    var id: String { "\(groupId):\(agentId)" }
}

private enum ChatScrollAnchor: Hashable {
    case bottom
}

private struct ChatKeyboardLayoutChange: Equatable {
    var revision = 0
    var height: CGFloat = 0
    var animationDuration = 0.25
    var animationCurve = UIView.AnimationCurve.easeInOut.rawValue
}

private func chatKeyboardOverlapHeight(from notification: Notification) -> CGFloat {
    guard let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
        return 0
    }

    guard let window = UIApplication.shared.octrixKeyWindow else {
        return max(0, UIScreen.main.bounds.height - keyboardFrame.minY)
    }

    let frameInWindow = window.convert(keyboardFrame, from: nil)
    let overlap = window.bounds.intersection(frameInWindow).height
    return max(0, overlap - window.safeAreaInsets.bottom)
}

private func chatKeyboardAnimationDuration(from notification: Notification) -> Double {
    let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
    return min(max(duration, 0.01), 0.6)
}

private func chatKeyboardAnimationCurve(from notification: Notification) -> Int {
    notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int
        ?? UIView.AnimationCurve.easeInOut.rawValue
}

private func chatKeyboardAnimation(duration: Double, curve: Int) -> Animation {
    let clampedDuration = min(max(duration, 0.01), 0.6)
    switch UIView.AnimationCurve(rawValue: curve) {
    case .easeIn:
        return .easeIn(duration: clampedDuration)
    case .easeOut:
        return .easeOut(duration: clampedDuration)
    case .linear:
        return .linear(duration: clampedDuration)
    default:
        return .easeInOut(duration: clampedDuration)
    }
}

private extension UIApplication {
    var octrixKeyWindow: UIWindow? {
        connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
    }
}

private struct ChatInputBarHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct ChatBottomDistancePreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private enum ChatModelPickerMode: String, CaseIterable, Identifiable {
    case model
    case effort

    var id: String { rawValue }

    var title: String {
        switch self {
        case .model: "切换模型"
        case .effort: "选择思考程度"
        }
    }

    var tabTitle: String {
        switch self {
        case .model: "模型"
        case .effort: "思考程度"
        }
    }

    var currentLabel: String {
        switch self {
        case .model: "当前模型"
        case .effort: "当前思考程度"
        }
    }

    var unavailableTitle: String {
        switch self {
        case .model: "无法切换模型"
        case .effort: "无法选择思考程度"
        }
    }

    var loadingText: String {
        switch self {
        case .model: "正在打开模型选择器…"
        case .effort: "正在打开思考程度选择器…"
        }
    }
}

private struct WorkspaceFilePreviewTarget: Identifiable, Hashable {
    let relativePath: String

    var id: String { relativePath }
}

private func formatWorkspaceFileReference(_ relativePath: String) -> String {
    "`file:\(relativePath)` "
}

private func missionStatusLabel(_ status: String) -> String {
    switch status {
    case "draft": return "待群主确认"
    case "preparing": return "准备中"
    case "active": return "自治运行中"
    case "waiting_human": return "等待群主决策"
    case "stalled": return "已停滞"
    case "interrupted": return "已中断"
    case "protocol_error": return "协议异常"
    case "external_change_detected": return "检测到外部变更"
    case "ready_for_owner": return "等待群主处理"
    case "completed": return "已完成"
    case "cancelled": return "已取消"
    default: return status
    }
}

private func missionStatusColor(_ status: String) -> Color {
    switch status {
    case "active": return .green
    case "waiting_human", "ready_for_owner", "protocol_error", "external_change_detected": return .orange
    case "cancelled": return .red
    case "completed": return .blue
    default: return .secondary
    }
}

/// 群聊界面：按任务会话查看消息、发送消息给群内 agent。
struct ChatView: View {
    @EnvironmentObject private var store: AppStore
    let serverId: String
    let groupId: String
    let onOpenGroup: (ConversationRoute) -> Void

    @State private var selectedTaskSessionId: String?
    @State private var isSending = false
    @State private var isRestoringGroup = false
    @State private var startingMemberId: String?
    @State private var sendError: String?
    @State private var showWorkspaceBrowser = false
    @State private var createMissionRequest: ChatMissionRequest?
    @State private var showMissionControl = false
    @State private var pendingFileReference: WorkspaceFileReference?
    @State private var pendingMentionReference: ChatMentionReference?
    @State private var modelPickerRequest: ChatModelPickerRequest?
    @State private var modelSwitchNotice: String?
    @State private var pendingStartupPrompts: [AgentStartupPrompt] = []
    @State private var isResolvingStartupPrompt = false
    @State private var isVoiceInputActive = false
    @State private var keyboardLayoutChange = ChatKeyboardLayoutChange()
    @State private var inputBarHeight: CGFloat = 0
    @State private var messageListAutoScrollEnabled = true
    @State private var messageListUserDidDrag = false
    @State private var messageListIsInteracting = false
    @State private var messageListBottomDistance: CGFloat = 0
    @State private var messageListSettleTask: Task<Void, Never>?
    @State private var messageListInteractionResetTask: Task<Void, Never>?

    private var group: AgentGroup? {
        store.group(serverId: serverId, groupId: groupId)
    }

    init(
        serverId: String,
        groupId: String,
        onOpenGroup: @escaping (ConversationRoute) -> Void = { _ in }
    ) {
        self.serverId = serverId
        self.groupId = groupId
        self.onOpenGroup = onOpenGroup
    }

    var body: some View {
        if let group {
            content(group)
        } else {
            ContentUnavailableView("群组不存在", systemImage: "person.3")
        }
    }

    private func currentSessionId(_ group: AgentGroup) -> String? {
        selectedTaskSessionId ?? group.activeTaskSessionId
    }

    @ViewBuilder
    private func content(_ group: AgentGroup) -> some View {
        let sessionId = currentSessionId(group)
        let session = store.session(serverId: serverId, id: sessionId)
        let groupMessages = store.messagesFor(serverId: serverId, groupId: group.id, taskSessionId: sessionId)
        let canInsertSelectedFile = canInsertFileReference(group: group, session: session, sessionId: sessionId)

        VStack(spacing: 0) {
            if !group.isDirectChat {
                memberStrip(group)
                Divider()
                if let session, session.isMission {
                    missionBanner(group: group, mission: session)
                    Divider()
                }
            }

            if let prompt = pendingStartupPrompts.first {
                agentStartupPromptBanner(prompt)
                Divider()
            }

            messageList(group: group, messages: groupMessages, keyboardLayoutChange: keyboardLayoutChange)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                inputBar(
                    group: group,
                    session: session,
                    sessionId: sessionId,
                    keyboardLayoutChange: keyboardLayoutChange
                )
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(key: ChatInputBarHeightPreferenceKey.self, value: proxy.size.height)
                        },
                    )
            }
            .background(Color(.systemBackground))
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                chatNavigationTitle(group: group, session: session)
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if !isVoiceInputActive {
                    if group.isDirectChat,
                       let agent = store.uniqueAgents(in: group, serverId: serverId).first,
                       supportsModelPicker(agent) {
                        Button {
                            openModelPicker(agent, in: group)
                        } label: {
                            Image(systemName: "cpu")
                        }
                        .accessibilityLabel("切换模型")
                        .disabled(!store.runningAgentIds(in: group, serverId: serverId).contains(agent.id))
                    }

                    if !group.isDirectChat {
                        Button {
                            openMissionCreator(group)
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("新建协作主任务")
                    }
                }

                Button {
                    showWorkspaceBrowser = true
                } label: {
                    Image(systemName: "folder")
                }
                .accessibilityLabel("浏览工作区文件")

                if !isVoiceInputActive, !group.isDirectChat {
                    taskMenu(group, currentId: sessionId)
                }
            }
        }
        .sheet(isPresented: $showWorkspaceBrowser) {
            WorkspaceBrowserSheet(
                serverId: serverId,
                group: group,
                canInsertFileReference: canInsertSelectedFile
            ) { relativePath in
                pendingFileReference = WorkspaceFileReference(text: formatWorkspaceFileReference(relativePath))
                showWorkspaceBrowser = false
            }
            .environmentObject(store)
        }
        .sheet(item: $createMissionRequest) { request in
            NavigationStack {
                CreateMissionView(
                    serverId: serverId,
                    initialGroupId: request.groupId,
                    lockSelectedGroup: true,
                    initialMission: store.session(serverId: serverId, id: request.missionId)
                ) { _, mission in
                    createMissionRequest = nil
                    selectedTaskSessionId = mission.id
                }
            }
            .environmentObject(store)
        }
        .sheet(isPresented: $showMissionControl) {
            if let missionId = session?.isMission == true ? session?.id : nil {
                NavigationStack {
                    MissionControlView(serverId: serverId, groupId: group.id, missionId: missionId)
                }
                .environmentObject(store)
            }
        }
        .sheet(item: $modelPickerRequest) { request in
            if let currentGroup = store.group(serverId: serverId, groupId: request.groupId),
               let agent = store.agent(serverId: serverId, id: request.agentId) {
                NavigationStack {
                    ModelPickerSheet(
                        serverId: serverId,
                        group: currentGroup,
                        agent: agent,
                    )
                }
                .environmentObject(store)
            } else {
                ContentUnavailableView("AI 不存在", systemImage: "cpu")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            registerKeyboardLayoutChange(from: notification)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { notification in
            registerKeyboardLayoutChange(from: notification)
        }
        .onPreferenceChange(ChatInputBarHeightPreferenceKey.self) { height in
            registerInputBarHeightChange(height)
        }
        .onAppear {
            store.beginViewingConversation(serverId: serverId, groupId: group.id)
        }
        .onDisappear {
            store.endViewingConversation(serverId: serverId, groupId: group.id)
            cancelMessageListSettle()
            cancelMessageListInteractionReset()
        }
        .task(id: "\(group.id):\(sessionId ?? "")") {
            store.beginViewingConversation(serverId: serverId, groupId: group.id)
            await store.loadRecentMessages(serverId: serverId, groupId: group.id, taskSessionId: sessionId)
        }
        .task(id: "startup-prompts:\(group.id)") {
            await pollAgentStartupPrompts(groupId: group.id)
        }
        .alert("出错了", isPresented: Binding(
            get: { sendError != nil },
            set: { if !$0 { sendError = nil } },
        )) {
            Button("好", role: .cancel) { sendError = nil }
        } message: {
            Text(sendError ?? "")
        }
        .alert("暂时无法切换模型", isPresented: Binding(
            get: { modelSwitchNotice != nil },
            set: { if !$0 { modelSwitchNotice = nil } },
        )) {
            Button("知道了", role: .cancel) { modelSwitchNotice = nil }
        } message: {
            Text(modelSwitchNotice ?? "")
        }
    }

    private func chatNavigationTitle(group: AgentGroup, session: TaskSession?) -> some View {
        let directAgent = group.isDirectChat ? store.uniqueAgents(in: group, serverId: serverId).first : nil
        return HStack(spacing: 7) {
            if let directAgent {
                AgentPresenceIndicator(
                    state: agentPresence(directAgent, in: group),
                    detail: store.agentError(agent: directAgent, in: group, serverId: serverId),
                    size: 9,
                    borderWidth: 1.5,
                )
                .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text(group.name)
                    .font(.headline)
                    .lineLimit(1)
                if let directAgent {
                    Text("\(directAgent.name) · \(agentStatusText(agent: directAgent, in: group))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let session {
                    Text(session.title + (session.isArchived ? "（已归档）" : ""))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(navigationTitleAccessibilityLabel(group: group, directAgent: directAgent))
    }

    private func agentStartupPromptBanner(_ prompt: AgentStartupPrompt) -> some View {
        let isBypassPermissions = prompt.kind == .bypassPermissions
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(isBypassPermissions ? "确认 Bypass Permissions 模式" : "确认工作目录信任")
                        .font(.subheadline.weight(.semibold))
                    Text(startupPromptMessage(prompt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 10) {
                Button("退出 \(prompt.agentName)", role: .destructive) {
                    resolveAgentStartupPrompt(prompt, action: .decline)
                }
                .buttonStyle(.bordered)
                .disabled(isResolvingStartupPrompt)

                Spacer()

                Button(isBypassPermissions ? "我了解风险，继续" : "信任并继续") {
                    resolveAgentStartupPrompt(prompt, action: .accept)
                }
                .buttonStyle(.borderedProminent)
                .tint(isBypassPermissions ? .orange : .accentColor)
                .disabled(isResolvingStartupPrompt)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.orange.opacity(0.08))
        .accessibilityElement(children: .contain)
    }

    private func startupPromptMessage(_ prompt: AgentStartupPrompt) -> String {
        switch prompt.kind {
        case .bypassPermissions:
            return "Claude Code 在此模式下不会在执行潜在危险命令前请求批准。仅应在网络受限、可轻松恢复的沙箱或虚拟机中使用。"
        case .workspaceTrust:
            return "\(prompt.agentName) 请求信任工作目录：\(prompt.directory)"
        }
    }

    @MainActor
    private func pollAgentStartupPrompts(groupId: String) async {
        while !Task.isCancelled {
            do {
                pendingStartupPrompts = try await store.agentStartupPrompts(serverId: serverId, groupId: groupId)
            } catch {
                // State refresh and the existing connection UI report transient relay failures.
            }
            try? await Task.sleep(for: .milliseconds(750))
        }
    }

    private func resolveAgentStartupPrompt(
        _ prompt: AgentStartupPrompt,
        action: AgentStartupPromptAction
    ) {
        guard !isResolvingStartupPrompt else { return }
        isResolvingStartupPrompt = true
        Task {
            defer { isResolvingStartupPrompt = false }
            do {
                let response = try await store.resolveAgentStartupPrompts(
                    serverId: serverId,
                    groupId: prompt.groupId,
                    action: action,
                    agentIds: [prompt.agentId],
                    expectedPrompts: [prompt],
                )
                pendingStartupPrompts = response.prompts
            } catch {
                sendError = error.localizedDescription
            }
        }
    }

    private func missionBanner(group: AgentGroup, mission: TaskSession) -> some View {
        Button {
            if mission.status == "draft" {
                createMissionRequest = ChatMissionRequest(groupId: group.id, missionId: mission.id)
            } else {
                showMissionControl = true
            }
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(missionStatusColor(mission.status))
                    .frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(mission.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(missionStatusLabel(mission.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let phase = mission.phases?.first(where: { $0.id == mission.currentPhaseId }) {
                    Text(phase.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Image(systemName: mission.status == "draft" ? "slider.horizontal.3" : "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground))
        }
        .buttonStyle(.plain)
    }

    private func navigationTitleAccessibilityLabel(group: AgentGroup, directAgent: Agent?) -> String {
        guard let directAgent else { return group.name }
        return "\(group.name)，\(directAgent.name)，\(agentStatusText(agent: directAgent, in: group))"
    }

    private func supportsModelPicker(_ agent: Agent) -> Bool {
        switch agent.platform {
        case "claude-code", "openclaude", "openai-codex-cli", "github-copilot-cli":
            return true
        default:
            return false
        }
    }

    private func openModelPicker(_ agent: Agent, in group: AgentGroup) {
        let availability = ModelSwitchAvailabilityPolicy.evaluate(
            isRunning: store.runningAgentIds(in: group, serverId: serverId).contains(agent.id),
            isBusy: agentPresence(agent, in: group) == .busy,
            isVoiceInputActive: isVoiceInputActive
        )
        switch availability {
        case .allowed:
            modelPickerRequest = ChatModelPickerRequest(groupId: group.id, agentId: agent.id)
        case .busy:
            modelSwitchNotice = "AI 正在工作，请等待当前任务完成后再切换模型。"
        case .voiceInputActive:
            sendError = "语音输入期间不能切换模型"
        case .offline:
            sendError = "AI 当前离线，请先上线"
        }
    }

    private func agentAvatar(_ agent: Agent, size: CGFloat, in group: AgentGroup) -> some View {
        AgentAvatarView(
            platform: agent.platform,
            name: agent.name,
            color: AgentColorPalette.color(for: agent.avatarColor),
            size: size,
            cornerRadius: size / 2,
            circular: true,
        )
        .overlay(alignment: .bottomLeading) {
            AgentPresenceIndicator(
                state: agentPresence(agent, in: group),
                detail: store.agentError(agent: agent, in: group, serverId: serverId),
                size: max(8, size * 0.32),
                borderWidth: max(1.5, size * 0.06),
            )
            .offset(x: -1, y: 1)
        }
    }

    // MARK: - 成员条

    private func memberStrip(_ group: AgentGroup) -> some View {
        let running = store.runningAgentIds(in: group, serverId: serverId)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.uniqueAgents(in: group, serverId: serverId)) { agent in
                    let member = member(for: agent, in: group)
                    let mentionText = mentionText(for: agent, in: group)
                    let isOnline = running.contains(agent.id)
                    let isStarting = member?.id == startingMemberId
                    let presence = agentPresence(agent, in: group)
                    HStack(spacing: 5) {
                        Menu {
                            if supportsModelPicker(agent) {
                                if isOnline {
                                    Button {
                                        openModelPicker(agent, in: group)
                                    } label: {
                                        Label("切换模型", systemImage: "cpu")
                                    }
                                } else {
                                    Button("请先上线") {}
                                        .disabled(true)
                                }
                            } else {
                                Button("暂不支持模型切换") {}
                                    .disabled(true)
                            }
                        } label: {
                            agentAvatar(agent, size: 30, in: group)
                        }
                        .accessibilityLabel("\(agent.name) 模型，\(presence.label)")
                        .simultaneousGesture(
                            LongPressGesture(minimumDuration: 0.45)
                                .onEnded { _ in
                                    queueMention(mentionText)
                                },
                        )

                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 4) {
                                Text(agent.name)
                                    .font(.caption)
                                Text(presence.label)
                                    .font(.caption2)
                                    .foregroundStyle(presence.foregroundColor)
                            }
                            if let role = store.roleName(of: agent.name, in: group, serverId: serverId) {
                                HStack(spacing: 3) {
                                    Text(role)
                                    if let member, group.roleLeaders?[member.roleId ?? ""] == member.id {
                                        Image(systemName: "crown.fill")
                                        Text("Leader")
                                    }
                                }
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            }
                        }
                        if !group.isArchived, !isOnline, let member {
                            Button {
                                startMember(member, in: group)
                            } label: {
                                if isStarting {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Label("上线", systemImage: "power")
                                }
                            }
                            .font(.caption2.weight(.semibold))
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                            .disabled(startingMemberId != nil)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color(.systemGray6)))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    // MARK: - 消息列表

    private func messageList(
        group: AgentGroup,
        messages: [Envelope],
        keyboardLayoutChange: ChatKeyboardLayoutChange
    ) -> some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        if messages.isEmpty {
                            Text(group.isDirectChat ? "还没有消息，开始和 AI 对话吧" : "还没有消息，开始给 AI 团队下发任务吧")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.top, 40)
                        }
                        ForEach(messages) { message in
                            let agent = store.agent(serverId: serverId, named: message.from)
                            MessageBubble(
                                message: message,
                                agent: agent,
                                roleName: store.roleName(of: message.from, in: group, serverId: serverId),
                                serverId: serverId,
                                group: group,
                                isDirectChat: group.isDirectChat,
                                avatarPresence: store.agentPresence(agent: agent, in: group, serverId: serverId),
                                agentError: store.agentError(agent: agent, in: group, serverId: serverId),
                                onLongPressAvatar: { agent in
                                    queueMention(mentionText(for: agent, in: group))
                                },
                            )
                            .equatable()
                            .id(message.id)
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(ChatScrollAnchor.bottom)
                            .background(
                                GeometryReader { bottomProxy in
                                    Color.clear.preference(
                                        key: ChatBottomDistancePreferenceKey.self,
                                        value: bottomProxy.frame(in: .named("chatMessageList")).maxY - viewport.size.height,
                                    )
                                },
                            )
                    }
                    .padding(.horizontal, group.isDirectChat ? 16 : 12)
                    .padding(.vertical, 10)
                }
                .coordinateSpace(name: "chatMessageList")
                .defaultScrollAnchor(messages.isEmpty ? .top : .bottom)
                .scrollDismissesKeyboard(.interactively)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 3)
                        .onChanged { _ in
                            registerMessageListDrag()
                        }
                        .onEnded { _ in
                            finishMessageListDrag()
                        },
                )
                .onPreferenceChange(ChatBottomDistancePreferenceKey.self) { distance in
                    updateMessageListAutoScroll(distanceFromBottom: distance)
                }
                .onAppear {
                    scrollMessageListToBottom(proxy, messages: messages, animated: false)
                    scheduleMessageListBottomSettle(proxy, messages: messages)
                }
                .onChange(of: messages.count) { _, _ in
                    guard shouldAutoScrollMessageList(messages: messages) else { return }
                    scrollMessageListToBottom(proxy, messages: messages, animated: true)
                    scheduleMessageListBottomSettle(proxy, messages: messages)
                }
                .onChange(of: lastMessageLayoutFingerprint(messages)) { _, _ in
                    guard shouldAutoScrollMessageList(messages: messages) else { return }
                    scrollMessageListToBottom(proxy, messages: messages, animated: false)
                    scheduleMessageListBottomSettle(proxy, messages: messages, delays: [0.05, 0.18, 0.35])
                }
                .onChange(of: keyboardLayoutChange) { _, change in
                    guard shouldAutoScrollMessageList(messages: messages) else { return }
                    scrollMessageListToBottom(
                        proxy,
                        messages: messages,
                        animated: true,
                        animation: chatKeyboardAnimation(
                            duration: change.animationDuration,
                            curve: change.animationCurve
                        )
                    )
                    scheduleMessageListBottomSettle(
                        proxy,
                        messages: messages,
                        delays: [change.animationDuration + 0.05, change.animationDuration + 0.2]
                    )
                }
            }
        }
    }

    private func updateMessageListAutoScroll(distanceFromBottom: CGFloat) {
        messageListBottomDistance = distanceFromBottom
        let threshold: CGFloat = 72
        if distanceFromBottom <= threshold {
            if !messageListIsInteracting {
                messageListAutoScrollEnabled = true
                messageListUserDidDrag = false
            }
        } else if messageListUserDidDrag {
            messageListAutoScrollEnabled = false
        }
    }

    private func shouldAutoScrollMessageList(messages: [Envelope]) -> Bool {
        guard !messageListIsInteracting else { return false }
        return messageListAutoScrollEnabled || messages.last?.from == "user"
    }

    private func registerMessageListDrag() {
        messageListUserDidDrag = true
        messageListIsInteracting = true
        cancelMessageListSettle()
        cancelMessageListInteractionReset()
    }

    private func finishMessageListDrag() {
        cancelMessageListInteractionReset()
        messageListInteractionResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            guard !Task.isCancelled else { return }
            messageListIsInteracting = false
            updateMessageListAutoScroll(distanceFromBottom: messageListBottomDistance)
        }
    }

    private func cancelMessageListInteractionReset() {
        messageListInteractionResetTask?.cancel()
        messageListInteractionResetTask = nil
    }

    private func lastMessageLayoutFingerprint(_ messages: [Envelope]) -> String {
        guard let message = messages.last else { return "" }
        let entriesFingerprint = (message.entries ?? [])
            .map { entry in
                [
                    entry.id,
                    entry.role,
                    entry.phase ?? "",
                    entry.toolName ?? "",
                    entry.humanInput?.status ?? "",
                    String(entry.content.count),
                ].joined(separator: ":")
            }
            .joined(separator: "|")
        return [
            message.id,
            message.status ?? "",
            String(message.body.count),
            entriesFingerprint,
        ].joined(separator: "#")
    }

    private func registerKeyboardLayoutChange(from notification: Notification) {
        let height = chatKeyboardOverlapHeight(from: notification)
        let duration = chatKeyboardAnimationDuration(from: notification)
        let curve = chatKeyboardAnimationCurve(from: notification)
        guard abs(height - keyboardLayoutChange.height) > 0.5
            || abs(duration - keyboardLayoutChange.animationDuration) > 0.01
            || curve != keyboardLayoutChange.animationCurve else { return }

        keyboardLayoutChange = ChatKeyboardLayoutChange(
            revision: keyboardLayoutChange.revision + 1,
            height: height,
            animationDuration: duration,
            animationCurve: curve
        )
    }

    private func registerInputBarHeightChange(_ height: CGFloat) {
        guard abs(height - inputBarHeight) > 0.5 else { return }
        inputBarHeight = height
        keyboardLayoutChange = ChatKeyboardLayoutChange(
            revision: keyboardLayoutChange.revision + 1,
            height: keyboardLayoutChange.height,
            animationDuration: 0.18,
            animationCurve: UIView.AnimationCurve.easeOut.rawValue
        )
    }

    private func scrollMessageListToBottom(
        _ proxy: ScrollViewProxy,
        messages: [Envelope],
        animated: Bool,
        duration: Double = 0.2,
        animation: Animation? = nil
    ) {
        guard !messages.isEmpty else { return }
        let action = {
            proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
        }

        if let animation {
            withAnimation(animation) {
                action()
            }
        } else if animated {
            withAnimation(.easeOut(duration: duration)) {
                action()
            }
        } else {
            action()
        }
        messageListAutoScrollEnabled = true
        messageListUserDidDrag = false
    }

    private func scheduleMessageListBottomSettle(
        _ proxy: ScrollViewProxy,
        messages: [Envelope],
        after delay: Double = 0.05
    ) {
        scheduleMessageListBottomSettle(proxy, messages: messages, delays: [delay])
    }

    private func scheduleMessageListBottomSettle(
        _ proxy: ScrollViewProxy,
        messages: [Envelope],
        delays: [Double]
    ) {
        guard !messages.isEmpty else { return }
        cancelMessageListSettle()
        messageListSettleTask = Task { @MainActor in
            for delay in delays {
                try? await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
                guard !Task.isCancelled else { return }
                guard shouldAutoScrollMessageList(messages: messages) else { return }
                scrollMessageListToBottom(proxy, messages: messages, animated: false)
            }
        }
    }

    private func cancelMessageListSettle() {
        messageListSettleTask?.cancel()
        messageListSettleTask = nil
    }

    // MARK: - 输入区

    @ViewBuilder
    private func inputBar(
        group: AgentGroup,
        session: TaskSession?,
        sessionId: String?,
        keyboardLayoutChange: ChatKeyboardLayoutChange
    ) -> some View {
        if group.isArchived {
            actionBanner(text: "会话已归档，只读查看", buttonTitle: "恢复", isLoading: isRestoringGroup) {
                restoreGroup(group)
            }
        } else if group.isDirectChat && sessionId == nil {
            actionBanner(text: "单聊会话尚未就绪", buttonTitle: "刷新") {
                _ = Task { await store.refreshState(serverId: serverId) }
            }
        } else if group.isDirectChat,
                  let member = directMember(in: group),
                  let agent = store.agent(serverId: serverId, id: member.agentId),
                  !store.runningAgentIds(in: group, serverId: serverId).contains(agent.id) {
            offlineAgentBanner(agent: agent, member: member, in: group)
        } else if sessionId == nil {
            VStack(spacing: 0) {
                actionBanner(text: "群聊大厅：无 @ 消息只记录；正式协作请创建任务", buttonTitle: "创建任务") {
                    openMissionCreator(group)
                }
                Divider()
                ChatInputBar(
                    serverId: serverId,
                    group: group,
                    sessionId: nil,
                    isSending: $isSending,
                    sendError: $sendError,
                    pendingFileReference: $pendingFileReference,
                    pendingMentionReference: $pendingMentionReference,
                    isVoiceInputActive: $isVoiceInputActive,
                    keyboardLayoutChange: keyboardLayoutChange,
                )
            }
        } else if !group.isDirectChat, let session, session.isArchived {
            actionBanner(text: "该任务已归档，只读查看", buttonTitle: "回到当前任务") {
                selectedTaskSessionId = nil
            }
        } else {
            ChatInputBar(
                serverId: serverId,
                group: group,
                sessionId: sessionId,
                isSending: $isSending,
                sendError: $sendError,
                pendingFileReference: $pendingFileReference,
                pendingMentionReference: $pendingMentionReference,
                isVoiceInputActive: $isVoiceInputActive,
                keyboardLayoutChange: keyboardLayoutChange,
            )
        }
    }

    private func actionBanner(
        text: String,
        buttonTitle: String,
        isLoading: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        HStack {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if isLoading {
                ProgressView()
            } else {
                Button(buttonTitle, action: action)
                    .font(.caption.weight(.medium))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(.systemGray6))
    }

    private func offlineAgentBanner(
        agent: Agent,
        member: GroupMember,
        in group: AgentGroup
    ) -> some View {
        let isLoading = startingMemberId == member.id

        return HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color(.secondarySystemFill))
                Image(systemName: "wifi.slash")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(width: 36, height: 36)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("\(agent.name) 当前离线")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Text("上线后即可继续对话")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)

            Spacer(minLength: 4)

            Button {
                startMember(member, in: group)
            } label: {
                HStack(spacing: 6) {
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                        Text("上线中")
                    } else {
                        Image(systemName: "power")
                        Text("上线")
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .frame(minWidth: 72)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background {
                    Capsule(style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [Color.accentColor, Color.accentColor.opacity(0.78)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                }
                .shadow(color: Color.accentColor.opacity(0.22), radius: 6, y: 2)
            }
            .buttonStyle(.plain)
            .disabled(isLoading)
            .accessibilityHint("启动 AI 命令行会话")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemBackground))
                .shadow(color: .black.opacity(0.06), radius: 10, y: 2)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
    }

    // MARK: - 任务会话菜单

    private func taskMenu(_ group: AgentGroup, currentId: String?) -> some View {
        Menu {
            Section("任务会话") {
                ForEach(store.sessions(for: group, serverId: serverId)) { session in
                    Button {
                        selectedTaskSessionId = session.id
                    } label: {
                        if session.id == currentId {
                            Label(sessionLabel(session), systemImage: "checkmark")
                        } else {
                            Text(sessionLabel(session))
                        }
                    }
                }
            }
            Divider()
            Button {
                let current = store.session(serverId: serverId, id: group.activeTaskSessionId)
                createMissionRequest = ChatMissionRequest(
                    groupId: group.id,
                    missionId: current?.status == "draft" ? current?.id : nil,
                )
            } label: {
                let current = store.session(serverId: serverId, id: group.activeTaskSessionId)
                Label(current?.status == "draft" ? "继续配置草稿" : "新建主任务", systemImage: "plus")
            }
            .disabled(store.activeMission(for: group, serverId: serverId).map { !$0.isTerminal && $0.status != "draft" } == true)
        } label: {
            Image(systemName: "list.bullet.circle")
        }
    }

    private func sessionLabel(_ session: TaskSession) -> String {
        session.isArchived ? "\(session.title)（已归档）" : session.title
    }

    private func canInsertFileReference(group: AgentGroup, session: TaskSession?, sessionId: String?) -> Bool {
        guard !group.isArchived, sessionId != nil else { return false }
        if !group.isDirectChat, let session, session.isArchived {
            return false
        }
        if group.isDirectChat {
            guard let member = directMember(in: group),
                  let agent = store.agent(serverId: serverId, id: member.agentId) else { return false }
            return store.runningAgentIds(in: group, serverId: serverId).contains(agent.id)
        }
        return true
    }

    // MARK: - 动作

    private func openMissionCreator(_ group: AgentGroup) {
        guard !isVoiceInputActive else {
            sendError = "语音输入期间不能创建新任务"
            return
        }
        guard !group.isArchived else {
            sendError = "已归档会话不能创建新任务"
            return
        }
        guard !group.isDirectChat else {
            sendError = "单聊不支持协作主任务"
            return
        }
        if let active = store.activeMission(for: group, serverId: serverId), !active.isTerminal {
            if active.status == "draft" {
                createMissionRequest = ChatMissionRequest(groupId: group.id, missionId: active.id)
            } else {
                sendError = "当前群已有未完成的主任务"
            }
            return
        }
        createMissionRequest = ChatMissionRequest(groupId: group.id, missionId: nil)
    }

    private func restoreGroup(_ group: AgentGroup) {
        guard !isRestoringGroup else { return }
        isRestoringGroup = true
        Task {
            defer { isRestoringGroup = false }
            do {
                try await store.unarchiveGroup(group, serverId: serverId)
            } catch {
                sendError = error.localizedDescription
            }
        }
    }

    private func member(for agent: Agent, in group: AgentGroup) -> GroupMember? {
        group.members.first { $0.agentId == agent.id }
    }

    private func mentionText(for agent: Agent, in group: AgentGroup) -> String {
        let options = chatMentionSuggestions(
            for: store.uniqueAgents(in: group, serverId: serverId),
            roleName: { candidate in
                store.roleName(of: candidate.name, in: group, serverId: serverId)
            },
        )
        return options.first { $0.agentId == agent.id }?.insertText ?? agent.name
    }

    private func queueMention(_ mentionText: String) {
        guard !mentionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        pendingMentionReference = ChatMentionReference(text: mentionText)
    }

    private func directMember(in group: AgentGroup) -> GroupMember? {
        guard group.isDirectChat else { return nil }
        return group.members.first
    }

    private func localInitializingAgentIds(in group: AgentGroup) -> Set<String> {
        guard let startingMemberId,
              let member = group.members.first(where: { $0.id == startingMemberId }) else { return [] }
        return [member.agentId]
    }

    private func agentPresence(_ agent: Agent?, in group: AgentGroup) -> AgentPresenceState {
        store.agentPresence(
            agent: agent,
            in: group,
            serverId: serverId,
            initializingAgentIds: localInitializingAgentIds(in: group),
        )
    }

    private func agentStatusText(agent: Agent, in group: AgentGroup) -> String {
        agentPresence(agent, in: group).label
    }

    private func hasWorkingDirectory(_ group: AgentGroup) -> Bool {
        !(group.workingDirectory ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func startMember(_ member: GroupMember, in group: AgentGroup) {
        guard startingMemberId == nil else { return }
        startingMemberId = member.id
        Task {
            defer { startingMemberId = nil }
            do {
                try await store.goOnline(member: member, in: group, serverId: serverId)
            } catch {
                sendError = error.localizedDescription
            }
        }
    }
}

private struct ModelPickerSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let group: AgentGroup
    let agent: Agent

    @State private var picker: ModelPickerSnapshot?
    @State private var isStarting = true
    @State private var isChoosing = false
    @State private var errorMessage: String?
    @State private var didStart = false
    @State private var requestedMode: ChatModelPickerMode = .model
    @State private var suppressModeRestart = false

    private var activeMode: ChatModelPickerMode {
        if let picker, let mode = ChatModelPickerMode(rawValue: picker.pickerMode) {
            return mode
        }
        return requestedMode
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .navigationTitle(activeMode.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("关闭") {
                    if didStart {
                        Task { await sendRemote(.escape, dismissAfterInput: true) }
                    } else {
                        dismiss()
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await refreshPicker() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isStarting || isChoosing)
                .accessibilityLabel("刷新模型选择器")
            }
        }
        .task(id: "\(serverId):\(group.id):\(agent.id)") {
            await runPickerLoop()
        }
        .onChange(of: requestedMode) { _, mode in
            if suppressModeRestart {
                suppressModeRestart = false
                return
            }
            Task { await restartPicker(mode: mode) }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                AgentAvatarView(
                    platform: agent.platform,
                    name: agent.name,
                    color: AgentColorPalette.color(for: agent.avatarColor),
                    size: 34,
                    cornerRadius: 17,
                    circular: true,
                )
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.name)
                        .font(.headline)
                        .lineLimit(1)
                    Text(SupportedAgentCatalog.cliLabel(for: agent.platform))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if isStarting || isChoosing {
                    ProgressView()
                }
            }

            Picker("选择类型", selection: $requestedMode) {
                ForEach(ChatModelPickerMode.allCases) { mode in
                    Text(mode.tabTitle).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .disabled(isStarting || isChoosing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if let errorMessage {
            ContentUnavailableView(
                activeMode.unavailableTitle,
                systemImage: "exclamationmark.triangle",
                description: Text(errorMessage),
            )
        } else if let picker, !picker.options.isEmpty, !picker.isFallback {
            modelList(picker)
        } else if let picker, picker.isFallback {
            fallbackControls(picker)
        } else {
            VStack(spacing: 12) {
                ProgressView()
                Text(activeMode.loadingText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func modelList(_ picker: ModelPickerSnapshot) -> some View {
        let mode = ChatModelPickerMode(rawValue: picker.pickerMode) ?? activeMode
        return List {
            ForEach(Array(picker.options.enumerated()), id: \.element.id) { index, option in
                Button {
                    Task { await chooseOption(index) }
                } label: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(option.label)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            if option.current {
                                Text(mode.currentLabel)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if picker.selectedIndex == index || option.current {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
                .disabled(isChoosing)
            }

            if let error = picker.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .listStyle(.plain)
    }

    private func fallbackControls(_ picker: ModelPickerSnapshot) -> some View {
        VStack(spacing: 14) {
            ScrollView {
                Text(picker.rawPreview.isEmpty ? "等待 TUI 输出…" : picker.rawPreview)
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.secondarySystemBackground)),
            )

            HStack(spacing: 12) {
                Button {
                    Task { await sendRemote(.up) }
                } label: {
                    Image(systemName: "chevron.up")
                        .frame(width: 44, height: 38)
                }
                .buttonStyle(.bordered)
                .disabled(isChoosing)

                Button {
                    Task { await sendRemote(.down) }
                } label: {
                    Image(systemName: "chevron.down")
                        .frame(width: 44, height: 38)
                }
                .buttonStyle(.bordered)
                .disabled(isChoosing)

                Button {
                    Task { await sendRemote(.enter, dismissAfterInput: true) }
                } label: {
                    Image(systemName: "return")
                        .frame(width: 54, height: 38)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isChoosing)

                Button(role: .cancel) {
                    Task { await sendRemote(.escape, dismissAfterInput: true) }
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 38)
                }
                .buttonStyle(.bordered)
                .disabled(isChoosing)
            }
        }
        .padding(16)
    }

    private func runPickerLoop() async {
        do {
            if !didStart {
                isStarting = true
                applyPicker(try await store.startModelPicker(
                    serverId: serverId,
                    groupId: group.id,
                    agentId: agent.id,
                    mode: requestedMode.rawValue,
                ))
                didStart = true
                isStarting = false
            }

            while !Task.isCancelled {
                try await Task.sleep(for: .milliseconds(600))
                await refreshPicker()
            }
        } catch is CancellationError {
            return
        } catch {
            isStarting = false
            errorMessage = error.localizedDescription
        }
    }

    private func refreshPicker() async {
        do {
            applyPicker(try await store.modelPicker(serverId: serverId, groupId: group.id, agentId: agent.id))
        } catch {
            if didStart {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func restartPicker(mode: ChatModelPickerMode) async {
        guard didStart, !isChoosing else { return }
        isStarting = true
        errorMessage = nil
        picker = nil
        defer { isStarting = false }
        do {
            applyPicker(try await store.startModelPicker(
                serverId: serverId,
                groupId: group.id,
                agentId: agent.id,
                mode: mode.rawValue,
            ))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func applyPicker(_ next: ModelPickerSnapshot) {
        picker = next
        guard let mode = ChatModelPickerMode(rawValue: next.pickerMode), mode != requestedMode else { return }
        suppressModeRestart = true
        requestedMode = mode
    }

    private func chooseOption(_ index: Int) async {
        guard !isChoosing else { return }
        isChoosing = true
        defer { isChoosing = false }
        do {
            let next = try await store.chooseModel(
                serverId: serverId,
                groupId: group.id,
                agentId: agent.id,
                optionIndex: index,
            )
            applyPicker(next)
            if next.status == "chosen" {
                dismiss()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sendRemote(_ action: ModelPickerInputAction, dismissAfterInput: Bool = false) async {
        guard !isChoosing else { return }
        isChoosing = true
        defer { isChoosing = false }
        do {
            applyPicker(try await store.sendModelPickerInput(
                serverId: serverId,
                groupId: group.id,
                agentId: agent.id,
                action: action,
            ))
            if dismissAfterInput {
                dismiss()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct WorkspaceBrowserSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let group: AgentGroup
    let canInsertFileReference: Bool
    let onSelectFile: (String) -> Void

    @State private var subpathStack: [String] = []
    @State private var currentPath = ""
    @State private var files: [WorkspaceFileEntry] = []
    @State private var gitStatus: GitWorkspaceStatus?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var previewTarget: WorkspaceFilePreviewTarget?

    private var currentSubpath: String {
        subpathStack.joined(separator: "/")
    }

    private var hasWorkingDirectory: Bool {
        !(group.workingDirectory ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var branchLabel: String {
        guard let gitStatus else { return "Git 状态未知" }
        guard gitStatus.isGitRepository else { return "非 Git 仓库" }
        return gitStatus.branch.map { "Git · \($0)" } ?? "Git 仓库"
    }

    private var displayPath: String {
        if !currentPath.isEmpty { return currentPath }
        return group.workingDirectory ?? "未配置工作目录"
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Divider()
                content
            }
            .navigationTitle("工作区")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await loadWorkspace() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(isLoading || !hasWorkingDirectory)
                    .accessibilityLabel("刷新工作区")
                }
            }
            .task(id: "\(serverId):\(group.id)") {
                await loadWorkspace()
            }
            .navigationDestination(item: $previewTarget) { target in
                WorkspaceFilePreviewView(serverId: serverId, groupId: group.id, relativePath: target.relativePath)
                    .environmentObject(store)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                Text(displayPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(hasWorkingDirectory ? .primary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            HStack(spacing: 8) {
                Label(branchLabel, systemImage: gitStatus?.isGitRepository == true ? "arrow.triangle.branch" : "minus.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                if !currentSubpath.isEmpty {
                    Text(currentSubpath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        if !hasWorkingDirectory {
            ContentUnavailableView("未配置工作目录", systemImage: "folder.badge.questionmark")
        } else if isLoading {
            VStack(spacing: 12) {
                ProgressView()
                Text("正在读取工作区…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            ContentUnavailableView(
                "无法读取工作区",
                systemImage: "exclamationmark.triangle",
                description: Text(errorMessage),
            )
        } else if files.isEmpty {
            List {
                parentDirectoryRow
                Text("目录为空")
                    .foregroundStyle(.secondary)
            }
            .listStyle(.plain)
            .refreshable {
                await loadWorkspace()
            }
        } else {
            List {
                parentDirectoryRow
                ForEach(files) { file in
                    workspaceRow(file)
                }
            }
            .listStyle(.plain)
            .refreshable {
                await loadWorkspace()
            }
        }
    }

    @ViewBuilder
    private var parentDirectoryRow: some View {
        if !subpathStack.isEmpty {
            Button {
                subpathStack.removeLast()
                Task { await loadWorkspace() }
            } label: {
                Label("上一级", systemImage: "arrow.uturn.left")
            }
        }
    }

    private func workspaceRow(_ file: WorkspaceFileEntry) -> some View {
        let relativePath = relativePath(for: file)
        return HStack(spacing: 10) {
            Image(systemName: file.isDirectory ? "folder.fill" : "doc")
                .foregroundStyle(file.isDirectory ? Color.accentColor : Color.secondary)
                .frame(width: 22)
            Text(file.name)
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer()
            if file.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else if !canInsertFileReference {
                Image(systemName: "lock")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if file.isDirectory {
                subpathStack.append(file.name)
                Task { await loadWorkspace() }
            } else {
                previewTarget = WorkspaceFilePreviewTarget(relativePath: relativePath)
            }
        }
        .onLongPressGesture(minimumDuration: 0.45) {
            guard canInsertFileReference else { return }
            onSelectFile(relativePath)
        }
    }

    private func loadWorkspace() async {
        guard hasWorkingDirectory else {
            files = []
            currentPath = ""
            gitStatus = nil
            errorMessage = nil
            isLoading = false
            return
        }

        isLoading = true
        errorMessage = nil
        do {
            let response = try await store.listGroupFiles(serverId: serverId, groupId: group.id, subpath: currentSubpath)
            files = response.files
            currentPath = response.path
            gitStatus = try? await store.gitStatus(serverId: serverId, groupId: group.id)
        } catch {
            files = []
            currentPath = ""
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func relativePath(for file: WorkspaceFileEntry) -> String {
        ([currentSubpath, file.name])
            .filter { !$0.isEmpty }
            .joined(separator: "/")
    }
}

private struct WorkspaceFilePreviewView: View {
    @EnvironmentObject private var store: AppStore

    let serverId: String
    let groupId: String
    let relativePath: String

    @State private var fileContent: WorkspaceFileContentResponse?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("正在读取文件…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                ContentUnavailableView(
                    "无法预览文件",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage),
                )
            } else if let fileContent {
                previewContent(fileContent)
            } else {
                ContentUnavailableView("暂无内容", systemImage: "doc.text")
            }
        }
        .navigationTitle(relativePath.components(separatedBy: "/").last ?? relativePath)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: relativePath) {
            await loadContent()
        }
        .refreshable {
            await loadContent()
        }
    }

    @ViewBuilder
    private func previewContent(_ fileContent: WorkspaceFileContentResponse) -> some View {
        if fileContent.isBinary {
            ContentUnavailableView(
                "二进制文件不可预览",
                systemImage: "doc",
                description: Text("\(formattedBytes(fileContent.size)) · \(relativePath)"),
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if fileContent.truncated {
                        Text("仅显示前 \(formattedBytes(fileContent.content.utf8.count))，文件总大小 \(formattedBytes(fileContent.size))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground)))
                    }
                    Text(fileContent.content.isEmpty ? "空文件" : fileContent.content)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(14)
            }
            .background(Color(.systemBackground))
        }
    }

    private func loadContent() async {
        isLoading = true
        errorMessage = nil
        do {
            fileContent = try await store.readGroupFile(serverId: serverId, groupId: groupId, path: relativePath)
        } catch {
            fileContent = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func formattedBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private enum ChatCompletionKind: Equatable {
    case mention
    case slash
}

private struct ChatInputActiveToken: Equatable {
    let kind: ChatCompletionKind
    let triggerStart: Int
    let query: String
}

private struct MentionSuggestion: Identifiable, Hashable {
    let id: String
    let label: String
    let insertText: String
    let agentId: String?
    let isAll: Bool
}

private func chatMentionSuggestions(
    for agents: [Agent],
    roleName: (Agent) -> String?
) -> [MentionSuggestion] {
    var roleCount: [String: Int] = [:]
    for agent in agents {
        if let roleName = roleName(agent) {
            roleCount[roleName, default: 0] += 1
        }
    }

    var roleIndex: [String: Int] = [:]
    return agents.map { agent in
        if let roleName = roleName(agent) {
            let count = roleCount[roleName] ?? 1
            if count > 1 {
                let next = (roleIndex[roleName] ?? 0) + 1
                roleIndex[roleName] = next
                let tag = "\(roleName)(\(agent.name))-\(next)"
                return MentionSuggestion(id: agent.id, label: tag, insertText: tag, agentId: agent.id, isAll: false)
            }
            return MentionSuggestion(
                id: agent.id,
                label: "\(roleName)（\(agent.name)）",
                insertText: roleName,
                agentId: agent.id,
                isAll: false,
            )
        }
        return MentionSuggestion(id: agent.id, label: agent.name, insertText: agent.name, agentId: agent.id, isAll: false)
    }
}

private enum SlashMenuSource: Equatable {
    case builtin
    case cli(platform: String, agentName: String, cliLabel: String)
}

private struct BuiltinSlashItem: Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let insertText: String
    let sourceTag: String
}

private enum SlashSuggestion: Identifiable, Hashable {
    case builtin(BuiltinSlashItem)
    case skill(SkillListItem)
    case command(CliCommandItem)

    var id: String {
        switch self {
        case .builtin(let item): return "builtin:\(item.id)"
        case .skill(let item): return "skill:\(item.id)"
        case .command(let item): return "command:\(item.id)"
        }
    }

    var title: String {
        switch self {
        case .builtin(let item): return item.insertText
        case .skill(let item): return "/\(item.name)"
        case .command(let item): return item.insertText
        }
    }

    var subtitle: String {
        switch self {
        case .builtin(let item): return item.description
        case .skill(let item): return item.summary ?? item.skillMdPath
        case .command(let item): return item.description
        }
    }

    var accessory: String {
        switch self {
        case .builtin(let item): return item.sourceTag
        case .skill(let item): return item.sourceTag
        case .command(let item): return SupportedAgentCatalog.cliLabel(for: item.platform)
        }
    }

    var argumentHint: String? {
        if case .command(let item) = self {
            return item.argumentHint
        }
        return nil
    }

    var insertionText: String {
        switch self {
        case .builtin(let item): return "\(item.insertText) "
        case .skill(let item): return "/\(item.name) "
        case .command(let item): return "\(item.insertText) "
        }
    }
}

private struct ChatAttachment: Identifiable {
    let id = UUID()
    let filename: String
    let data: Data
    let contentType: String
    let previewImage: UIImage?

    var byteCount: Int {
        data.count
    }
}

private enum VoiceInputOverlayMode: Equatable {
    case recording
    case polishing
    case editing
}

private struct VoiceOverlayPreview {
    let text: String
    let cursorLocation: Int?
}

private struct SpeechInsertionResult {
    let text: String
    let cursorLocation: Int
}

private struct ChatInputBar: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var speechInput = SpeechInputController()

    private static let inputMinHeight: CGFloat = 40
    private static let inputMaxHeight: CGFloat = 126

    let serverId: String
    let group: AgentGroup
    let sessionId: String?
    @Binding var isSending: Bool
    @Binding var sendError: String?
    @Binding var pendingFileReference: WorkspaceFileReference?
    @Binding var pendingMentionReference: ChatMentionReference?
    @Binding var isVoiceInputActive: Bool
    let keyboardLayoutChange: ChatKeyboardLayoutChange

    @State private var text = ""
    @State private var selectedRange = NSRange(location: 0, length: 0)
    @State private var inputHeight: CGFloat = 40
    @State private var inputRemeasureToken = UUID()
    @State private var inputFocusToken = UUID()
    @State private var isStopping = false
    @State private var sendTask: Task<Void, Never>?
    @State private var activeToken: ChatInputActiveToken?
    @State private var slashMenuSource: SlashMenuSource?
    @State private var selectedSuggestionIndex = 0
    @State private var skillRows: [SkillListItem] = []
    @State private var cliCommandRows: [CliCommandItem] = []
    @State private var skillCache: [SkillListItem]?
    @State private var cliCommandCache: [String: [CliCommandItem]] = [:]
    @State private var loadingSlashPlatform: String?
    @State private var slashError: String?
    @State private var attachments: [ChatAttachment] = []
    @State private var showAttachmentDialog = false
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var isPolishingSpeech = false
    @State private var isEditingSpeechDraft = false
    @State private var speechBaseText: String?
    @State private var speechBaseSelectionRange = NSRange(location: 0, length: 0)
    @State private var speechInsertionRange = NSRange(location: 0, length: 0)
    @State private var speechDraftPreviewText = ""
    @State private var speechProcessingTask: Task<Void, Never>?

    private static let voiceOverlayOuterHorizontalPadding: CGFloat = 8
    private static let voiceOverlayInnerPadding: CGFloat = 16
    private static let voiceOverlayHeaderHeight: CGFloat = 32
    private static let voiceOverlayHeaderSpacing: CGFloat = 12
    private static let voiceOverlayTranscriptLineSpacing: CGFloat = 6
    private static let voiceOverlayEditingFooterHeight: CGFloat = 42
    private static let voiceOverlayEditingFooterSpacing: CGFloat = 12
    private static let voiceOverlayEditingTextBottomClearance: CGFloat = 12
    private static let voiceOverlayTopClearance: CGFloat = 12
    private static let voiceOverlayTitleBarFallbackHeight: CGFloat = 96
    private static let speechSeparatorCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    )

    private static let maxAttachmentBytes = 63 * 1024 * 1024
    private static let attachmentRoot = ".octrix-mobile-attachments"

    private static let builtinSlashItems: [BuiltinSlashItem] = [
        BuiltinSlashItem(
            id: "new",
            name: "new",
            description: "统一新会话入口",
            insertText: "/new",
            sourceTag: "builtin",
        ),
        BuiltinSlashItem(
            id: "clear",
            name: "clear",
            description: "统一清空/新开会话入口",
            insertText: "/clear",
            sourceTag: "builtin",
        ),
        BuiltinSlashItem(
            id: "compact",
            name: "compact",
            description: "统一压缩上下文入口",
            insertText: "/compact",
            sourceTag: "builtin",
        ),
    ]

    private var uniqueAgents: [Agent] {
        store.uniqueAgents(in: group, serverId: serverId)
    }

    private var hasWorkingDirectory: Bool {
        !(group.workingDirectory ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var totalAttachmentBytes: Int {
        attachments.reduce(0) { $0 + $1.byteCount }
    }

    private var generatingTargets: [AgentResponseTarget] {
        guard let sessionId else { return [] }
        return store.streamingAgentTargets(
            in: group,
            taskSessionId: sessionId,
            serverId: serverId,
        )
    }

    private var isGenerating: Bool {
        !generatingTargets.isEmpty
    }

    private var canSubmit: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !isSending
            && !isGenerating
            && !speechInput.isActive
            && !isPolishingSpeech
    }

    private var memberMentionOptions: [MentionSuggestion] {
        chatMentionSuggestions(for: uniqueAgents, roleName: roleName(for:))
    }

    private var mentionOptions: [MentionSuggestion] {
        let all = MentionSuggestion(id: "__all__", label: "所有人", insertText: "所有人", agentId: nil, isAll: true)
        let rows = [all] + memberMentionOptions
        guard activeToken?.kind == .mention else { return rows }
        let query = activeToken?.query.lowercased() ?? ""
        guard !query.isEmpty else { return rows }
        return rows.filter {
            $0.label.lowercased().contains(query) || $0.insertText.lowercased().contains(query)
        }
    }

    private var slashOptions: [SlashSuggestion] {
        guard activeToken?.kind == .slash else { return [] }
        let query = activeToken?.query.lowercased() ?? ""
        var rows = Self.builtinSlashItems
            .filter { item in
                guard !query.isEmpty else { return true }
                return [item.name, item.description, item.insertText]
                    .joined(separator: "\u{0}")
                    .lowercased()
                    .contains(query)
            }
            .map(SlashSuggestion.builtin)

        if case .cli = slashMenuSource {
            rows += skillRows
                .filter { item in
                    guard !query.isEmpty else { return true }
                    return [item.name, item.sourceTag, item.skillMdPath, item.summary ?? ""]
                        .joined(separator: "\u{0}")
                        .lowercased()
                        .contains(query)
                }
                .map(SlashSuggestion.skill)

            rows += cliCommandRows
                .filter { item in
                    guard !query.isEmpty else { return true }
                    return ([item.name, item.description, item.argumentHint ?? ""] + (item.aliases ?? []))
                        .joined(separator: "\u{0}")
                        .lowercased()
                        .contains(query)
                }
                .map(SlashSuggestion.command)
        }

        return rows
    }

    private var isSlashLoading: Bool {
        loadingSlashPlatform != nil
    }

    private var voiceOverlayMode: VoiceInputOverlayMode? {
        if speechInput.isActive {
            return .recording
        }
        if isPolishingSpeech {
            return .polishing
        }
        if isEditingSpeechDraft {
            return .editing
        }
        return nil
    }

    var body: some View {
        VStack(spacing: 6) {
            if voiceOverlayMode == nil {
                completionPanel
            }
            attachmentStrip

            if let mode = voiceOverlayMode {
                Color.clear
                    .frame(height: voiceInputReservedHeight(for: mode))
            } else {
                normalInputRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, inputBottomPadding)
        .overlay(alignment: .top) {
            voiceInputOverlay
        }
        .animation(.spring(response: 0.28, dampingFraction: 0.9), value: voiceOverlayMode)
        .animation(
            chatKeyboardAnimation(
                duration: keyboardLayoutChange.animationDuration,
                curve: keyboardLayoutChange.animationCurve
            ),
            value: keyboardLayoutChange
        )
        .confirmationDialog("添加附件", isPresented: $showAttachmentDialog, titleVisibility: .visible) {
            Button("照片") {
                showPhotoPicker = true
            }
            Button("文件") {
                showFileImporter = true
            }
            Button("取消", role: .cancel) {}
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: 10,
            matching: .images,
        )
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true,
        ) { result in
            handleImportedFiles(result)
        }
        .onChange(of: selectedPhotoItems) { _, items in
            loadPhotoAttachments(items)
        }
        .onChange(of: pendingFileReference?.id) { _, _ in
            consumePendingFileReference()
        }
        .onChange(of: pendingMentionReference?.id) { _, _ in
            consumePendingMentionReference()
        }
        .onChange(of: voiceOverlayMode) { _, mode in
            isVoiceInputActive = mode != nil
        }
        .onChange(of: speechInput.errorMessage) { _, message in
            if let message {
                sendError = message
            }
        }
        .onAppear {
            isVoiceInputActive = voiceOverlayMode != nil
        }
        .onDisappear {
            speechInput.cancelRecording()
            speechProcessingTask?.cancel()
            speechProcessingTask = nil
            isPolishingSpeech = false
            resetSpeechDraftState(restoreBaseText: false)
            isVoiceInputActive = false
        }
    }

    private var inputBottomPadding: CGFloat {
        if speechInput.isActive || isPolishingSpeech {
            return 24
        }
        return 8
    }

    @ViewBuilder
    private var voiceInputOverlay: some View {
        if let mode = voiceOverlayMode {
            GeometryReader { proxy in
                let preview = voiceOverlayPreview(for: mode)
                let liveText = preview.text
                let placeholder = voiceOverlayPlaceholder(for: mode)
                let dockHeight = voiceDockHeight(for: mode)
                let dockTopOffset = voiceDockTopOffset(for: mode, containerHeight: proxy.size.height)
                let height = voiceOverlayHeight(
                    for: proxy.size,
                    mode: mode,
                    liveText: liveText,
                    placeholder: placeholder,
                    containerFrame: proxy.frame(in: .global),
                    dockTopOffset: dockTopOffset,
                )
                let panelTopOffset = voicePanelTopOffset(for: mode, panelHeight: height, dockTopOffset: dockTopOffset)
                let screenBounds = UIScreen.main.bounds
                let containerFrame = proxy.frame(in: .global)

                ZStack(alignment: .top) {
                    VoiceInputBackdrop()
                        .frame(width: screenBounds.width, height: screenBounds.height)
                        .offset(
                            x: screenBounds.minX - containerFrame.minX,
                            y: screenBounds.minY - containerFrame.minY,
                        )
                        .ignoresSafeArea()
                        .allowsHitTesting(false)

                    VoiceInputOverlay(
                        mode: mode,
                        liveText: liveText,
                        placeholder: placeholder,
                        elapsedText: formattedElapsedTime(speechInput.elapsedSeconds),
                        text: $text,
                        selectedRange: $selectedRange,
                        previewCursorLocation: preview.cursorLocation,
                        isSending: isSending,
                        isGenerating: isGenerating,
                        isStopping: isStopping,
                        canContinueRecording: canContinueSpeechRecording,
                        canSubmit: canSubmit,
                        onTextChanged: handleVoiceDraftEdited,
                        onContinueRecording: startSpeechRecording,
                        onCancel: cancelVoiceOverlay,
                        onStop: stopGenerating,
                        onSubmit: submit,
                    )
                    .frame(height: height)
                    .padding(.horizontal, Self.voiceOverlayOuterHorizontalPadding)
                    .offset(y: panelTopOffset)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(20)

                    if dockHeight > 0 {
                        voiceDock(for: mode)
                            .frame(height: dockHeight)
                            .padding(.horizontal, Self.voiceOverlayOuterHorizontalPadding)
                            .offset(y: dockTopOffset)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                            .zIndex(21)
                    }
                }
            }
            .allowsHitTesting(true)
        }
    }

    private func voiceOverlayHeight(
        for size: CGSize,
        mode: VoiceInputOverlayMode,
        liveText: String,
        placeholder: String,
        containerFrame: CGRect,
        dockTopOffset: CGFloat,
    ) -> CGFloat {
        let naturalHeight = voiceOverlayNaturalHeight(
            for: liveText,
            placeholder: placeholder,
            containerWidth: size.width,
            includesEditingFooter: mode == .editing,
        )
        let maximumHeight = voiceOverlayMaximumHeight(
            for: mode,
            containerFrame: containerFrame,
            dockTopOffset: dockTopOffset,
        )

        return min(naturalHeight, maximumHeight)
    }

    private func voiceOverlayNaturalHeight(
        for liveText: String,
        placeholder: String,
        containerWidth: CGFloat,
        includesEditingFooter: Bool = false,
    ) -> CGFloat {
        let trimmed = liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayText = trimmed.isEmpty ? placeholder : trimmed
        let textWidth = max(
            1,
            containerWidth
                - Self.voiceOverlayOuterHorizontalPadding * 2
                - Self.voiceOverlayInnerPadding * 2,
        )
        let font = UIFont.preferredFont(forTextStyle: .title3)
        let twoLineTextHeight = font.lineHeight * 2 + Self.voiceOverlayTranscriptLineSpacing
        let measuredTextHeight = voiceOverlayTextHeight(
            displayText,
            width: textWidth,
            font: font,
            lineSpacing: Self.voiceOverlayTranscriptLineSpacing,
        )
        let transcriptHeight = max(twoLineTextHeight, measuredTextHeight)
        let footerHeight = includesEditingFooter
            ? Self.voiceOverlayEditingFooterSpacing
                + Self.voiceOverlayEditingFooterHeight
                + Self.voiceOverlayEditingTextBottomClearance
            : 0

        return Self.voiceOverlayInnerPadding * 2
            + Self.voiceOverlayHeaderHeight
            + Self.voiceOverlayHeaderSpacing
            + ceil(transcriptHeight)
            + footerHeight
    }

    private func voiceOverlayTextHeight(
        _ text: String,
        width: CGFloat,
        font: UIFont,
        lineSpacing: CGFloat,
    ) -> CGFloat {
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = lineSpacing

        let value = text.isEmpty ? " " : text
        let attributedText = NSAttributedString(
            string: value,
            attributes: [
                .font: font,
                .paragraphStyle: paragraphStyle,
            ],
        )
        let bounds = attributedText.boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil,
        )

        return ceil(bounds.height)
    }

    private func voiceOverlayMaximumHeight(
        for mode: VoiceInputOverlayMode,
        containerFrame: CGRect,
        dockTopOffset: CGFloat,
    ) -> CGFloat {
        let dockHeight = voiceDockHeight(for: mode)
        let panelBottomOffset: CGFloat
        if dockHeight > 0 {
            panelBottomOffset = dockTopOffset - voiceDockSpacing(for: mode)
        } else {
            panelBottomOffset = -voiceOverlayBottomGap(for: mode)
        }

        let panelBottomY = containerFrame.minY + panelBottomOffset
        let topLimit = voiceOverlayTopLimit()
        let minimumHeight = voiceOverlayNaturalHeight(
            for: "",
            placeholder: " ",
            containerWidth: containerFrame.width,
            includesEditingFooter: mode == .editing,
        )
        return max(minimumHeight, panelBottomY - topLimit)
    }

    private func voiceOverlayTopLimit() -> CGFloat {
        let statusBarBottom = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.statusBarManager?.statusBarFrame.maxY }
            .max() ?? 0
        let fallbackTitleBarBottom = statusBarBottom + Self.voiceOverlayTitleBarFallbackHeight
        let titleBarBottom = max(fallbackTitleBarBottom, currentNavigationBarBottom() ?? 0)
        return titleBarBottom + Self.voiceOverlayTopClearance
    }

    private func currentNavigationBarBottom() -> CGFloat? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .filter(\.isKeyWindow)
            .compactMap { window in navigationBarBottom(in: window, window: window) }
            .max()
    }

    private func navigationBarBottom(in view: UIView, window: UIWindow) -> CGFloat? {
        if let navigationBar = view as? UINavigationBar {
            return navigationBar.convert(navigationBar.bounds, to: window).maxY
        }

        return view.subviews
            .compactMap { navigationBarBottom(in: $0, window: window) }
            .max()
    }

    private func voiceOverlayBottomGap(for mode: VoiceInputOverlayMode) -> CGFloat {
        mode == .editing && keyboardLayoutChange.height > 0 ? 12 : 20
    }

    private func voiceInputReservedHeight(for mode: VoiceInputOverlayMode) -> CGFloat {
        switch mode {
        case .recording, .polishing:
            return 54
        case .editing:
            return 0
        }
    }

    private func voiceDockHeight(for mode: VoiceInputOverlayMode) -> CGFloat {
        switch mode {
        case .recording, .polishing:
            return 54
        case .editing:
            return 0
        }
    }

    private func voiceDockTopOffset(for mode: VoiceInputOverlayMode, containerHeight: CGFloat) -> CGFloat {
        let dockHeight = voiceDockHeight(for: mode)
        guard dockHeight > 0 else {
            return 0
        }
        return max(8, containerHeight - inputBottomPadding - dockHeight)
    }

    private func voiceDockSpacing(for mode: VoiceInputOverlayMode) -> CGFloat {
        voiceDockHeight(for: mode) > 0 ? 14 : 0
    }

    private func voicePanelTopOffset(
        for mode: VoiceInputOverlayMode,
        panelHeight: CGFloat,
        dockTopOffset: CGFloat,
    ) -> CGFloat {
        let dockHeight = voiceDockHeight(for: mode)
        guard dockHeight > 0 else {
            return -panelHeight - voiceOverlayBottomGap(for: mode)
        }
        return dockTopOffset - voiceDockSpacing(for: mode) - panelHeight
    }

    @ViewBuilder
    private func voiceDock(for mode: VoiceInputOverlayMode) -> some View {
        switch mode {
        case .recording:
            speechRecordingBar
        case .polishing:
            speechPolishingBar
        case .editing:
            EmptyView()
        }
    }

    private func voiceOverlayPreview(for mode: VoiceInputOverlayMode) -> VoiceOverlayPreview {
        switch mode {
        case .recording:
            return combinedVoicePreview(with: speechInput.transcript)
        case .polishing:
            return combinedVoicePreview(with: speechDraftPreviewText)
        case .editing:
            return VoiceOverlayPreview(text: text, cursorLocation: selectedRange.location)
        }
    }

    private func combinedVoicePreview(with pendingText: String) -> VoiceOverlayPreview {
        let result = speechInsertionResult(
            baseText: text,
            inserting: pendingText,
            at: speechInsertionRange,
        )
        return VoiceOverlayPreview(text: result.text, cursorLocation: result.cursorLocation)
    }

    private func voiceOverlayPlaceholder(for mode: VoiceInputOverlayMode) -> String {
        switch mode {
        case .recording:
            return speechStatusText
        case .polishing:
            return "正在整理语音内容…"
        case .editing:
            return "输入内容"
        }
    }

    private var normalInputRow: some View {
        HStack(alignment: .center, spacing: 8) {
            HStack(alignment: .center, spacing: 4) {
                Button {
                    openAttachmentDialog()
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 24, weight: .regular))
                        .frame(width: 36, height: Self.inputMinHeight, alignment: .center)
                }
                .buttonStyle(.plain)
                .disabled(isSending || isPolishingSpeech)
                .accessibilityLabel("添加附件")

                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(group.isDirectChat ? "/ 使用命令" : "@ 提及成员；/ 使用命令")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .padding(.horizontal, 15)
                            .padding(.vertical, 10)
                            .allowsHitTesting(false)
                    }

                    GrowingTextView(
                        text: $text,
                        selectedRange: $selectedRange,
                        measuredHeight: $inputHeight,
                        remeasureToken: inputRemeasureToken,
                        focusToken: inputFocusToken,
                        minHeight: Self.inputMinHeight,
                        maxHeight: Self.inputMaxHeight,
                    ) { value, range in
                        sendError = nil
                        updateCompletionPopup(value, cursor: range.location)
                    }
                    .frame(height: boundedInputHeight(inputHeight))
                }
                .frame(maxWidth: .infinity)

                Button {
                    startSpeechRecording()
                } label: {
                    Image(systemName: "mic")
                        .font(.system(size: 23, weight: .regular))
                        .frame(width: 36, height: Self.inputMinHeight, alignment: .center)
                }
                .buttonStyle(.plain)
                .disabled(!canContinueSpeechRecording)
                .accessibilityLabel("语音输入")
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(.systemGray6)),
            )

            Button(action: isGenerating ? stopGenerating : submit) {
                ZStack {
                    if isGenerating {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 34, height: 34)
                    }

                    if isStopping {
                        ProgressView()
                            .tint(isGenerating ? .white : Color.accentColor)
                            .frame(width: 32, height: 32)
                    } else if isGenerating {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                    } else if isSending {
                        ProgressView()
                            .tint(Color.accentColor)
                            .frame(width: 32, height: 32)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                    }
                }
                .frame(width: 36, height: Self.inputMinHeight, alignment: .center)
            }
            .buttonStyle(.plain)
            .disabled(
                isStopping
                    || (sessionId == nil && group.isDirectChat)
                    || (!isGenerating && (isSending || !canSubmit))
            )
            .accessibilityLabel(isGenerating ? "停止 AI" : "发送")
            .accessibilityHint(isGenerating ? "打断当前回复，但保持 AI 在线" : "")
        }
    }

    private var speechPolishingBar: some View {
        HStack(spacing: 10) {
            ProgressView()
                .frame(width: 34, height: 34)

            Text("正在整理语音内容…")
                .font(.callout)
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 50)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.systemGray6)),
        )
    }

    private var speechRecordingBar: some View {
        HStack(spacing: 10) {
            Button {
                cancelVoiceOverlay()
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Color(.secondarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消语音输入")

            HStack(spacing: 8) {
                Spacer(minLength: 0)
                RecordingWaveformView(
                    levels: speechInput.waveformLevels,
                    isActive: speechInput.state == .recording,
                )
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)

            Button {
                finishSpeechRecording()
            } label: {
                if speechInput.state == .stopping {
                    ProgressView()
                        .frame(width: 32, height: 32)
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 31))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .buttonStyle(.plain)
            .disabled(speechInput.state == .stopping)
            .accessibilityLabel("完成语音输入")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.systemGray6)),
        )
    }

    private var speechStatusText: String {
        let partial = speechInput.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !partial.isEmpty {
            return partial
        }

        switch speechInput.state {
        case .requestingPermission:
            return "准备语音输入…"
        case .recording:
            return "正在聆听…"
        case .stopping:
            return "正在整理识别结果…"
        case .failed(let message):
            return message
        case .idle:
            return "语音输入"
        }
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !attachments.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(attachments) { attachment in
                        HStack(spacing: 7) {
                            attachmentThumbnail(attachment)

                            VStack(alignment: .leading, spacing: 1) {
                                Text(attachment.filename)
                                    .font(.caption.weight(.medium))
                                    .lineLimit(1)
                                Text(formattedBytes(attachment.byteCount))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: 138, alignment: .leading)

                            Button {
                                removeAttachment(attachment.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 17))
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .disabled(isSending)
                        }
                        .padding(.leading, 6)
                        .padding(.trailing, 5)
                        .padding(.vertical, 5)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color(.systemGray6)),
                        )
                    }
                }
                .padding(.horizontal, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func attachmentThumbnail(_ attachment: ChatAttachment) -> some View {
        if let previewImage = attachment.previewImage {
            Image(uiImage: previewImage)
                .resizable()
                .scaledToFill()
                .frame(width: 32, height: 32)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            Image(systemName: "doc")
                .font(.system(size: 17))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(.secondarySystemFill)),
                )
        }
    }

    @ViewBuilder
    private var completionPanel: some View {
        if activeToken?.kind == .mention {
            if mentionOptions.isEmpty {
                EmptyView()
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(mentionOptions.enumerated()), id: \.element.id) { index, option in
                            Button {
                                insertMention(option)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: option.isAll ? "person.3.fill" : "circle.fill")
                                        .font(.system(size: option.isAll ? 14 : 8))
                                        .foregroundStyle(option.isAll ? Color.accentColor : presenceColor(agentId: option.agentId))
                                    Text(option.label)
                                        .font(.subheadline)
                                        .lineLimit(1)
                                    Spacer()
                                    Text("@\(option.insertText)")
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                                .background(index == selectedSuggestionIndex ? Color.accentColor.opacity(0.12) : Color.clear)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .completionPanelStyle()
            }
        } else if activeToken?.kind == .slash {
            ScrollView {
                VStack(spacing: 0) {
                    slashHeader

                    if isSlashLoading {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("读取 CLI 命令与 Skill…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                    } else if let slashError {
                        Text(slashError)
                            .font(.caption)
                            .foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    } else if slashOptions.isEmpty {
                        Text(slashMenuSource == .builtin ? "暂无匹配的内置命令" : "该 CLI 暂无匹配命令或 Skill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(Array(slashOptions.enumerated()), id: \.element.id) { index, option in
                            Button {
                                insertSlashOption(option)
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(option.title)
                                            .font(.subheadline.weight(.medium))
                                            .lineLimit(1)
                                        Text(option.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                        if let hint = option.argumentHint {
                                            Text(hint)
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(.tertiary)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Text(option.accessory)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 3)
                                        .background(Capsule().fill(Color(.secondarySystemFill)))
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                                .background(index == selectedSuggestionIndex ? Color.accentColor.opacity(0.12) : Color.clear)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .completionPanelStyle()
        }
    }

    @ViewBuilder
    private var slashHeader: some View {
        if case .cli(let platform, let agentName, let cliLabel) = slashMenuSource {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(agentName) · \(SupportedAgentCatalog.name(for: platform))")
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text("/ 将补全 \(cliLabel) 的命令与 Skill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text(cliLabel)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color(.secondarySystemFill)))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Divider()
            }
        }
    }

    private func roleName(for agent: Agent) -> String? {
        guard let member = group.members.first(where: { $0.agentId == agent.id }),
              let roleId = member.roleId else { return nil }
        return store.role(serverId: serverId, id: roleId)?.name
    }

    private func presenceColor(agentId: String?) -> Color {
        guard let agentId,
              let agent = store.agent(serverId: serverId, id: agentId) else { return AgentPresenceState.offline.color }
        return store.agentPresence(agent: agent, in: group, serverId: serverId).color
    }

    private var canContinueSpeechRecording: Bool {
        ChatInputAvailabilityPolicy.canStartVoiceInput(
            sessionId: sessionId,
            isDirectChat: group.isDirectChat,
            isSending: isSending,
            isPolishingSpeech: isPolishingSpeech,
            isSpeechInputActive: speechInput.isActive
        )
    }

    private func startSpeechRecording() {
        guard canContinueSpeechRecording else { return }
        sendError = nil
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
        let currentRange = normalizedSelectionRange(selectedRange, in: text)
        if !isEditingSpeechDraft || speechBaseText == nil {
            speechBaseText = text
            speechBaseSelectionRange = currentRange
        }
        speechInsertionRange = currentRange
        speechDraftPreviewText = ""
        isEditingSpeechDraft = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)

        Task {
            do {
                try await speechInput.startRecording()
            } catch {
                sendError = error.localizedDescription
            }
        }
    }

    private func finishSpeechRecording() {
        speechProcessingTask?.cancel()
        speechProcessingTask = Task {
            let recognizedText = await speechInput.finishRecording()
            speechDraftPreviewText = recognizedText.trimmingCharacters(in: .whitespacesAndNewlines)
            let polishedText = await polishSpeechTranscriptIfNeeded(recognizedText)
            guard !Task.isCancelled else { return }
            presentSpeechDraft(polishedText)
        }
    }

    private func cancelSpeechRecording() {
        speechInput.cancelRecording()
        resetSpeechDraftState(restoreBaseText: false)
    }

    private func cancelVoiceOverlay() {
        speechProcessingTask?.cancel()
        speechProcessingTask = nil
        isPolishingSpeech = false

        if speechInput.isActive {
            cancelSpeechRecording()
        } else if isEditingSpeechDraft {
            resetSpeechDraftState(restoreBaseText: true)
        } else {
            resetSpeechDraftState(restoreBaseText: false)
        }
    }

    private func presentSpeechDraft(_ recognizedText: String) {
        let trimmed = recognizedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            resetSpeechDraftState(restoreBaseText: false)
            return
        }

        insertSpeechTranscript(trimmed)
        isEditingSpeechDraft = true
        speechDraftPreviewText = ""
    }

    private func handleVoiceDraftEdited(_ value: String) {
        sendError = nil
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
        inputHeight = boundedInputHeight(max(inputHeight, estimatedInputHeight(for: value)))
        inputRemeasureToken = UUID()
    }

    private func resetSpeechDraftState(restoreBaseText: Bool) {
        if restoreBaseText {
            let base = speechBaseText ?? ""
            text = base
            selectedRange = normalizedSelectionRange(speechBaseSelectionRange, in: base)
            inputHeight = boundedInputHeight(estimatedInputHeight(for: base))
            inputRemeasureToken = UUID()
        }

        isEditingSpeechDraft = false
        speechBaseText = nil
        speechBaseSelectionRange = NSRange(location: 0, length: 0)
        speechInsertionRange = NSRange(location: 0, length: 0)
        speechDraftPreviewText = ""
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
    }

    private func insertSpeechTranscript(_ recognizedText: String) {
        let trimmed = recognizedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }

        let insertion = speechInsertionResult(
            baseText: text,
            inserting: trimmed,
            at: speechInsertionRange,
        )
        text = insertion.text
        selectedRange = NSRange(location: insertion.cursorLocation, length: 0)
        speechInsertionRange = selectedRange

        inputHeight = boundedInputHeight(max(inputHeight, estimatedInputHeight(for: text)))
        inputRemeasureToken = UUID()
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
        sendError = nil
    }

    private func speechInsertionResult(
        baseText: String,
        inserting rawText: String,
        at range: NSRange,
    ) -> SpeechInsertionResult {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        let source = NSMutableString(string: baseText)
        let safeRange = normalizedSelectionRange(range, in: baseText)
        guard !trimmed.isEmpty else {
            return SpeechInsertionResult(text: baseText, cursorLocation: safeRange.location)
        }

        let start = safeRange.location
        let end = safeRange.location + safeRange.length
        let left = start > 0
            ? source.substring(with: NSRange(location: start - 1, length: 1))
            : nil
        let right = end < source.length
            ? source.substring(with: NSRange(location: end, length: 1))
            : nil
        let first = trimmed.first.map(String.init)
        let last = trimmed.last.map(String.init)
        let prefix = shouldSeparateSpeech(left, from: first) ? " " : ""
        let suffix = shouldSeparateSpeech(last, from: right) ? " " : ""
        let replacement = prefix + trimmed + suffix

        source.replaceCharacters(in: safeRange, with: replacement)
        return SpeechInsertionResult(
            text: source as String,
            cursorLocation: start + (replacement as NSString).length,
        )
    }

    private func normalizedSelectionRange(_ range: NSRange, in value: String) -> NSRange {
        let length = (value as NSString).length
        let location = min(max(range.location, 0), length)
        let availableLength = max(0, length - location)
        let selectedLength = min(max(range.length, 0), availableLength)
        return NSRange(location: location, length: selectedLength)
    }

    private func shouldSeparateSpeech(_ lhs: String?, from rhs: String?) -> Bool {
        guard let lhs, let rhs else { return false }
        return lhs.rangeOfCharacter(from: Self.speechSeparatorCharacters) != nil
            && rhs.rangeOfCharacter(from: Self.speechSeparatorCharacters) != nil
    }

    private func polishSpeechTranscriptIfNeeded(_ recognizedText: String) async -> String {
        let trimmed = recognizedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              DeepSeekVoicePolishSettings.isVerified,
              let apiKey = DeepSeekVoicePolishSettings.configuredAPIKey else {
            return recognizedText
        }

        isPolishingSpeech = true
        defer { isPolishingSpeech = false }

        do {
            return try await DeepSeekVoicePolisher(apiKey: apiKey).polish(trimmed)
        } catch {
            return recognizedText
        }
    }

    private func estimatedInputHeight(for value: String) -> CGFloat {
        let length = (value as NSString).length
        guard length > 0 else { return 40 }
        let softLines = max(1, Int(ceil(Double(length) / 16.0)))
        let hardLines = value.components(separatedBy: .newlines).count
        let lines = max(softLines, hardLines)
        return min(Self.inputMaxHeight, CGFloat(lines) * 25 + 18)
    }

    private func boundedInputHeight(_ height: CGFloat) -> CGFloat {
        min(max(height, Self.inputMinHeight), Self.inputMaxHeight)
    }

    private func formattedElapsedTime(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return String(format: "%d:%02d", minutes, remainder)
    }

    private func openAttachmentDialog() {
        guard hasWorkingDirectory else {
            sendError = "当前会话没有工作目录，无法发送附件"
            return
        }
        sendError = nil
        showAttachmentDialog = true
    }

    private func loadPhotoAttachments(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        guard hasWorkingDirectory else {
            sendError = "当前会话没有工作目录，无法发送附件"
            selectedPhotoItems = []
            return
        }

        let existingBytes = totalAttachmentBytes
        let existingNames = Set(attachments.map { $0.filename.lowercased() })
        let startingAttachmentCount = attachments.count
        Task {
            var nextBytes = existingBytes
            var names = existingNames
            var loaded: [ChatAttachment] = []

            do {
                for item in items {
                    guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                    try ensureAttachmentSize(nextBytes + data.count)
                    nextBytes += data.count

                    let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
                    let ext = type.preferredFilenameExtension ?? "jpg"
                    let filename = uniqueAttachmentFilename(
                        preferredName: "照片 \(startingAttachmentCount + loaded.count + 1).\(ext)",
                        existingNames: &names,
                    )
                    loaded.append(ChatAttachment(
                        filename: filename,
                        data: data,
                        contentType: type.preferredMIMEType ?? "image/jpeg",
                        previewImage: UIImage(data: data),
                    ))
                }

                await MainActor.run {
                    attachments.append(contentsOf: loaded)
                    selectedPhotoItems = []
                }
            } catch {
                await MainActor.run {
                    sendError = error.localizedDescription
                    selectedPhotoItems = []
                }
            }
        }
    }

    private func handleImportedFiles(_ result: Result<[URL], Error>) {
        guard hasWorkingDirectory else {
            sendError = "当前会话没有工作目录，无法发送附件"
            return
        }

        do {
            let urls = try result.get()
            loadFileAttachments(urls)
        } catch {
            sendError = error.localizedDescription
        }
    }

    private func loadFileAttachments(_ urls: [URL]) {
        guard !urls.isEmpty else { return }

        let existingBytes = totalAttachmentBytes
        let existingNames = Set(attachments.map { $0.filename.lowercased() })
        Task {
            var nextBytes = existingBytes
            var names = existingNames
            var loaded: [ChatAttachment] = []

            do {
                for url in urls {
                    let didAccess = url.startAccessingSecurityScopedResource()
                    defer {
                        if didAccess {
                            url.stopAccessingSecurityScopedResource()
                        }
                    }

                    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentTypeKey])
                    if values.isDirectory == true {
                        throw RelayAPIError(message: "暂不支持发送文件夹")
                    }
                    if let fileSize = values.fileSize {
                        try ensureAttachmentSize(nextBytes + fileSize)
                    }

                    let data = try Data(contentsOf: url)
                    try ensureAttachmentSize(nextBytes + data.count)
                    nextBytes += data.count

                    let filename = uniqueAttachmentFilename(
                        preferredName: url.lastPathComponent,
                        existingNames: &names,
                    )
                    let contentType = values.contentType?.preferredMIMEType
                        ?? UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                        ?? "application/octet-stream"
                    let preview = contentType.hasPrefix("image/") ? UIImage(data: data) : nil

                    loaded.append(ChatAttachment(
                        filename: filename,
                        data: data,
                        contentType: contentType,
                        previewImage: preview,
                    ))
                }

                await MainActor.run {
                    attachments.append(contentsOf: loaded)
                }
            } catch {
                await MainActor.run {
                    sendError = error.localizedDescription
                }
            }
        }
    }

    private func ensureAttachmentSize(_ bytes: Int) throws {
        if bytes > Self.maxAttachmentBytes {
            throw RelayAPIError(message: "单次附件总大小不能超过 \(formattedBytes(Self.maxAttachmentBytes))")
        }
    }

    private func removeAttachment(_ id: UUID) {
        attachments.removeAll { $0.id == id }
    }

    private func uniqueAttachmentFilename(preferredName: String, existingNames: inout Set<String>) -> String {
        let safeName = sanitizedAttachmentFilename(preferredName)
        let ext = (safeName as NSString).pathExtension
        let base = (safeName as NSString).deletingPathExtension.isEmpty
            ? "attachment"
            : (safeName as NSString).deletingPathExtension

        var candidate = safeName
        var index = 2
        while existingNames.contains(candidate.lowercased()) {
            candidate = ext.isEmpty ? "\(base) \(index)" : "\(base) \(index).\(ext)"
            index += 1
        }
        existingNames.insert(candidate.lowercased())
        return candidate
    }

    private func sanitizedAttachmentFilename(_ name: String) -> String {
        let separators = CharacterSet(charactersIn: "/\\:\r\n")
        var cleaned = name
            .replacingOccurrences(of: "\0", with: "-")
            .components(separatedBy: separators)
            .joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if cleaned.isEmpty {
            cleaned = "attachment"
        }

        if cleaned.count <= 120 {
            return cleaned
        }

        let ext = (cleaned as NSString).pathExtension
        let base = (cleaned as NSString).deletingPathExtension
        let shortenedBase = String(base.prefix(96)).trimmingCharacters(in: .whitespacesAndNewlines)
        return ext.isEmpty ? shortenedBase : "\(shortenedBase).\(ext)"
    }

    private func attachmentTargetSubpath() -> String {
        let timestamp = Int(Date().timeIntervalSince1970)
        let suffix = UUID().uuidString.prefix(8).lowercased()
        return "\(Self.attachmentRoot)/\(timestamp)-\(suffix)"
    }

    private func formattedBytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    private func updateCompletionPopup(_ value: String, cursor: Int) {
        guard let token = activeToken(in: value, cursor: cursor) else {
            activeToken = nil
            slashMenuSource = nil
            slashError = nil
            selectedSuggestionIndex = 0
            return
        }

        activeToken = token
        selectedSuggestionIndex = 0

        if token.kind == .mention {
            slashMenuSource = nil
            slashError = nil
            return
        }

        let source = resolveSlashMenuSource(value, cursor: cursor)
        slashMenuSource = source
        if case .cli(let platform, _, _) = source {
            loadSlashRowsIfNeeded(platform: platform)
        } else {
            slashError = nil
        }
    }

    private func loadSlashRowsIfNeeded(platform: String) {
        if let cachedCommands = cliCommandCache[platform], let cachedSkills = skillCache {
            cliCommandRows = cachedCommands
            skillRows = cachedSkills
            loadingSlashPlatform = nil
            slashError = nil
            return
        }

        loadingSlashPlatform = platform
        slashError = nil

        Task {
            do {
                let loadedSkills: [SkillListItem]
                if let cached = skillCache {
                    loadedSkills = cached
                } else {
                    loadedSkills = try await store.listSkills(serverId: serverId)
                    skillCache = loadedSkills
                }

                let loadedCommands: [CliCommandItem]
                if let cached = cliCommandCache[platform] {
                    loadedCommands = cached
                } else {
                    loadedCommands = try await store.listCliCommands(serverId: serverId, platform: platform)
                    cliCommandCache[platform] = loadedCommands
                }

                if case .cli(let currentPlatform, _, _) = slashMenuSource, currentPlatform == platform {
                    skillRows = loadedSkills
                    cliCommandRows = loadedCommands
                    loadingSlashPlatform = nil
                }
            } catch {
                if case .cli(let currentPlatform, _, _) = slashMenuSource, currentPlatform == platform {
                    skillRows = []
                    cliCommandRows = []
                    slashError = error.localizedDescription
                    loadingSlashPlatform = nil
                }
            }
        }
    }

    private func resolveSlashMenuSource(_ value: String, cursor: Int) -> SlashMenuSource {
        if group.isDirectChat, let agent = uniqueAgents.first {
            return .cli(
                platform: agent.platform,
                agentName: agent.name,
                cliLabel: SupportedAgentCatalog.cliLabel(for: agent.platform),
            )
        }

        guard let option = lastMentionedOptionBeforeCursor(value, cursor: cursor),
              let agentId = option.agentId,
              let agent = uniqueAgents.first(where: { $0.id == agentId }) else {
            return .builtin
        }
        return .cli(
            platform: agent.platform,
            agentName: option.insertText,
            cliLabel: SupportedAgentCatalog.cliLabel(for: agent.platform),
        )
    }

    private func insertMention(_ option: MentionSuggestion) {
        guard let token = activeToken, token.kind == .mention else { return }
        replaceActiveToken(token, with: "@\(option.insertText) ")
    }

    private func insertSlashOption(_ option: SlashSuggestion) {
        guard let token = activeToken, token.kind == .slash else { return }
        replaceActiveToken(token, with: option.insertionText)
    }

    private func consumePendingFileReference() {
        guard let pendingFileReference else { return }
        let needsSeparator = !text.isEmpty && !text.hasSuffix(" ") && !text.hasSuffix("\n")
        text += needsSeparator ? " \(pendingFileReference.text)" : pendingFileReference.text
        selectedRange = NSRange(location: (text as NSString).length, length: 0)
        inputRemeasureToken = UUID()
        inputFocusToken = UUID()
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
        self.pendingFileReference = nil
    }

    private func consumePendingMentionReference() {
        guard let pendingMentionReference else { return }
        insertTextAtSelection("@\(pendingMentionReference.text)")
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
        self.pendingMentionReference = nil
    }

    private func insertTextAtSelection(_ insertion: String) {
        let source = NSMutableString(string: text)
        let range = normalizedSelectionRange(selectedRange, in: text)
        let start = range.location
        let end = range.location + range.length
        let previous = start > 0 ? source.substring(with: NSRange(location: start - 1, length: 1)) : nil
        let next = end < source.length ? source.substring(with: NSRange(location: end, length: 1)) : nil
        let prefix = previous?.rangeOfCharacter(from: .whitespacesAndNewlines) == nil && previous != nil ? " " : ""
        let insertionEndsWithSeparator = insertion.rangeOfCharacter(
            from: .whitespacesAndNewlines,
            options: .backwards,
        )?.upperBound == insertion.endIndex
        let suffix = insertionEndsWithSeparator || next?.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
            ? ""
            : " "
        let replacement = prefix + insertion + suffix

        source.replaceCharacters(in: range, with: replacement)
        text = source as String
        selectedRange = NSRange(location: start + (replacement as NSString).length, length: 0)
        inputHeight = boundedInputHeight(max(inputHeight, estimatedInputHeight(for: text)))
        inputRemeasureToken = UUID()
        inputFocusToken = UUID()
        sendError = nil
    }

    private func replaceActiveToken(_ token: ChatInputActiveToken, with insertion: String) {
        let source = NSMutableString(string: text)
        let start = min(max(token.triggerStart, 0), source.length)
        let selectionEnd = min(max(selectedRange.location + selectedRange.length, start), source.length)
        source.replaceCharacters(in: NSRange(location: start, length: selectionEnd - start), with: insertion)
        text = source as String
        selectedRange = NSRange(location: start + (insertion as NSString).length, length: 0)
        inputRemeasureToken = UUID()
        inputFocusToken = UUID()
        activeToken = nil
        slashMenuSource = nil
        slashError = nil
    }

    private func submit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSubmit, sessionId != nil || !group.isDirectChat else { return }
        let target = resolveTargets(for: trimmed)
        let selectedAttachments = attachments
        isSending = true
        sendError = nil

        sendTask = Task {
            defer {
                isSending = false
                sendTask = nil
            }
            do {
                let messageText = try await composedMessageText(
                    body: trimmed,
                    attachments: selectedAttachments,
                )
                try await store.sendMessage(
                    text: messageText,
                    group: group,
                    taskSessionId: sessionId,
                    to: target.displayTo,
                    agentIds: target.agentIds,
                    serverId: serverId,
                )
                text = ""
                attachments = []
                selectedRange = NSRange(location: 0, length: 0)
                resetSpeechDraftState(restoreBaseText: false)
                activeToken = nil
                slashMenuSource = nil
            } catch {
                sendError = error.localizedDescription
            }
        }
    }

    private func stopGenerating() {
        guard !isStopping,
              let sessionId,
              !generatingTargets.isEmpty else { return }
        let targets = generatingTargets
        let pendingSendTask = sendTask
        isStopping = true
        sendError = nil

        Task {
            defer { isStopping = false }
            if let pendingSendTask {
                await pendingSendTask.value
            }
            do {
                try await store.interruptAgents(
                    in: group,
                    taskSessionId: sessionId,
                    targets: targets,
                    serverId: serverId,
                )
            } catch {
                sendError = error.localizedDescription
            }
        }
    }

    private func composedMessageText(body: String, attachments selectedAttachments: [ChatAttachment]) async throws -> String {
        guard !selectedAttachments.isEmpty else { return body }
        guard hasWorkingDirectory else {
            throw RelayAPIError(message: "当前会话没有工作目录，无法发送附件")
        }

        let targetSubpath = attachmentTargetSubpath()
        let files = selectedAttachments.map {
            WorkspaceUploadFile(filename: $0.filename, data: $0.data, contentType: $0.contentType)
        }
        _ = try await store.importWorkspaceFiles(
            serverId: serverId,
            groupId: group.id,
            files: files,
            targetSubpath: targetSubpath,
        )

        let references = selectedAttachments
            .map { formatWorkspaceFileReference("\(targetSubpath)/\($0.filename)") }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .joined(separator: "\n")

        guard !body.isEmpty else { return references }
        return "\(body)\n\n\(references)"
    }

    private func resolveTargets(for value: String) -> (agentIds: [String], displayTo: String) {
        if group.isDirectChat, let agent = uniqueAgents.first {
            return ([agent.id], agent.name)
        }

        if value.contains("@所有人") {
            return (uniqueAgents.map(\.id), "所有人")
        }

        var mentionedIds: [String] = []
        for option in memberMentionOptions {
            guard let agentId = option.agentId else { continue }
            if value.contains("@\(option.insertText)") && !mentionedIds.contains(agentId) {
                mentionedIds.append(agentId)
            }
        }

        let runningIds = store.runningAgentIds(in: group, serverId: serverId)
        let runningInGroup = uniqueAgents
            .map(\.id)
            .filter { runningIds.contains($0) }
        let targetIds = mentionedIds.isEmpty ? runningInGroup : mentionedIds

        if !mentionedIds.isEmpty {
            let names = mentionedIds.compactMap { id in
                memberMentionOptions.first(where: { $0.agentId == id })?.insertText
            }
            return (targetIds, names.joined(separator: ", "))
        }

        if !targetIds.isEmpty && targetIds.count == runningInGroup.count {
            return (targetIds, "所有人")
        }

        let names = targetIds.compactMap { id in
            memberMentionOptions.first(where: { $0.agentId == id })?.insertText
        }
        return (targetIds, names.joined(separator: ", "))
    }

    private func activeToken(in value: String, cursor: Int) -> ChatInputActiveToken? {
        let source = value as NSString
        let safeCursor = min(max(cursor, 0), source.length)
        let before = source.substring(to: safeCursor) as NSString
        let atRange = before.range(of: "@", options: .backwards)
        let slashRange = before.range(of: "/", options: .backwards)
        let atIndex = atRange.location == NSNotFound ? -1 : atRange.location
        let slashIndex = slashRange.location == NSNotFound ? -1 : slashRange.location

        let atToken = validToken(in: before, trigger: atIndex)
        let slashToken = validToken(in: before, trigger: slashIndex)

        if let atToken, slashToken == nil {
            return ChatInputActiveToken(kind: .mention, triggerStart: atIndex, query: atToken)
        }
        if let slashToken, atToken == nil {
            return ChatInputActiveToken(kind: .slash, triggerStart: slashIndex, query: slashToken)
        }
        if let atToken, let slashToken {
            return atIndex > slashIndex
                ? ChatInputActiveToken(kind: .mention, triggerStart: atIndex, query: atToken)
                : ChatInputActiveToken(kind: .slash, triggerStart: slashIndex, query: slashToken)
        }
        return nil
    }

    private func validToken(in before: NSString, trigger: Int) -> String? {
        guard trigger >= 0 else { return nil }
        if trigger > 0 {
            let prev = before.substring(with: NSRange(location: trigger - 1, length: 1))
            guard prev.rangeOfCharacter(from: .whitespacesAndNewlines) != nil else { return nil }
        }
        let query = before.substring(from: trigger + 1)
        guard query.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        return query
    }

    private func lastMentionedOptionBeforeCursor(_ value: String, cursor: Int) -> MentionSuggestion? {
        let source = value as NSString
        let safeCursor = min(max(cursor, 0), source.length)
        let before = source.substring(to: safeCursor) as NSString
        var best: (option: MentionSuggestion, index: Int)?

        for option in memberMentionOptions {
            let needle = "@\(option.insertText)"
            let needleLength = (needle as NSString).length
            var searchLength = before.length
            while searchLength >= needleLength {
                let found = before.range(
                    of: needle,
                    options: .backwards,
                    range: NSRange(location: 0, length: searchLength),
                )
                if found.location == NSNotFound { break }
                if isMentionOccurrenceValid(in: before, range: found) {
                    if best == nil || found.location >= best!.index {
                        best = (option, found.location)
                    }
                    break
                }
                searchLength = found.location
            }
        }

        return best?.option
    }

    private func isMentionOccurrenceValid(in source: NSString, range: NSRange) -> Bool {
        if range.location > 0 {
            let prev = source.substring(with: NSRange(location: range.location - 1, length: 1))
            guard prev.rangeOfCharacter(from: .whitespacesAndNewlines) != nil else { return false }
        }
        let nextIndex = range.location + range.length
        guard nextIndex < source.length else { return true }
        let next = source.substring(with: NSRange(location: nextIndex, length: 1))
        let boundary = CharacterSet.whitespacesAndNewlines
            .union(CharacterSet(charactersIn: "，。,.!?;:、"))
        return next.rangeOfCharacter(from: boundary) != nil
    }
}

private struct NativeVisualEffectBlur: UIViewRepresentable {
    let style: UIBlurEffect.Style

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: UIBlurEffect(style: style))
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {
        uiView.effect = UIBlurEffect(style: style)
    }
}

private struct VoiceInputBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NativeVisualEffectBlur(style: .systemUltraThinMaterial)
            .overlay(Color(.systemBackground).opacity(colorScheme == .dark ? 0.025 : 0.04))
            .overlay(
                LinearGradient(
                    colors: [
                        Color.white.opacity(colorScheme == .dark ? 0.06 : 0.18),
                        Color.clear,
                        Color.black.opacity(colorScheme == .dark ? 0.10 : 0.04),
                    ],
                    startPoint: .top,
                    endPoint: .bottom,
                ),
            )
    }
}

private struct VoiceInputOverlay: View {
    @Environment(\.colorScheme) private var colorScheme

    let mode: VoiceInputOverlayMode
    let liveText: String
    let placeholder: String
    let elapsedText: String
    @Binding var text: String
    @Binding var selectedRange: NSRange
    let previewCursorLocation: Int?
    let isSending: Bool
    let isGenerating: Bool
    let isStopping: Bool
    let canContinueRecording: Bool
    let canSubmit: Bool
    let onTextChanged: (String) -> Void
    let onContinueRecording: () -> Void
    let onCancel: () -> Void
    let onStop: () -> Void
    let onSubmit: () -> Void

    private var title: String {
        switch mode {
        case .recording:
            return "语音输入"
        case .polishing:
            return "AI 纠正中"
        case .editing:
            return "语音草稿"
        }
    }

    private var statusTint: Color {
        switch mode {
        case .recording:
            return .red
        case .polishing:
            return .orange
        case .editing:
            return Color.accentColor
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            Group {
                if mode == .editing {
                    editor
                } else {
                    VoiceTranscriptPreview(
                        text: liveText,
                        placeholder: placeholder,
                        cursorLocation: previewCursorLocation,
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if mode == .editing {
                footer
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Color(.systemBackground).opacity(colorScheme == .dark ? 0.78 : 0.76)),
        )
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(Color(.separator).opacity(0.38), lineWidth: 1),
        )
        .shadow(color: .black.opacity(0.2), radius: 26, y: 14)
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusTint)
                .frame(width: 9, height: 9)

            Text(title)
                .font(.headline)
                .foregroundStyle(.primary)

            Spacer(minLength: 0)

            if mode == .recording {
                Text(elapsedText)
                    .font(.subheadline.monospacedDigit().weight(.medium))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(Color(.secondarySystemFill)))
            } else if mode == .polishing {
                ProgressView()
                    .controlSize(.small)
            }

            if isGenerating {
                Button(action: onStop) {
                    ZStack {
                        Circle()
                            .fill(Color.accentColor)

                        if isStopping {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(isStopping)
                .accessibilityLabel("停止 AI")
                .accessibilityHint("打断当前回复，但保持 AI 在线")
            }

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color(.secondarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消语音输入")
        }
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(placeholder)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
            }

            VoiceDraftEditorTextView(
                text: $text,
                selectedRange: $selectedRange,
            ) { value, _ in
                onTextChanged(value)
            }
        }
        .padding(.horizontal, -5)
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text("\((text as NSString).length) 字")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            Button(action: onContinueRecording) {
                Image(systemName: "mic")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(canContinueRecording ? Color.accentColor : Color.secondary.opacity(0.55))
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(Color(.secondarySystemFill)))
            }
            .buttonStyle(.plain)
            .disabled(!canContinueRecording)
            .accessibilityLabel("继续语音输入")

            Button(action: onSubmit) {
                Group {
                    if isSending {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 18, weight: .bold))
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(Circle().fill(canSubmit ? Color.accentColor : Color.secondary.opacity(0.35)))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .accessibilityLabel("发送语音输入")
        }
    }
}

private struct VoiceTranscriptPreview: View {
    let text: String
    let placeholder: String
    let cursorLocation: Int?

    var body: some View {
        VoiceTranscriptPreviewTextView(
            text: text,
            placeholder: placeholder,
            cursorLocation: cursorLocation,
        )
    }
}

private struct VoiceTranscriptPreviewTextView: UIViewRepresentable {
    let text: String
    let placeholder: String
    let cursorLocation: Int?

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.backgroundColor = .clear
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.showsVerticalScrollIndicator = true
        view.alwaysBounceVertical = true
        view.scrollsToTop = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        let attributed = attributedPreviewText(tintColor: uiView.tintColor)
        if !uiView.attributedText.isEqual(to: attributed) {
            uiView.attributedText = attributed
        }

        let scrollRange = previewScrollRange()
        DispatchQueue.main.async {
            uiView.scrollRangeToVisible(scrollRange)
        }
    }

    private func attributedPreviewText(tintColor: UIColor?) -> NSAttributedString {
        let font = UIFont.preferredFont(forTextStyle: .title3)
        let paragraphStyle = NSMutableParagraphStyle()
        paragraphStyle.lineSpacing = 6
        let isPlaceholder = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let displayText = isPlaceholder ? placeholder : text
        let source = NSMutableString(string: displayText)
        let cursor = normalizedCursorLocation(in: displayText)

        if let cursor, !isPlaceholder {
            source.insert("|", at: cursor)
        }

        let attributed = NSMutableAttributedString(
            string: source as String,
            attributes: [
                .font: font,
                .foregroundColor: isPlaceholder ? UIColor.secondaryLabel : UIColor.label,
                .paragraphStyle: paragraphStyle,
            ],
        )

        if let cursor, !isPlaceholder {
            attributed.addAttributes(
                [
                    .foregroundColor: tintColor ?? UIColor.systemBlue,
                    .font: font,
                ],
                range: NSRange(location: cursor, length: 1),
            )
        }

        return attributed
    }

    private func previewScrollRange() -> NSRange {
        let isPlaceholder = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let displayText = isPlaceholder ? placeholder : text
        if let cursor = normalizedCursorLocation(in: displayText), !isPlaceholder {
            return NSRange(location: cursor, length: 1)
        }

        let length = (displayText as NSString).length
        return NSRange(location: max(0, length - 1), length: 0)
    }

    private func normalizedCursorLocation(in value: String) -> Int? {
        guard let cursorLocation else { return nil }
        let length = (value as NSString).length
        return min(max(cursorLocation, 0), length)
    }
}

private struct VoiceDraftEditorTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selectedRange: NSRange
    let onEdit: (String, NSRange) -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .title3)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: 5, bottom: 8, right: 5)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.showsVerticalScrollIndicator = true
        view.alwaysBounceVertical = true
        view.scrollsToTop = false
        view.keyboardDismissMode = .interactive
        view.returnKeyType = .default
        view.autocorrectionType = .yes
        view.autocapitalizationType = .none
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text {
            uiView.text = text
        }
        if uiView.selectedRange != selectedRange,
           selectedRange.location <= (uiView.text as NSString).length {
            uiView.selectedRange = selectedRange
        }
        scrollSelectionIntoView(uiView)

        if !uiView.isFirstResponder {
            DispatchQueue.main.async {
                uiView.becomeFirstResponder()
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    private func scrollSelectionIntoView(_ view: UITextView) {
        let textLength = (view.text as NSString).length
        let location = min(max(view.selectedRange.location, 0), textLength)
        view.scrollRangeToVisible(NSRange(location: location, length: 0))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private var parent: VoiceDraftEditorTextView

        init(_ parent: VoiceDraftEditorTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.selectedRange = textView.selectedRange
            parent.scrollSelectionIntoView(textView)
            parent.onEdit(textView.text, textView.selectedRange)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.selectedRange = textView.selectedRange
            parent.scrollSelectionIntoView(textView)
            parent.onEdit(textView.text, textView.selectedRange)
        }
    }
}

private struct RecordingWaveformView: View {
    let levels: [Double]
    let isActive: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(normalizedLevels.enumerated()), id: \.offset) { _, level in
                let height = 5 + CGFloat(level) * 19
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(Color.secondary.opacity(isActive ? 0.35 + level * 0.45 : 0.35))
                    .frame(width: 2.5, height: height)
            }
        }
        .animation(.linear(duration: 0.05), value: levels)
        .frame(width: 124, height: 24, alignment: .center)
        .clipped()
        .accessibilityHidden(true)
    }

    private var normalizedLevels: [Double] {
        let sampleCount = 28
        let clippedLevels = levels.suffix(sampleCount).map { min(1, max(0.08, $0)) }
        if clippedLevels.count >= sampleCount {
            return Array(clippedLevels)
        }
        return Array(repeating: 0.08, count: sampleCount - clippedLevels.count) + clippedLevels
    }
}

private struct CompletionPanelStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity)
            .frame(maxHeight: 230)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.secondarySystemBackground)),
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color(.separator).opacity(0.45)),
            )
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.12), radius: 12, y: 5)
    }
}

private extension View {
    func completionPanelStyle() -> some View {
        modifier(CompletionPanelStyle())
    }
}

private struct GrowingTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selectedRange: NSRange
    @Binding var measuredHeight: CGFloat
    let remeasureToken: UUID
    let focusToken: UUID
    let minHeight: CGFloat
    let maxHeight: CGFloat
    let onEdit: (String, NSRange) -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = true
        view.alwaysBounceVertical = false
        view.scrollsToTop = false
        view.keyboardDismissMode = .interactive
        view.returnKeyType = .default
        view.autocorrectionType = .yes
        view.autocapitalizationType = .none
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        let didChangeText = uiView.text != text
        if uiView.text != text {
            uiView.text = text
        }
        if uiView.selectedRange != selectedRange,
           selectedRange.location <= (uiView.text as NSString).length {
            uiView.selectedRange = selectedRange
        }
        uiView.setNeedsLayout()
        uiView.layoutIfNeeded()
        recalculateHeight(uiView)
        if didChangeText || context.coordinator.remeasureToken != remeasureToken {
            context.coordinator.remeasureToken = remeasureToken
            scheduleHeightRecalculation(uiView)
        }
        if context.coordinator.focusToken != focusToken {
            context.coordinator.focusToken = focusToken
            DispatchQueue.main.async {
                uiView.becomeFirstResponder()
                scrollSelectionIntoView(uiView)
            }
        }
        if uiView.isScrollEnabled {
            scrollSelectionIntoView(uiView)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    private func recalculateHeight(_ view: UITextView) {
        let width = max(view.bounds.width, view.frame.width, 1)
        let target = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        let size = view.sizeThatFits(target)
        let fullHeight = max(size.height, minHeight)
        let nextHeight = min(fullHeight, maxHeight)
        let shouldScroll = fullHeight > maxHeight + 0.5

        if view.isScrollEnabled != shouldScroll {
            view.isScrollEnabled = shouldScroll
        }
        view.alwaysBounceVertical = shouldScroll

        if shouldScroll {
            scrollSelectionIntoView(view)
        } else if view.contentOffset != .zero {
            view.setContentOffset(.zero, animated: false)
        }

        if abs(measuredHeight - nextHeight) > 0.5 {
            DispatchQueue.main.async {
                measuredHeight = nextHeight
            }
        }
    }

    private func scheduleHeightRecalculation(_ view: UITextView) {
        DispatchQueue.main.async {
            view.setNeedsLayout()
            view.layoutIfNeeded()
            recalculateHeight(view)

            DispatchQueue.main.async {
                view.setNeedsLayout()
                view.layoutIfNeeded()
                recalculateHeight(view)
            }
        }
    }

    private func scrollSelectionIntoView(_ view: UITextView) {
        let textLength = (view.text as NSString).length
        let location = min(max(view.selectedRange.location, 0), textLength)
        view.scrollRangeToVisible(NSRange(location: location, length: 0))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private var parent: GrowingTextView
        var remeasureToken: UUID
        var focusToken: UUID

        init(_ parent: GrowingTextView) {
            self.parent = parent
            remeasureToken = parent.remeasureToken
            focusToken = parent.focusToken
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.selectedRange = textView.selectedRange
            parent.recalculateHeight(textView)
            if textView.isScrollEnabled {
                parent.scrollSelectionIntoView(textView)
            }
            parent.onEdit(textView.text, textView.selectedRange)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.selectedRange = textView.selectedRange
            if textView.isScrollEnabled {
                parent.scrollSelectionIntoView(textView)
            }
            parent.onEdit(textView.text, textView.selectedRange)
        }
    }
}
