import SwiftUI

// MARK: - 服务端数据模型（与 client/web/server/models.ts 保持镜像一致）

struct Agent: Codable, Identifiable, Hashable {
    let id: String
    let platform: String
    let name: String
    let command: String
    let avatarColor: String
}

struct Role: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let responsibility: String
}

struct GroupMember: Codable, Identifiable, Hashable {
    let id: String
    let agentId: String
    let roleId: String?
}

struct AgentGroup: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let ownerName: String
    let members: [GroupMember]
    let workingDirectory: String?
    let groupType: String
    let compositionStatus: String?
    let roleLeaders: [String: String]?
    let activeTaskSessionId: String?
    let pausedByMissionId: String?
    let createdAt: Double
    let archivedAt: Double?

    var isDirectChat: Bool { groupType == "direct" }
    var isArchived: Bool { archivedAt != nil }
}

struct TaskSession: Codable, Identifiable, Hashable {
    let id: String
    let groupId: String
    let title: String
    let kind: String?
    let objective: String?
    let template: String?
    let status: String
    let revision: Int?
    let acceptanceCriteria: [String]?
    let qualityPolicy: MissionQualityPolicy?
    let phases: [MissionPhase]?
    let leaderSnapshot: [String: String]?
    let initialOwnerMemberId: String?
    let requiredMemberIds: [String]?
    let missingRoleDecisions: [MissingRoleDecision]?
    let currentPhaseId: String?
    let reworkRound: Int?
    let maxReworkRounds: Int?
    let gitBaseline: MissionGitBaseline?
    let implementationRevisions: [ImplementationRevision]?
    let currentImplementationRevisionId: String?
    let requirementsRevisions: [RequirementsRevision]?
    let currentRequirementsRevision: Int?
    let submission: MissionSubmission?
    let autoMergeAuthorized: Bool?
    let ownerDecisionHistory: [MissionOwnerDecision]?
    let protocolFailureCounts: [String: Int]?
    let protocolErrorMemberId: String?
    let interruptionReason: String?
    let interruptedAt: Double?
    let createdAt: Double
    let updatedAt: Double?
    let startedAt: Double?
    let completedAt: Double?
    let cancelledAt: Double?
    let archivedAt: Double?

    var isArchived: Bool { status == "archived" }
    var isMission: Bool { kind == "mission" }
    var isTerminal: Bool { ["completed", "cancelled", "archived"].contains(status) }
}

struct MissionQualityPolicy: Codable, Hashable {
    let blockingSeverities: [String]
    let sharedStateTestExecution: String
}

struct GeneratedMissionDraft: Codable, Hashable {
    let title: String
    let objective: String
    let template: String
    let acceptanceCriteria: [String]
    let roleIds: [String]
    let initialOwnerMemberId: String?
    let missingRoleIds: [String]
    let qualityPolicy: MissionQualityPolicy
}

struct MissionPhase: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let roleId: String
    let leaderMemberId: String?
    let status: String
    let required: Bool
    let order: Int
}

struct MissingRoleDecision: Codable, Hashable {
    let roleId: String
    let resolution: String
    let note: String
    let decidedAt: Double
}

struct MissionGitBaseline: Codable, Hashable {
    let repositoryRoot: String
    let baseBranch: String
    let baseCommit: String
    let taskBranch: String
    let preparedAt: Double
}

struct ImplementationRevision: Codable, Identifiable, Hashable {
    let id: String
    let baseCommit: String
    let branch: String
    let contentHash: String
    let changedFiles: [String]
    let patchArtifact: String
    let manifestArtifact: String
    let createdAt: Double
}

struct RequirementsRevision: Codable, Identifiable, Hashable {
    let version: Int
    let artifact: String
    let contentHash: String
    let sourceWorkItemId: String?
    let createdAt: Double

    var id: Int { version }
}

struct MissionSubmission: Codable, Hashable {
    let revisionId: String
    let revisionContentHash: String
    let branch: String
    let commitSha: String
    let prUrl: String
    let draft: Bool
    let recordedAt: Double
    let mergeCommitSha: String?
    let mergedAt: Double?
}

struct MissionOwnerDecision: Codable, Hashable {
    let action: String
    let note: String
    let decidedAt: Double
}

