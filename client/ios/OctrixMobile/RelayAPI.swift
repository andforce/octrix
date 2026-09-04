import Foundation

struct RelayAPIError: LocalizedError {
    let message: String
    let statusCode: Int?
    let code: String?
    var errorDescription: String? { message }

    init(message: String, statusCode: Int? = nil, code: String? = nil) {
        self.message = message
        self.statusCode = statusCode
        self.code = code
    }
}

private struct ServerErrorBody: Decodable {
    let error: String?
    let message: String?
}

private struct CloudServerErrorBody: Decodable {
    struct Detail: Decodable {
        let code: String?
        let message: String?
    }
    let error: Detail
}

private struct LegacyWorkspaceTrustPrompt: Decodable {
    let agentId: String
    let agentName: String
    let groupId: String
    let directory: String
    let rawPreview: String
    let detectedAt: Double
    let updatedAt: Double

    var normalized: AgentStartupPrompt {
        AgentStartupPrompt(
            kind: .workspaceTrust,
            agentId: agentId,
            agentName: agentName,
            groupId: groupId,
            directory: directory,
            rawPreview: rawPreview,
            detectedAt: detectedAt,
            updatedAt: updatedAt
        )
    }
}

private struct LegacyWorkspaceTrustPromptResponse: Decodable {
    let ok: Bool
    let prompts: [LegacyWorkspaceTrustPrompt]
}

private struct LegacyWorkspaceTrustConfirmationResponse: Decodable {
    let ok: Bool
    let confirmed: Int
    let prompts: [LegacyWorkspaceTrustPrompt]
}

/// 经中继服务器访问 Mac 上 CLI Bridge 的 REST API。
/// 除 /api/devices 外的所有请求都走 /d/{deviceId}/ 隧道前缀。
struct RelayAPI {
    let baseURL: URL
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    // MARK: - 请求基础

    private func makeRequest(
        _ method: String, path: String, body: Data? = nil, timeout: TimeInterval = 30,
    ) -> URLRequest {
        makeRequest(method, url: baseURL.appending(path: path), body: body, timeout: timeout)
    }

