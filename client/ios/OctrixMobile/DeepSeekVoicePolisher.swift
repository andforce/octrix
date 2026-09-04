import Foundation

enum DeepSeekVoiceModel: String, CaseIterable, Identifiable {
    case v4Flash = "deepseek-v4-flash"
    case v4Pro = "deepseek-v4-pro"

    var id: String { rawValue }
}

enum DeepSeekVoicePolishSettings {
    private enum Keys {
        static let apiKey = "voice.deepseek.apiKey"
        static let model = "voice.deepseek.model"
        static let verified = "voice.deepseek.verified"
        static let availableModels = "voice.deepseek.availableModels"
    }

    static var apiKey: String {
        Keychain.string(for: Keys.apiKey) ?? ""
    }

    static var configuredAPIKey: String? {
        let value = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static var hasAPIKey: Bool {
        configuredAPIKey != nil
    }

    static func saveAPIKey(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            clearAPIKey()
        } else {
            Keychain.set(trimmed, for: Keys.apiKey)
        }
    }

    static func clearAPIKey() {
        Keychain.delete(Keys.apiKey)
        resetVerification()
        selectedModel = .v4Flash
    }

    static func saveVerifiedAPIKey(_ value: String, availableModels: [DeepSeekVoiceModel]) {
        saveAPIKey(value)
        markVerified(availableModels: availableModels)
    }

    static var selectedModel: DeepSeekVoiceModel {
        get {
            let raw = UserDefaults.standard.string(forKey: Keys.model) ?? ""
            return DeepSeekVoiceModel(rawValue: raw) ?? .v4Flash
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: Keys.model)
        }
    }

    static func maskedAPIKey(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 8 else { return String(repeating: "•", count: max(trimmed.count, 4)) }
        return "\(trimmed.prefix(4))••••••••\(trimmed.suffix(4))"
    }

    static var isVerified: Bool {
        UserDefaults.standard.bool(forKey: Keys.verified)
    }

    static var availableModels: [DeepSeekVoiceModel] {
        let rawValues = UserDefaults.standard.stringArray(forKey: Keys.availableModels) ?? []
        let parsed = rawValues.compactMap(DeepSeekVoiceModel.init(rawValue:))
        return parsed.isEmpty ? [.v4Flash] : parsed
    }

    static func resetVerification() {
        UserDefaults.standard.set(false, forKey: Keys.verified)
        UserDefaults.standard.removeObject(forKey: Keys.availableModels)
    }

    private static func markVerified(availableModels: [DeepSeekVoiceModel]) {
        let models = availableModels.isEmpty ? [.v4Flash] : availableModels
        UserDefaults.standard.set(true, forKey: Keys.verified)
        UserDefaults.standard.set(models.map(\.rawValue), forKey: Keys.availableModels)
        if !models.contains(selectedModel) {
            selectedModel = models.first ?? .v4Flash
        }
    }
}

struct DeepSeekAPIValidator {
    let apiKey: String

    private static let endpoint = URL(string: "https://api.deepseek.com/models")!
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    func validateAvailableModels() async throws -> [DeepSeekVoiceModel] {
        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "DeepSeek 验证请求失败：\(error.localizedDescription)")
        }

        guard let http = response as? HTTPURLResponse else {
            throw RelayAPIError(message: "DeepSeek 验证响应无效")
        }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            let detail = parsed?.error?.message ?? parsed?.message ?? "HTTP \(http.statusCode)"
            if http.statusCode == 401 || http.statusCode == 403 {
                throw RelayAPIError(message: "DeepSeek Key 无效或无权限")
            }
            throw RelayAPIError(message: "DeepSeek 验证失败：\(detail)")
        }

        do {
            let decoded = try JSONDecoder().decode(ModelListResponse.self, from: data)
            let available = decoded.data.compactMap { DeepSeekVoiceModel(rawValue: $0.id) }
            guard !available.isEmpty else {
                throw RelayAPIError(message: "这个 Key 没有可用的 DeepSeek v4 模型")
            }
            return available
        } catch let error as RelayAPIError {
            throw error
        } catch {
            throw RelayAPIError(message: "DeepSeek 模型列表解析失败：\(error.localizedDescription)")
        }
    }
}