struct WorkItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String
    let groupId: String
    let taskSessionId: String?
    let creatorName: String
    let ownerAgentId: String
    let ownerMemberId: String?
    let roleId: String?
    let phaseId: String?
    let kind: String?
    let revision: Int?
    let contextRevision: Int?
    let dependsOn: [String]?
    let parentWorkItemId: String?
    let reassignedFromWorkItemId: String?
    let reassignedToWorkItemId: String?
    let returnIssueId: String?
    let returnToPhaseId: String?
    let implementationRevisionId: String?
    let requirementsRevision: Int?
    let collaboratorAgentIds: [String]
    let status: String
    let createdAt: Double
    let updatedAt: Double
    let completedAt: Double?
    let artifact: String?
    let nextStep: String?
    let progressSummary: String?
    let unresponsiveAt: Double?
    let stalledAt: Double?
    let discussionRound: Int?
    let discussionStage: String?

    var isTerminal: Bool { ["completed", "done", "cancelled"].contains(status) }
}

struct CollaborationIssue: Codable, Identifiable, Hashable {
    let id: String
    let missionId: String
    let groupId: String
    let workItemId: String
    let reporterMemberId: String
    let roleId: String
    let title: String
    let summary: String
    let severity: String
    let status: String
    let revision: Int?
    let evidenceArtifact: String
    let requirementsRevision: Int?
    let implementationRevisionId: String?
    let reopenCount: Int
    let createdAt: Double
    let updatedAt: Double
    let resolvedAt: Double?
    let resolution: String?
}

struct TokenUsage: Codable, Hashable {
    let input: Int
    let output: Int
    let reasoning: Int
}

struct ConversationEntryMetrics: Codable, Hashable {
    let durationMs: Int?
    let timeToFirstTokenMs: Int?
}

struct HumanInputOption: Codable, Hashable {
    let label: String
    let description: String?
}

struct HumanInputQuestion: Codable, Identifiable, Hashable {
    let id: String
    let header: String?
    let question: String
    let options: [HumanInputOption]
    let multiSelect: Bool?

    var allowsMultipleSelection: Bool { multiSelect == true }
}

struct HumanInputRequest: Codable, Hashable {
    let callId: String
    let status: String
    let autoResolutionMs: Int?
    let questions: [HumanInputQuestion]
    let selectedAnswers: [String: [String]]?

    var isAnswered: Bool { status == "answered" }
}

struct ConversationEntry: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let content: String
    let timestamp: Double
    let toolName: String?
    let tokens: TokenUsage?
    let cost: Double?
    let phase: String?
    let source: String?
    let turnId: String?
    let itemType: String?
    let dedupeKey: String?
    let metrics: ConversationEntryMetrics?
    let humanInput: HumanInputRequest?
}

struct Envelope: Codable, Identifiable, Hashable {
    let id: String
    let from: String
    let to: String
    var body: String
    let ts: Double
    let groupId: String?
    let taskSessionId: String?
    let clientMsgId: String?
    var entries: [ConversationEntry]?
    var status: String?

    var isStreaming: Bool { status == "streaming" }
    var date: Date { Date(timeIntervalSince1970: ts) }
}

struct AppState: Codable {
    var agents: [Agent]
    var groups: [AgentGroup]
    var roles: [Role]
    var taskSessions: [TaskSession]
    var workItems: [WorkItem]?
    var issues: [CollaborationIssue]?
    var messages: [Envelope]
    var runningAgentIdsByGroup: [String: [String]]
    var busyAgentIdsByGroup: [String: [String]]?
    var agentErrorsByGroup: [String: [String: String]]?
    var platformInstallState: [String: Bool]?
    var enabledAgentPlatforms: [String]?
    var workspaceDataVersion: Int?
}

struct MobileAppState: Codable {
    var agents: [Agent]
    var groups: [AgentGroup]
    var roles: [Role]
    var taskSessions: [TaskSession]
    var workItems: [WorkItem]?
    var issues: [CollaborationIssue]?
    var runningAgentIdsByGroup: [String: [String]]
    var busyAgentIdsByGroup: [String: [String]]?
    var agentErrorsByGroup: [String: [String: String]]?
    var platformInstallState: [String: Bool]?
    var enabledAgentPlatforms: [String]?
    var workspaceDataVersion: Int?
}

struct SupportedAgent: Identifiable, Hashable {
    let platform: String
    let name: String

    var id: String { platform }
}

