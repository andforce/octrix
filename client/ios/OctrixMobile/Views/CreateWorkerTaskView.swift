import SwiftUI

private struct MissionTemplateOption: Identifiable {
    let id: String
    let label: String
}

private let missionTemplateOptions = [
    MissionTemplateOption(id: "feature", label: "新功能开发"),
    MissionTemplateOption(id: "bugfix", label: "Bug 修复"),
    MissionTemplateOption(id: "refactor", label: "技术重构"),
    MissionTemplateOption(id: "discussion", label: "方案讨论"),
    MissionTemplateOption(id: "review", label: "代码审查"),
    MissionTemplateOption(id: "test", label: "测试验证"),
    MissionTemplateOption(id: "documentation", label: "文档任务"),
    MissionTemplateOption(id: "submission", label: "提交与 PR"),
    MissionTemplateOption(id: "generic", label: "通用任务"),
]

private let missingRoleResolutionOptions: [String: [(id: String, label: String)]] = [
    "role-product-manager": [
        ("owner_supplies", "群主提供并确认需求"),
        ("remove_irrelevant", "此阶段与任务无关"),
    ],
    "role-developer": [
        ("external_implementation", "群主在系统外实现后导入"),
        ("remove_irrelevant", "此阶段与任务无关"),
    ],
    "role-code-reviewer": [
        ("waive", "豁免独立代码审查"),
        ("remove_irrelevant", "此阶段与任务无关"),
    ],
    "role-tester": [
        ("waive", "豁免独立测试"),
        ("remove_irrelevant", "此阶段与任务无关"),
    ],
    "role-committer": [
        ("owner_handles", "质量通过后由群主处理 Git 与 PR"),
        ("remove_irrelevant", "此阶段与任务无关"),
    ],
]