struct DeepSeekVoicePolisher {
    let apiKey: String
    let model: DeepSeekVoiceModel

    init(apiKey: String, model: DeepSeekVoiceModel = DeepSeekVoicePolishSettings.selectedModel) {
        self.apiKey = apiKey
        self.model = model
    }

    private static let endpoint = URL(string: "https://api.deepseek.com/chat/completions")!
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 20
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private static let systemPrompt = """
    你是一名专业的多语言语音转文字编辑器。你的任务是把用户的语音识别文本整理成适合直接发送给 AI 助手或聊天对象的清晰文本。

    要求：
    1. 去掉无意义的口水词、停顿词、重复犹豫词和多余标点，例如“嗯”“呃”“那个”“就是”“you know”等。
    2. 修正明显的语序、语法、标点和断句问题，让表达更自然、更连贯。
    3. 保留原始含义、语气、意图和所有关键信息，不要添加事实，不要替用户回答问题。
    4. 遇到多个事项、步骤、想法或条件时，可以整理成列表、分段或更清楚的结构。
    5. 支持多语言和中英混合输入；除非原文明确要求翻译，否则不要改变原文语言。
    6. 保留人名、产品名、路径、命令、代码标识符、URL、数字、单位、@ 提及、# 标签和 slash command。
    7. 如果原文很短或已经清楚，只做最小清理。
    8. 只输出整理后的文本，不要解释，不要加标题，不要使用代码块，不要包裹引号。
    """

    func polish(_ transcript: String) async throws -> String {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let body = ChatCompletionRequest(
            model: model.rawValue,
            thinking: Thinking(type: "disabled"),
            temperature: 0.2,
            maxTokens: 1200,
            messages: [
                Message(role: "system", content: Self.systemPrompt),
                Message(role: "user", content: Self.userPrompt(for: trimmed)),
            ],
        )

        var request = URLRequest(url: Self.endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw RelayAPIError(message: "DeepSeek 请求失败：\(error.localizedDescription)")
        }

        guard let http = response as? HTTPURLResponse else {
            throw RelayAPIError(message: "DeepSeek 响应无效")
        }
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder().decode(APIErrorResponse.self, from: data)
            let detail = parsed?.error?.message ?? parsed?.message ?? "HTTP \(http.statusCode)"
            throw RelayAPIError(message: "DeepSeek 返回错误：\(detail)")
        }

        let decoded = try JSONDecoder().decode(ChatCompletionResponse.self, from: data)
        let polished = decoded.choices.first?.message.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !polished.isEmpty else {
            throw RelayAPIError(message: "DeepSeek 返回内容为空")
        }
        return polished
    }

    private static func userPrompt(for transcript: String) -> String {
        """
        请整理下面的语音识别文本。只输出整理后的文本。

        <transcript>
        \(transcript)
        </transcript>
        """
    }
}

private struct ChatCompletionRequest: Encodable {
    let model: String
    let thinking: Thinking
    let temperature: Double
    let maxTokens: Int
    let messages: [Message]

    enum CodingKeys: String, CodingKey {
        case model
        case thinking
        case temperature
        case maxTokens = "max_tokens"
        case messages
    }
}

private struct Thinking: Encodable {
    let type: String
}

private struct Message: Encodable {
    let role: String
    let content: String
}

private struct ChatCompletionResponse: Decodable {
    let choices: [Choice]
}

private struct Choice: Decodable {
    let message: ResponseMessage
}

private struct ResponseMessage: Decodable {
    let content: String?
}

private struct APIErrorResponse: Decodable {
    let error: APIErrorDetail?
    let message: String?
}

private struct APIErrorDetail: Decodable {
    let message: String?
}

private struct ModelListResponse: Decodable {
    let data: [ModelInfo]
}

private struct ModelInfo: Decodable {
    let id: String
}