enum SupportedAgentCatalog {
    static let defaultEnabledPlatforms = [
        "openai-codex-cli",
        "openclaude",
        "claude-code",
        "opencode",
        "github-copilot-cli",
        "gemini-cli",
        "cursor-cli",
        "kiro-cli",
        "qoder-cli",
        "codebuddy-cli",
    ]

    static let all: [SupportedAgent] = [
        SupportedAgent(platform: "claude-code", name: "Claude Code"),
        SupportedAgent(platform: "openclaude", name: "OpenClaude"),
        SupportedAgent(platform: "opencode", name: "OpenCode"),
        SupportedAgent(platform: "github-copilot-cli", name: "GitHub Copilot CLI"),
        SupportedAgent(platform: "gemini-cli", name: "Gemini CLI"),
        SupportedAgent(platform: "openai-codex-cli", name: "Codex CLI"),
        SupportedAgent(platform: "cursor-cli", name: "Cursor CLI"),
        SupportedAgent(platform: "kiro-cli", name: "Kiro CLI"),
        SupportedAgent(platform: "qoder-cli", name: "Qoder CLI"),
        SupportedAgent(platform: "codebuddy-cli", name: "CodeBuddy"),
    ]

    static func enabled(platforms: [String]?) -> [SupportedAgent] {
        let requested = platforms ?? defaultEnabledPlatforms
        let byPlatform = Dictionary(uniqueKeysWithValues: all.map { ($0.platform, $0) })
        return requested.compactMap { byPlatform[$0] }
    }

    static func name(for platform: String) -> String {
        all.first { $0.platform == platform }?.name ?? platform
    }

    static func cliLabel(for platform: String) -> String {
        switch platform {
        case "claude-code": return "claude"
        case "openclaude": return "openclaude"
        case "opencode": return "opencode"
        case "github-copilot-cli": return "copilot"
        case "gemini-cli": return "gemini"
        case "openai-codex-cli": return "codex"
        case "cursor-cli": return "agent"
        case "kiro-cli": return "kiro-cli"
        case "qoder-cli": return "qodercli"
        case "codebuddy-cli": return "codebuddy"
        default: return platform
        }
    }

    static func logoAssetName(for platform: String) -> String? {
        switch platform {
        case "claude-code", "openclaude": return "AgentLogoClaudeCode"
        case "opencode": return "AgentLogoOpenCode"
        case "github-copilot-cli": return "AgentLogoGitHubCopilotCLI"
        case "gemini-cli": return "AgentLogoGeminiCLI"
        case "openai-codex-cli": return "AgentLogoOpenAICodex"
        case "cursor-cli": return "AgentLogoCursorCLI"
        case "kiro-cli": return "AgentLogoKiroCLI"
        case "qoder-cli": return "AgentLogoQoderCLI"
        case "codebuddy-cli": return "AgentLogoCodeBuddyCLI"
        default: return nil
        }
    }

    static func isFullBleedLogo(for platform: String) -> Bool {
        switch platform {
        case "claude-code", "openclaude", "cursor-cli", "kiro-cli", "qoder-cli", "codebuddy-cli", "openai-codex-cli":
            return true
        default:
            return false
        }
    }
}

// MARK: - 中继服务器模型

struct DeviceInfo: Codable, Identifiable, Hashable {
    let deviceId: String
    let deviceName: String
    let connected: Bool
    let connectedAt: Double?
    let lastSeenAt: Double?

    var id: String { deviceId }
}

struct DeviceListResponse: Codable {
    let devices: [DeviceInfo]
}

struct OctrixAuthorizedUser: Codable, Hashable {
    let id: String
    let name: String?
    let primaryLabel: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case primaryLabel = "primary_label"
    }
}

struct MobileAuthorizationTokenResponse: Codable {
    let accessToken: String
    let tokenType: String
    let serverURL: String
    let user: OctrixAuthorizedUser

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case serverURL = "server_url"
        case user
    }
}

struct SMSChallengeResponse: Codable {
    let challengeId: String
    let expiresAt: String
    let retryAfter: Int

    enum CodingKeys: String, CodingKey {
        case challengeId = "challenge_id"
        case expiresAt = "expires_at"
        case retryAfter = "retry_after"
    }
}

struct MobileSMSAuthorizationResponse: Codable {
    let authorizationCode: String
    let expiresAt: String
    let serverURL: String