struct CreateMissionView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    let serverId: String
    let initialGroupId: String?
    let lockSelectedGroup: Bool
    let initialMission: TaskSession?
    let onCreated: (AgentGroup, TaskSession) -> Void

    @State private var selectedGroupId: String?
    @State private var goal = ""
    @State private var title = ""
    @State private var objective = ""
    @State private var template = "feature"
    @State private var acceptanceText = ""
    @State private var blockingSeverities: Set<String> = ["blocker", "major"]
    @State private var draft: TaskSession?
    @State private var resolutionByRole: [String: String] = [:]
    @State private var noteByRole: [String: String] = [:]
    @State private var isWorking = false
    @State private var errorText: String?

    init(
        serverId: String,
        initialGroupId: String? = nil,
        lockSelectedGroup: Bool = false,
        initialMission: TaskSession? = nil,
        onCreated: @escaping (AgentGroup, TaskSession) -> Void
    ) {
        self.serverId = serverId
        self.initialGroupId = initialGroupId
        self.lockSelectedGroup = lockSelectedGroup
        self.initialMission = initialMission
        self.onCreated = onCreated
        _draft = State(initialValue: initialMission)
        _goal = State(initialValue: initialMission?.objective ?? "")
        _title = State(initialValue: initialMission?.title ?? "")
        _objective = State(initialValue: initialMission?.objective ?? "")
        _template = State(initialValue: initialMission?.template ?? "feature")
        _acceptanceText = State(initialValue: (initialMission?.acceptanceCriteria ?? []).joined(separator: "\n"))
        _blockingSeverities = State(initialValue: Set(
            initialMission?.qualityPolicy?.blockingSeverities ?? ["blocker", "major"]
        ))
    }

    private var candidateGroups: [AgentGroup] {
        let groups = store.groups(serverId: serverId)
            .filter { !$0.isArchived && !$0.isDirectChat && $0.compositionStatus != "composition_insufficient" }
            .sorted { $0.createdAt > $1.createdAt }
        guard lockSelectedGroup, let initialGroupId else { return groups }
        return groups.filter { $0.id == initialGroupId }
    }

    private var selectedGroup: AgentGroup? {
        if let selectedGroupId, let selected = candidateGroups.first(where: { $0.id == selectedGroupId }) {
            return selected
        }
        if let initialGroupId, let selected = candidateGroups.first(where: { $0.id == initialGroupId }) {
            return selected
        }
        return candidateGroups.first
    }

    private var acceptanceCriteria: [String] {
        acceptanceText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var missingPhases: [MissionPhase] {
        (draft?.phases ?? []).filter { $0.required && $0.status == "missing" }
    }

    private var canCreateDraft: Bool {
        selectedGroup != nil
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !acceptanceCriteria.isEmpty
            && !isWorking
    }

    private var qualityPolicy: MissionQualityPolicy {
        let order = ["blocker", "major", "minor", "suggestion"]
        return MissionQualityPolicy(
            blockingSeverities: order.filter { blockingSeverities.contains($0) },
            sharedStateTestExecution: "serial"
        )
    }

    var body: some View {
        Form {
            if candidateGroups.isEmpty {
                ContentUnavailableView(
                    "没有可用协作群",
                    systemImage: "person.3.sequence",
                    description: Text("请先创建至少包含两个 AI 的协作群"),
                )
            } else if let draft {
                draftForm(draft)
            } else {
                charterForm
            }

            if let errorText {
                Section {
                    Text(errorText)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(draft == nil ? "创建主任务" : "启动前确认")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("取消") { dismiss() }
                    .disabled(isWorking)
            }
        }
        .onAppear {
            if selectedGroupId == nil {
                selectedGroupId = selectedGroup?.id
            }
        }
    }

    @ViewBuilder
    private var charterForm: some View {
        Section("协作群") {
            if lockSelectedGroup {
                LabeledContent("群聊", value: selectedGroup?.name ?? "当前群聊")
            } else {
                Picker("群聊", selection: selectedGroupBinding) {
                    ForEach(candidateGroups) { group in
                        Text(group.name).tag(group.id)
                    }
                }
            }
        }

        Section("任务章程") {
            TextField("用自然语言描述目标", text: $goal, axis: .vertical)
                .lineLimit(3...6)
            Button("从目标生成可编辑建议") {
                generatePreview()
            }
            .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
            TextField("任务标题", text: $title)
            Picker("任务模板", selection: $template) {
                ForEach(missionTemplateOptions) { option in
                    Text(option.label).tag(option.id)
                }
            }
            TextField("目标、范围与期望结果", text: $objective, axis: .vertical)
                .lineLimit(3...6)
            TextField("每行一条可验证验收标准", text: $acceptanceText, axis: .vertical)
                .lineLimit(3...8)
        }

        Section("质量策略") {
            LabeledContent("固定阻断", value: "blocker")
            Toggle("major 阻断", isOn: blockingSeverityBinding("major"))
            Toggle("minor 阻断", isOn: blockingSeverityBinding("minor"))
            Toggle("suggestion 阻断", isOn: blockingSeverityBinding("suggestion"))
            Text("会写入共享缓存、构建目录或设备状态的测试固定串行执行。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        Section {
            Button {
                createDraft()
            } label: {
                if isWorking {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("生成任务章程")
                        .frame(maxWidth: .infinity)
                }
            }
            .disabled(!canCreateDraft)
        } footer: {
            Text("创建草稿不会启动 AI；处理完阶段与缺岗后还需要群主明确启动。")
        }
    }

    @ViewBuilder
    private func draftForm(_ draft: TaskSession) -> some View {
        Section("可编辑任务章程") {
            TextField("任务标题", text: $title)
            TextField("目标、范围与期望结果", text: $objective, axis: .vertical)
                .lineLimit(3...6)
            TextField("每行一条可验证验收标准", text: $acceptanceText, axis: .vertical)
                .lineLimit(3...8)
            Toggle("major 阻断", isOn: blockingSeverityBinding("major"))
            Toggle("minor 阻断", isOn: blockingSeverityBinding("minor"))
            Toggle("suggestion 阻断", isOn: blockingSeverityBinding("suggestion"))
            Button("保存任务章程") {
                saveCharter()
            }
            .disabled(!canCreateDraft)
        }

        Section("阶段计划") {
            ForEach(Array((draft.phases ?? []).enumerated()), id: \.element.id) { index, phase in
                HStack {
                    Text("\(phase.order). \(phase.name)")
                    Spacer()
                    Text(phase.status == "missing" ? "缺岗" : phase.status == "waived" ? "已豁免" : "已配置")
                        .font(.caption)
                        .foregroundStyle(phase.status == "missing" ? .orange : .secondary)
                    Button {
                        movePhase(index: index, offset: -1)
                    } label: {
                        Image(systemName: "arrow.up")
                    }
                    .disabled(isWorking || index == 0)
                    Button {
                        movePhase(index: index, offset: 1)
                    } label: {
                        Image(systemName: "arrow.down")
                    }
                    .disabled(isWorking || index == (draft.phases?.count ?? 0) - 1)
                }
            }

            if (draft.phases ?? []).contains(where: { $0.roleId == "role-committer" }) {
                Toggle(
                    "质量门禁通过后预授权合并 PR",
                    isOn: Binding(
                        get: { self.draft?.autoMergeAuthorized == true },
                        set: { updatePlan(autoMergeAuthorized: $0) },
                    ),
                )
                .disabled(isWorking)
            }
        }

        ForEach(missingPhases) { phase in
            let options = missingRoleResolutionOptions[phase.roleId] ?? []
            Section("\(phase.name)缺岗") {
                Picker("处理方式", selection: resolutionBinding(phase: phase, options: options)) {
                    ForEach(options, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                }
                TextField(
                    "说明原因、替代方案与风险",
                    text: noteBinding(roleId: phase.roleId),
                    axis: .vertical,
                )
                Button("确认缺岗决策") {
                    resolveMissingRole(phase)
                }
                .disabled(isWorking || (noteByRole[phase.roleId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }

        Section {
            Button {
                startMission()
            } label: {
                if isWorking {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("确认并启动主任务")
                        .frame(maxWidth: .infinity)
                }
            }
            .disabled(isWorking || !missingPhases.isEmpty)
        } footer: {
            Text("启动会重启群内 AI，记录 Git 基线，并只允许技术 Leader 实施代码修改。")
        }
    }

    private var selectedGroupBinding: Binding<String> {
        Binding {
            selectedGroup?.id ?? ""
        } set: { selectedGroupId = $0 }
    }

    private func resolutionBinding(
        phase: MissionPhase,
        options: [(id: String, label: String)]
    ) -> Binding<String> {
        Binding {
            resolutionByRole[phase.roleId] ?? options.first?.id ?? ""
        } set: { resolutionByRole[phase.roleId] = $0 }
    }

    private func noteBinding(roleId: String) -> Binding<String> {
        Binding {
            noteByRole[roleId] ?? ""
        } set: { noteByRole[roleId] = $0 }
    }

    private func blockingSeverityBinding(_ severity: String) -> Binding<Bool> {
        Binding {
            blockingSeverities.contains(severity)
        } set: { enabled in
            if enabled {
                blockingSeverities.insert(severity)
            } else {
                blockingSeverities.remove(severity)
            }
            blockingSeverities.insert("blocker")
        }
    }

    private func generatePreview() {
        guard let selectedGroup, !isWorking else { return }
        let normalizedGoal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedGoal.isEmpty else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                let preview = try await store.previewMission(
                    group: selectedGroup,
                    goal: normalizedGoal,
                    serverId: serverId
                )
                title = preview.title
                objective = preview.objective
                template = preview.template
                acceptanceText = preview.acceptanceCriteria.joined(separator: "\n")
                blockingSeverities = Set(preview.qualityPolicy.blockingSeverities)
                blockingSeverities.insert("blocker")
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func createDraft() {
        guard canCreateDraft, let selectedGroup else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                let mission = try await store.createMission(
                    group: selectedGroup,
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    objective: objective.trimmingCharacters(in: .whitespacesAndNewlines),
                    template: template,
                    acceptanceCriteria: acceptanceCriteria,
                    qualityPolicy: qualityPolicy,
                    serverId: serverId,
                )
                draft = mission
                title = mission.title
                objective = mission.objective ?? ""
                acceptanceText = (mission.acceptanceCriteria ?? []).joined(separator: "\n")
                blockingSeverities = Set(
                    mission.qualityPolicy?.blockingSeverities ?? ["blocker", "major"]
                )
                for phase in mission.phases ?? [] where phase.status == "missing" {
                    resolutionByRole[phase.roleId] = missingRoleResolutionOptions[phase.roleId]?.first?.id
                }
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func saveCharter() {
        guard let selectedGroup, let draft, canCreateDraft else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                self.draft = try await store.updateMissionCharter(
                    group: selectedGroup,
                    mission: draft,
                    title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    objective: objective.trimmingCharacters(in: .whitespacesAndNewlines),
                    acceptanceCriteria: acceptanceCriteria,
                    qualityPolicy: qualityPolicy,
                    serverId: serverId
                )
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func movePhase(index: Int, offset: Int) {
        guard let draft else { return }
        var roleIds = (draft.phases ?? []).map(\.roleId)
        let target = index + offset
        guard roleIds.indices.contains(index), roleIds.indices.contains(target) else { return }
        roleIds.swapAt(index, target)
        updatePlan(roleIds: roleIds, autoMergeAuthorized: draft.autoMergeAuthorized == true)
    }

    private func updatePlan(
        roleIds: [String]? = nil,
        autoMergeAuthorized: Bool
    ) {
        guard let selectedGroup, let draft, !isWorking else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                self.draft = try await store.updateMissionPlan(
                    group: selectedGroup,
                    mission: draft,
                    roleIds: roleIds ?? (draft.phases ?? []).map(\.roleId),
                    autoMergeAuthorized: autoMergeAuthorized,
                    serverId: serverId,
                )
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func resolveMissingRole(_ phase: MissionPhase) {
        guard let selectedGroup, let draft, !isWorking else { return }
        let resolution = resolutionByRole[phase.roleId]
            ?? missingRoleResolutionOptions[phase.roleId]?.first?.id
            ?? ""
        let note = (noteByRole[phase.roleId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !resolution.isEmpty, !note.isEmpty else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                self.draft = try await store.resolveMissingRole(
                    group: selectedGroup,
                    mission: draft,
                    roleId: phase.roleId,
                    resolution: resolution,
                    note: note,
                    serverId: serverId,
                )
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func startMission() {
        guard let selectedGroup, let draft, missingPhases.isEmpty, !isWorking else { return }
        isWorking = true
        errorText = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                let started = try await store.startMission(
                    group: selectedGroup,
                    mission: draft,
                    serverId: serverId,
                )
                onCreated(selectedGroup, started)
                dismiss()
            } catch {
                errorText = error.localizedDescription
            }
        }
    }
}