    private func makeRequest(
        _ method: String, url: URL, body: Data? = nil, timeout: TimeInterval = 30,
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        if !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "网络请求失败：\(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse else {
            throw RelayAPIError(message: "服务响应无效")
        }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder().decode(ServerErrorBody.self, from: data)
            let cloud = try? JSONDecoder().decode(CloudServerErrorBody.self, from: data)
            let detail = cloud?.error.message ?? parsed?.error ?? parsed?.message ?? "HTTP \(http.statusCode)"
            throw RelayAPIError(
                message: detail,
                statusCode: http.statusCode,
                code: cloud?.error.code
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw RelayAPIError(message: "响应解析失败：\(error.localizedDescription)")
        }
    }

    private func encodeBody(_ value: some Encodable) throws -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw RelayAPIError(message: "请求编码失败")
        }
    }

    // MARK: - 中继自身接口

    func devices() async throws -> [DeviceInfo] {
        let request = makeRequest("GET", path: "/api/devices")
        return try await send(request, as: DeviceListResponse.self).devices
    }

    func exchangeMobileAuthorization(code: String) async throws -> MobileAuthorizationTokenResponse {
        struct Payload: Encodable {
            let code: String
        }
        let request = makeRequest(
            "POST",
            path: "/api/v1/mobile/auth/token",
            body: try encodeBody(Payload(code: code)),
        )
        return try await send(request, as: MobileAuthorizationTokenResponse.self)
    }

    func authorizeWithApple(
        _ authorization: OctrixAppleAuthorization,
        deviceId: String,
        deviceName: String
    ) async throws -> MobileSMSAuthorizationResponse {
        struct Payload: Encodable {
            let authorizationCode: String
            let nonce: String
            let firstName: String?
            let lastName: String?
            let deviceId: String
            let deviceName: String

            enum CodingKeys: String, CodingKey {
                case nonce
                case authorizationCode = "authorization_code"
                case firstName = "first_name"
                case lastName = "last_name"
                case deviceId = "device_id"
                case deviceName = "device_name"
            }
        }
        let request = makeRequest(
            "POST",
            path: "/api/v1/mobile/auth/apple",
            body: try encodeBody(Payload(
                authorizationCode: authorization.code,
                nonce: authorization.nonce,
                firstName: authorization.firstName,
                lastName: authorization.lastName,
                deviceId: deviceId,
                deviceName: deviceName
            )),
        )
        return try await send(request, as: MobileSMSAuthorizationResponse.self)
    }

    func createMobileSMSChallenge(phone: String, deviceId: String, deviceName: String) async throws -> SMSChallengeResponse {
        struct Payload: Encodable {
            let phone: String
            let flow: String
            let deviceId: String
            let deviceName: String

            enum CodingKeys: String, CodingKey {
                case phone, flow
                case deviceId = "device_id"
                case deviceName = "device_name"
            }
        }
        let request = makeRequest(
            "POST",
            path: "/api/v1/auth/sms/challenges",
            body: try encodeBody(Payload(
                phone: phone,
                flow: "mobile_login",
                deviceId: deviceId,
                deviceName: deviceName
            )),
        )
        return try await send(request, as: SMSChallengeResponse.self)
    }

    func verifyMobileSMSChallenge(challengeId: String, code: String) async throws -> MobileSMSAuthorizationResponse {
        struct Payload: Encodable {
            let code: String
        }
        let request = makeRequest(
            "POST",
            path: "/api/v1/auth/sms/challenges/\(challengeId)/verify",
            body: try encodeBody(Payload(code: code)),
        )
        return try await send(request, as: MobileSMSAuthorizationResponse.self)
    }

    func revokeCurrentDevice() async throws {
        let request = makeRequest("POST", path: "/api/v1/device/token/revoke")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "网络请求失败：\(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let parsed = try? JSONDecoder().decode(CloudServerErrorBody.self, from: data)
            throw RelayAPIError(
                message: parsed?.error.message ?? "退出登录失败",
                statusCode: http?.statusCode,
                code: parsed?.error.code
            )
        }
    }

    func deleteMacDevice(deviceId: String) async throws {
        let request = makeRequest("DELETE", path: "/api/v1/account/mac-devices/\(deviceId)")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "网络请求失败：\(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let parsed = try? JSONDecoder().decode(CloudServerErrorBody.self, from: data)
            throw RelayAPIError(
                message: parsed?.error.message ?? "删除设备失败",
                statusCode: http?.statusCode,
                code: parsed?.error.code
            )
        }
    }

    func deleteAccount() async throws {
        let request = makeRequest("DELETE", path: "/api/v1/account")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "网络请求失败：\(error.localizedDescription)")
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let parsed = try? JSONDecoder().decode(CloudServerErrorBody.self, from: data)
            throw RelayAPIError(
                message: parsed?.error.message ?? "删除账号失败",
                statusCode: http?.statusCode,
                code: parsed?.error.code
            )
        }
    }

    // MARK: - 隧道到 Mac 的接口

    func state(deviceId: String) async throws -> AppState {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/state")
        return try await send(request, as: AppState.self)
    }

    func mobileState(deviceId: String) async throws -> MobileAppState {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/state/mobile")
        return try await send(request, as: MobileAppState.self)
    }

    func events(deviceId: String, since: Int, limit: Int = 500) async throws -> EventSyncResponse {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/events")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "since", value: String(since)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else {
            throw RelayAPIError(message: "事件同步请求地址无效")
        }
        let request = makeRequest("GET", url: url, timeout: 15)
        return try await send(request, as: EventSyncResponse.self)
    }

    func directories(deviceId: String, path: String?) async throws -> DirectoryListResponse {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/system/directories")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        if let path, !path.isEmpty {
            components?.queryItems = [URLQueryItem(name: "path", value: path)]
        }
        guard let url = components?.url else {
            throw RelayAPIError(message: "目录路径无效")
        }
        let request = makeRequest("GET", url: url)
        return try await send(request, as: DirectoryListResponse.self)
    }

    func groupFiles(deviceId: String, groupId: String, subpath: String?) async throws -> WorkspaceFileListResponse {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/groups/\(groupId)/files")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        if let subpath, !subpath.isEmpty {
            components?.queryItems = [URLQueryItem(name: "subpath", value: subpath)]
        }
        guard let url = components?.url else {
            throw RelayAPIError(message: "工作区路径无效")
        }
        let request = makeRequest("GET", url: url)
        return try await send(request, as: WorkspaceFileListResponse.self)
    }

    func groupFileContent(deviceId: String, groupId: String, path: String) async throws -> WorkspaceFileContentResponse {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/groups/\(groupId)/files/read")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let url = components?.url else {
            throw RelayAPIError(message: "文件路径无效")
        }
        let request = makeRequest("GET", url: url)
        return try await send(request, as: WorkspaceFileContentResponse.self)
    }

    func importWorkspaceFiles(
        deviceId: String,
        groupId: String,
        files: [WorkspaceUploadFile],
        targetSubpath: String?,
    ) async throws -> WorkspaceImportResponse {
        guard !files.isEmpty else {
            throw RelayAPIError(message: "没有可上传的文件")
        }

        let boundary = "OctrixBoundary-\(UUID().uuidString)"
        var fields: [String: String] = [:]
        if let targetSubpath, !targetSubpath.isEmpty {
            fields["targetSubpath"] = targetSubpath
        }

        var request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/files/import",
            timeout: 120,
        )
        request.httpBody = multipartBody(fields: fields, files: files, boundary: boundary)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        return try await send(request, as: WorkspaceImportResponse.self)
    }

    func gitStatus(deviceId: String, groupId: String) async throws -> GitWorkspaceStatus {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/groups/\(groupId)/git/status")
        return try await send(request, as: GitWorkspaceStatus.self)
    }

    func skills(deviceId: String, refresh: Bool = false) async throws -> [SkillListItem] {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/skills")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        if refresh {
            components?.queryItems = [URLQueryItem(name: "refresh", value: "1")]
        }
        guard let url = components?.url else {
            throw RelayAPIError(message: "Skill 请求地址无效")
        }
        let request = makeRequest("GET", url: url)
        return try await send(request, as: SkillListResponse.self).skills
    }

    func cliCommands(deviceId: String, platform: String) async throws -> [CliCommandItem] {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/cli-commands")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "platform", value: platform)]
        guard let url = components?.url else {
            throw RelayAPIError(message: "命令请求地址无效")
        }
        let request = makeRequest("GET", url: url)
        return try await send(request, as: CliCommandListResponse.self).commands
    }

    func startModelPicker(deviceId: String, agentId: String, groupId: String, mode: String = "model") async throws -> ModelPickerSnapshot {
        struct Payload: Encodable {
            let groupId: String
            let mode: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/agents/\(agentId)/model-picker/start",
            body: try encodeBody(Payload(groupId: groupId, mode: mode)),
            timeout: 15,
        )
        return try await send(request, as: ModelPickerResponse.self).picker
    }

    func modelPicker(deviceId: String, agentId: String, groupId: String) async throws -> ModelPickerSnapshot {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/agents/\(agentId)/model-picker")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "groupId", value: groupId)]
        guard let url = components?.url else {
            throw RelayAPIError(message: "模型选择请求地址无效")
        }
        let request = makeRequest("GET", url: url, timeout: 15)
        return try await send(request, as: ModelPickerResponse.self).picker
    }

    func chooseModel(
        deviceId: String,
        agentId: String,
        groupId: String,
        optionIndex: Int,
    ) async throws -> ModelPickerSnapshot {
        struct Payload: Encodable {
            let groupId: String
            let optionIndex: Int
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/agents/\(agentId)/model-picker/choose",
            body: try encodeBody(Payload(groupId: groupId, optionIndex: optionIndex)),
            timeout: 15,
        )
        return try await send(request, as: ModelPickerResponse.self).picker
    }

    func sendModelPickerInput(
        deviceId: String,
        agentId: String,
        groupId: String,
        action: ModelPickerInputAction,
    ) async throws -> ModelPickerSnapshot {
        struct Payload: Encodable {
            let groupId: String
            let action: ModelPickerInputAction
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/agents/\(agentId)/model-picker/input",
            body: try encodeBody(Payload(groupId: groupId, action: action)),
            timeout: 15,
        )
        return try await send(request, as: ModelPickerResponse.self).picker
    }

    func addAgent(deviceId: String, platform: String, avatarColor: String) async throws -> Agent {
        struct Payload: Encodable {
            let platform: String
            let avatarColor: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/agents",
            body: try encodeBody(Payload(platform: platform, avatarColor: avatarColor)),
        )
        return try await send(request, as: Agent.self)
    }

    func deleteAgent(deviceId: String, agentId: String) async throws {
        struct OkResponse: Decodable { let ok: Bool }
        let request = makeRequest("DELETE", path: "/d/\(deviceId)/api/agents/\(agentId)")
        _ = try await send(request, as: OkResponse.self)
    }

    func createGroup(
        deviceId: String,
        name: String,
        ownerName: String,
        members: [(agentId: String, roleId: String?)],
        workingDirectory: String,
        groupType: String = "collaboration",
        roleLeaders: [String: String] = [:],
    ) async throws -> AgentGroup {
        struct MemberPayload: Encodable {
            let agentId: String
            let roleId: String?
        }
        struct Payload: Encodable {
            let name: String
            let ownerName: String
            let members: [MemberPayload]
            let workingDirectory: String
            let groupType: String
            let roleLeaders: [String: String]
        }
        let payload = Payload(
            name: name,
            ownerName: ownerName,
            members: members.map { MemberPayload(agentId: $0.agentId, roleId: $0.roleId) },
            workingDirectory: workingDirectory,
            groupType: groupType,
            roleLeaders: roleLeaders,
        )
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups",
            body: try encodeBody(payload),
            timeout: 180,
        )
        return try await send(request, as: AgentGroup.self)
    }

    func agentStartupPrompts(deviceId: String, groupId: String) async throws -> [AgentStartupPrompt] {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/groups/\(groupId)/agent-startup-prompts", timeout: 15)
        return try await send(request, as: AgentStartupPromptResponse.self).prompts
    }

    func workspaceTrustPrompts(deviceId: String, groupId: String) async throws -> [AgentStartupPrompt] {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/groups/\(groupId)/workspace-trust", timeout: 15)
        let response = try await send(request, as: LegacyWorkspaceTrustPromptResponse.self)
        return response.prompts.map(\.normalized)
    }

    func resolveAgentStartupPrompts(
        deviceId: String,
        groupId: String,
        action: AgentStartupPromptAction,
        agentIds: [String]? = nil,
    ) async throws -> AgentStartupPromptResolutionResponse {
        struct Payload: Encodable {
            let action: AgentStartupPromptAction
            let agentIds: [String]?
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/agent-startup-prompts/resolve",
            body: try encodeBody(Payload(action: action, agentIds: agentIds)),
            timeout: 15,
        )
        return try await send(request, as: AgentStartupPromptResolutionResponse.self)
    }

    func confirmWorkspaceTrust(
        deviceId: String,
        groupId: String,
        agentIds: [String]? = nil,
    ) async throws -> AgentStartupPromptResolutionResponse {
        struct Payload: Encodable {
            let agentIds: [String]?
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/workspace-trust/confirm",
            body: try encodeBody(Payload(agentIds: agentIds)),
            timeout: 15,
        )
        let response = try await send(request, as: LegacyWorkspaceTrustConfirmationResponse.self)
        return AgentStartupPromptResolutionResponse(
            ok: response.ok,
            resolved: response.confirmed,
            prompts: response.prompts.map(\.normalized)
        )
    }

    func archiveGroup(deviceId: String, groupId: String) async throws -> GroupMutationResponse {
        let request = makeRequest("POST", path: "/d/\(deviceId)/api/groups/\(groupId)/archive")
        return try await send(request, as: GroupMutationResponse.self)
    }

    func unarchiveGroup(deviceId: String, groupId: String) async throws -> GroupMutationResponse {
        let request = makeRequest("POST", path: "/d/\(deviceId)/api/groups/\(groupId)/unarchive")
        return try await send(request, as: GroupMutationResponse.self)
    }

    func deleteGroup(deviceId: String, groupId: String) async throws {
        struct OkResponse: Decodable { let ok: Bool }
        let request = makeRequest("DELETE", path: "/d/\(deviceId)/api/groups/\(groupId)")
        _ = try await send(request, as: OkResponse.self)
    }

    func goOnline(deviceId: String, groupId: String, memberId: String) async throws {
        struct OkResponse: Decodable { let ok: Bool }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/members/\(memberId)/online",
            timeout: 180,
        )
        _ = try await send(request, as: OkResponse.self)
    }

    func goOffline(deviceId: String, groupId: String, memberId: String) async throws {
        struct OkResponse: Decodable { let ok: Bool }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/members/\(memberId)/offline",
            timeout: 30,
        )
        _ = try await send(request, as: OkResponse.self)
    }

    func sendMessage(
        deviceId: String, body: String, groupId: String,
        taskSessionId: String?, to: String, agentIds: [String], clientMsgId: String,
    ) async throws {
        struct Payload: Encodable {
            let body: String
            let groupId: String
            let taskSessionId: String?
            let to: String
            let agentIds: [String]
            let clientMsgId: String
        }
        struct OkResponse: Decodable { let ok: Bool }
        let payload = Payload(
            body: body,
            groupId: groupId,
            taskSessionId: taskSessionId,
            to: to,
            agentIds: agentIds,
            clientMsgId: clientMsgId
        )
        let request = makeRequest("POST", path: "/d/\(deviceId)/api/messages", body: try encodeBody(payload))
        _ = try await send(request, as: OkResponse.self)
    }

    func interruptAgents(
        deviceId: String,
        groupId: String,
        taskSessionId: String,
        targets: [AgentResponseTarget]
    ) async throws -> InterruptAgentsResponse {
        struct Payload: Encodable {
            let taskSessionId: String
            let targets: [AgentResponseTarget]
        }
        let payload = Payload(taskSessionId: taskSessionId, targets: targets)
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/interrupt",
            body: try encodeBody(payload),
            timeout: 15,
        )
        return try await send(request, as: InterruptAgentsResponse.self)
    }

    func message(deviceId: String, id: String) async throws -> Envelope {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/messages/\(id)")
        return try await send(request, as: Envelope.self)
    }

    func groupMessages(
        deviceId: String,
        groupId: String,
        taskSessionId: String?,
        before: Double? = nil,
        limit: Int = 50
    ) async throws -> MessagePageResponse {
        let base = baseURL.appending(path: "/d/\(deviceId)/api/groups/\(groupId)/messages")
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let taskSessionId {
            items.append(URLQueryItem(name: "taskSessionId", value: taskSessionId))
        }
        if let before {
            items.append(URLQueryItem(name: "before", value: String(before)))
        }
        components?.queryItems = items
        guard let url = components?.url else {
            throw RelayAPIError(message: "消息分页请求地址无效")
        }
        let request = makeRequest("GET", url: url, timeout: 15)
        return try await send(request, as: MessagePageResponse.self)
    }

    func missions(deviceId: String, groupId: String) async throws -> MissionListResponse {
        let request = makeRequest("GET", path: "/d/\(deviceId)/api/groups/\(groupId)/missions")
        return try await send(request, as: MissionListResponse.self)
    }

    func mission(deviceId: String, groupId: String, missionId: String) async throws -> MissionDetailResponse {
        let request = makeRequest(
            "GET",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)",
        )
        return try await send(request, as: MissionDetailResponse.self)
    }

    func previewMission(
        deviceId: String,
        groupId: String,
        goal: String,
    ) async throws -> MissionPreviewResponse {
        struct Payload: Encodable { let goal: String }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/preview",
            body: try encodeBody(Payload(goal: goal)),
        )
        return try await send(request, as: MissionPreviewResponse.self)
    }

    func createMission(
        deviceId: String,
        groupId: String,
        title: String,
        objective: String,
        template: String,
        acceptanceCriteria: [String],
        qualityPolicy: MissionQualityPolicy,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let title: String
            let objective: String
            let template: String
            let acceptanceCriteria: [String]
            let qualityPolicy: MissionQualityPolicy
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions",
            body: try encodeBody(Payload(
                title: title,
                objective: objective,
                template: template,
                acceptanceCriteria: acceptanceCriteria,
                qualityPolicy: qualityPolicy,
            )),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func updateMissionCharter(
        deviceId: String,
        groupId: String,
        missionId: String,
        title: String,
        objective: String,
        acceptanceCriteria: [String],
        qualityPolicy: MissionQualityPolicy,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let title: String
            let objective: String
            let acceptanceCriteria: [String]
            let qualityPolicy: MissionQualityPolicy
        }
        let request = makeRequest(
            "PUT",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/charter",
            body: try encodeBody(Payload(
                title: title,
                objective: objective,
                acceptanceCriteria: acceptanceCriteria,
                qualityPolicy: qualityPolicy,
            )),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func updateMissionPlan(
        deviceId: String,
        groupId: String,
        missionId: String,
        roleIds: [String],
        autoMergeAuthorized: Bool,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let roleIds: [String]
            let autoMergeAuthorized: Bool
        }
        let request = makeRequest(
            "PUT",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/plan",
            body: try encodeBody(Payload(
                roleIds: roleIds,
                autoMergeAuthorized: autoMergeAuthorized,
            )),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func resolveMissingRole(
        deviceId: String,
        groupId: String,
        missionId: String,
        roleId: String,
        resolution: String,
        note: String,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let resolution: String
            let note: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/missing-roles/\(roleId)",
            body: try encodeBody(Payload(resolution: resolution, note: note)),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func startMission(deviceId: String, groupId: String, missionId: String) async throws -> MissionMutationResponse {
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/start",
            timeout: 180,
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func missionOwnerAction(
        deviceId: String,
        groupId: String,
        missionId: String,
        action: String,
        note: String,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable { let note: String }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/\(action)",
            body: try encodeBody(Payload(note: note)),
            timeout: action == "resume" ? 180 : 30,
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func acceptMissionRisk(
        deviceId: String,
        groupId: String,
        missionId: String,
        issueIds: [String],
        note: String,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let issueIds: [String]
            let note: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/accept-risk",
            body: try encodeBody(Payload(issueIds: issueIds, note: note)),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func extendMissionRework(
        deviceId: String,
        groupId: String,
        missionId: String,
        additionalRounds: Int,
        note: String,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let additionalRounds: Int
            let note: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/extend-rework",
            body: try encodeBody(Payload(additionalRounds: additionalRounds, note: note)),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func reassignMissionWorkItem(
        deviceId: String,
        groupId: String,
        missionId: String,
        workItemId: String,
        targetMemberId: String,
        note: String,
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let targetMemberId: String
            let note: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/work-items/\(workItemId)/reassign",
            body: try encodeBody(Payload(targetMemberId: targetMemberId, note: note)),
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func resolveMissionExternalChanges(
        deviceId: String,
        groupId: String,
        missionId: String,
        decision: String,
        note: String
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable {
            let decision: String
            let note: String
        }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/external-changes",
            body: try encodeBody(Payload(decision: decision, note: note)),
            timeout: 180
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    func importMissionExternalImplementation(
        deviceId: String,
        groupId: String,
        missionId: String,
        note: String
    ) async throws -> MissionMutationResponse {
        struct Payload: Encodable { let note: String }
        let request = makeRequest(
            "POST",
            path: "/d/\(deviceId)/api/groups/\(groupId)/missions/\(missionId)/external-implementation",
            body: try encodeBody(Payload(note: note)),
            timeout: 180
        )
        return try await send(request, as: MissionMutationResponse.self)
    }

    private func multipartBody(
        fields: [String: String],
        files: [WorkspaceUploadFile],
        boundary: String,
    ) -> Data {
        var body = Data()

        for (name, value) in fields {
            body.appendUTF8("--\(boundary)\r\n")
            body.appendUTF8("Content-Disposition: form-data; name=\"\(escapedMultipartValue(name))\"\r\n\r\n")
            body.appendUTF8("\(value)\r\n")
        }

        for file in files {
            body.appendUTF8("--\(boundary)\r\n")
            body.appendUTF8(
                "Content-Disposition: form-data; name=\"files\"; filename=\"\(escapedMultipartValue(file.filename))\"\r\n",
            )
            body.appendUTF8("Content-Type: \(file.contentType)\r\n\r\n")
            body.append(file.data)
            body.appendUTF8("\r\n")
        }

        body.appendUTF8("--\(boundary)--\r\n")
        return body
    }

    private func escapedMultipartValue(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
    }
}

private extension Data {
    mutating func appendUTF8(_ string: String) {
        append(Data(string.utf8))
    }
}