    enum CodingKeys: String, CodingKey {
        case authorizationCode = "authorization_code"
        case expiresAt = "expires_at"
        case serverURL = "server_url"
    }
}

struct MissionListResponse: Codable {
    let ok: Bool
    let missions: [TaskSession]
    let activeMissionId: String?
}

struct MissionDetailResponse: Codable {
    let ok: Bool
    let mission: TaskSession
    let workItems: [WorkItem]
    let issues: [CollaborationIssue]
}

struct MissionMutationResponse: Codable {
    let ok: Bool
    let mission: TaskSession
    let workItem: WorkItem?
    let collaborationWorkItems: [WorkItem]?
}

struct MissionPreviewResponse: Codable {
    let ok: Bool
    let draft: GeneratedMissionDraft
}

struct AgentResponseTarget: Codable, Hashable {
    let agentId: String
    let responseId: String
}

struct InterruptAgentsResponse: Codable {
    let ok: Bool
    let interruptedAgentIds: [String]
}

struct GroupMutationResponse: Codable {
    let ok: Bool
    let group: AgentGroup
}

enum AgentStartupPromptKind: String, Codable, Hashable {
    case workspaceTrust = "workspace-trust"
    case bypassPermissions = "bypass-permissions"
}

enum AgentStartupPromptAction: String, Codable {
    case accept
    case decline
}

struct AgentStartupPrompt: Codable, Identifiable, Hashable {
    let kind: AgentStartupPromptKind
    let agentId: String
    let agentName: String
    let groupId: String
    let directory: String
    let rawPreview: String
    let detectedAt: Double
    let updatedAt: Double

    var id: String { "\(groupId):\(agentId):\(kind.rawValue)" }
}

struct AgentStartupPromptResponse: Codable {
    let ok: Bool
    let prompts: [AgentStartupPrompt]
}

struct AgentStartupPromptResolutionResponse: Codable {
    let ok: Bool
    let resolved: Int
    let prompts: [AgentStartupPrompt]
}

struct DirectoryEntry: Codable, Identifiable, Hashable {
    let name: String
    let path: String

    var id: String { path }
}

struct DirectoryListResponse: Codable {
    let path: String
    let parentPath: String?
    let entries: [DirectoryEntry]
}

struct WorkspaceFileEntry: Codable, Identifiable, Hashable {
    let name: String
    let type: String

    var id: String { name }
    var isDirectory: Bool { type == "directory" }
}

struct WorkspaceFileListResponse: Codable {
    let path: String
    let files: [WorkspaceFileEntry]
}

struct WorkspaceFileContentResponse: Codable, Hashable {
    let path: String
    let content: String
    let isBinary: Bool
    let size: Int
    let truncated: Bool
}

struct WorkspaceUploadFile {
    let filename: String
    let data: Data
    let contentType: String
}

struct WorkspaceImportResponse: Codable {
    let ok: Bool
    let imported: Int
}

struct GitWorkspaceStatus: Codable, Hashable {
    let isGitRepository: Bool
    let branch: String?
    let repositoryRoot: String?
}

struct SkillListItem: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let skillMdPath: String
    let rootPath: String
    let sourceTag: String
    let summary: String?
}

struct SkillListResponse: Codable {
    let ok: Bool
    let skills: [SkillListItem]
    let error: String?
}

struct CliCommandItem: Codable, Identifiable, Hashable {
    let id: String
    let platform: String
    let name: String
    let description: String
    let insertText: String
    let aliases: [String]?
    let argumentHint: String?
}

struct CliCommandListResponse: Codable {
    let ok: Bool
    let commands: [CliCommandItem]
    let error: String?
}

struct ModelPickerOption: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let isCurrent: Bool?

    var current: Bool { isCurrent ?? false }
}

struct ModelPickerSnapshot: Codable, Hashable {
    let agentId: String
    let groupId: String
    let mode: String?
    let status: String
    let options: [ModelPickerOption]
    let selectedIndex: Int?
    let rawPreview: String
    let startedAt: Double
    let updatedAt: Double
    let error: String?

    var pickerMode: String { mode ?? "model" }
    var isEffortMode: Bool { pickerMode == "effort" }
    var isFallback: Bool { status == "fallback" || options.isEmpty && status != "starting" }
    var isFinished: Bool { status == "chosen" || status == "cancelled" || status == "expired" }
}

struct ModelPickerResponse: Codable {
    let ok: Bool
    let picker: ModelPickerSnapshot
}

enum ModelPickerInputAction: String, Codable {
    case up
    case down
    case enter
    case escape
}

// MARK: - WebSocket 事件

struct MessageUpdate: Codable {
    let id: String
    let body: String?
    let entries: [ConversationEntry]?
    let status: String?
    let clientMsgId: String?
}

struct ProcessStatus: Codable {
    let runningAgentIdsByGroup: [String: [String]]
    let busyAgentIdsByGroup: [String: [String]]?
    let agentErrorsByGroup: [String: [String: String]]?
}

/// 服务端 WebSocket 推送事件：{"event": string, "data": ...}
enum ServerEvent {
    case state(AppState)
    case newMessage(Envelope)
    case updateMessage(MessageUpdate)
    case processStatus(ProcessStatus)
    case other(String)

    static func decode(from text: String) -> ServerEvent? {
        guard let data = text.data(using: .utf8) else { return nil }
        return decode(from: data)
    }

    static func decode(from data: Data) -> ServerEvent? {
        struct Probe: Decodable { let event: String }
        struct Payload<T: Decodable>: Decodable { let data: T }

        let decoder = JSONDecoder()
        guard let probe = try? decoder.decode(Probe.self, from: data) else { return nil }

        switch probe.event {
        case "state:update":
            guard let payload = try? decoder.decode(Payload<AppState>.self, from: data) else { return nil }
            return .state(payload.data)
        case "messages:new":
            guard let payload = try? decoder.decode(Payload<Envelope>.self, from: data) else { return nil }
            return .newMessage(payload.data)
        case "messages:update":
            guard let payload = try? decoder.decode(Payload<MessageUpdate>.self, from: data) else { return nil }
            return .updateMessage(payload.data)
        case "process:status":
            guard let payload = try? decoder.decode(Payload<ProcessStatus>.self, from: data) else { return nil }
            return .processStatus(payload.data)
        default:
            return .other(probe.event)
        }
    }
}

struct ServerEventEnvelope {
    let event: ServerEvent
    let seq: Int?
    let serverTime: Double?

    static func decode(from text: String) -> ServerEventEnvelope? {
        guard let data = text.data(using: .utf8) else { return nil }
        return decode(from: data)
    }

    static func decode(from data: Data) -> ServerEventEnvelope? {
        struct Probe: Decodable {
            let seq: Int?
            let serverTime: Double?
        }
        guard let event = ServerEvent.decode(from: data),
              let probe = try? JSONDecoder().decode(Probe.self, from: data) else { return nil }
        return ServerEventEnvelope(event: event, seq: probe.seq, serverTime: probe.serverTime)
    }
}

struct EventSyncResponse: Decodable {
    let ok: Bool
    let events: [ServerEventEnvelope]
    let latestSeq: Int
    let resetRequired: Bool

    enum CodingKeys: String, CodingKey {
        case ok
        case events
        case latestSeq
        case resetRequired
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        latestSeq = try container.decode(Int.self, forKey: .latestSeq)
        resetRequired = try container.decode(Bool.self, forKey: .resetRequired)
        var rawEvents = try container.nestedUnkeyedContainer(forKey: .events)
        var decoded: [ServerEventEnvelope] = []
        while !rawEvents.isAtEnd {
            let raw = try rawEvents.decode(RawJSON.self)
            if let envelope = ServerEventEnvelope.decode(from: raw.data) {
                decoded.append(envelope)
            }
        }
        events = decoded
    }
}

struct MessagePageResponse: Codable {
    let ok: Bool
    let messages: [Envelope]
    let hasMore: Bool
    let nextBefore: Double?
}

private struct RawJSON: Decodable {
    let data: Data

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let object = try container.decode(JSONValue.self)
        data = try JSONEncoder().encode(object)
    }
}

private enum JSONValue: Codable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

// MARK: - Agent 状态与头像配色

enum AgentPresenceState: String, Codable, Hashable {
    case offline
    case online
    case busy
    case error
    case unreadResult

    var label: String {
        switch self {
        case .offline: "离线"
        case .online: "在线"
        case .busy: "忙碌中"
        case .error: "异常"
        case .unreadResult: "待查看"
        }
    }

    var color: Color {
        switch self {
        case .offline: Color(.systemGray3)
        case .online: Color(red: 0.31, green: 0.82, blue: 0.77)
        case .busy: Color(red: 0.98, green: 0.75, blue: 0.14)
        case .error: Color(red: 0.94, green: 0.27, blue: 0.27)
        case .unreadResult: Color(red: 0.20, green: 0.48, blue: 0.95)
        }
    }

    var foregroundColor: Color {
        switch self {
        case .offline: .secondary
        default: color
        }
    }

    var glowColor: Color {
        switch self {
        case .offline: .clear
        default: color.opacity(0.55)
        }
    }

    func accessibilityTitle(detail: String? = nil) -> String {
        guard let detail, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return label
        }
        return "\(label)：\(detail)"
    }
}

struct AgentPresenceIndicator: View {
    let state: AgentPresenceState
    var detail: String?
    var size: CGFloat = 9
    var borderWidth: CGFloat = 2
    var borderColor: Color = Color(.systemBackground)

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: state != .busy || reduceMotion)) { context in
            dot(progress: pulseProgress(at: context.date))
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("AI 状态")
        .accessibilityValue(state.accessibilityTitle(detail: detail))
    }

    private func dot(progress: Double) -> some View {
        let activeProgress = state == .busy && !reduceMotion ? progress : 0
        let opacity = 1.0 - 0.58 * activeProgress
        let scale = 1.0 - 0.08 * activeProgress

        return Circle()
            .fill(state.color)
            .frame(width: size, height: size)
            .overlay {
                Circle()
                    .strokeBorder(borderColor, lineWidth: borderWidth)
            }
            .scaleEffect(scale)
            .opacity(opacity)
            .shadow(color: state.glowColor, radius: state == .offline ? 0 : size * 0.45)
    }

    private func pulseProgress(at date: Date) -> Double {
        guard state == .busy, !reduceMotion else { return 0 }
        let period = 1.1
        let phase = (date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)) / period
        return (sin(phase * 2 * .pi - .pi / 2) + 1) / 2
    }
}

// MARK: - 头像配色（与 client/web/src/types.ts COLOR_MAP 一致）

enum AgentColorPalette {
    private static let map: [String: Color] = [
        "blue": Color(red: 0.23, green: 0.51, blue: 0.96),
        "green": Color(red: 0.13, green: 0.77, blue: 0.37),
        "orange": Color(red: 0.98, green: 0.45, blue: 0.09),
        "purple": Color(red: 0.66, green: 0.33, blue: 0.97),
        "pink": Color(red: 0.93, green: 0.28, blue: 0.60),
        "red": Color(red: 0.94, green: 0.27, blue: 0.27),
        "teal": Color(red: 0.08, green: 0.72, blue: 0.65),
        "indigo": Color(red: 0.39, green: 0.40, blue: 0.95),
        "mint": Color(red: 0.20, green: 0.83, blue: 0.60),
        "cyan": Color(red: 0.02, green: 0.71, blue: 0.83),
    ]

    static func color(for name: String) -> Color {
        map[name] ?? .accentColor
    }
}

struct AgentAvatarView: View {
    let platform: String?
    let name: String
    var color: Color = .accentColor
    var size: CGFloat = 44
    var cornerRadius: CGFloat = 10
    var circular = false

    var body: some View {
        ZStack {
            background
            content
        }
        .frame(width: size, height: size)
        .overlay {
            border
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var background: some View {
        if circular {
            Circle()
                .fill(color.opacity(0.16))
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(color.opacity(0.16))
        }
    }

    @ViewBuilder
    private var border: some View {
        if circular {
            Circle()
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        } else {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let platform, let assetName = SupportedAgentCatalog.logoAssetName(for: platform) {
            if circular {
                logoContent(assetName: assetName, platform: platform)
                    .clipShape(Circle())
            } else {
                logoContent(assetName: assetName, platform: platform)
                    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            }
        } else {
            Text(initial)
                .font(.system(size: max(11, size * 0.36), weight: .bold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.65)
        }
    }

    @ViewBuilder
    private func logoContent(assetName: String, platform: String) -> some View {
        if SupportedAgentCatalog.isFullBleedLogo(for: platform) {
            Image(assetName)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
        } else {
            Image(assetName)
                .resizable()
                .scaledToFit()
                .padding(max(3, size * 0.16))
                .frame(width: size, height: size)
        }
    }

    private var initial: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "AI" }
        return String(first).uppercased()
    }
}
