import Foundation
import SwiftUI

/// 单条消息气泡：群聊保留头像气泡，单聊使用更宽的无头像阅读布局。
struct MessageBubble: View, Equatable {
    @EnvironmentObject private var store: AppStore

    let message: Envelope
    let agent: Agent?
    let roleName: String?
    let serverId: String
    let group: AgentGroup
    let isDirectChat: Bool
    let avatarPresence: AgentPresenceState
    let agentError: String?
    let onLongPressAvatar: ((Agent) -> Void)?

    @State private var isToolSummaryExpanded = false

    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message
            && lhs.agent == rhs.agent
            && lhs.roleName == rhs.roleName
            && lhs.serverId == rhs.serverId
            && lhs.group == rhs.group
            && lhs.isDirectChat == rhs.isDirectChat
            && lhs.avatarPresence == rhs.avatarPresence
            && lhs.agentError == rhs.agentError
    }

    @ViewBuilder
    var body: some View {
        switch message.from {
        case "user":
            if isDirectChat {
                directUserBubble
            } else {
                userBubble
            }
        case "system":
            systemLine
        default:
            if isDirectChat {
                directAgentContent
            } else {
                agentBubble
            }
        }
    }

    // MARK: - 用户消息

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 3) {
                if !message.to.isEmpty {
                    Text("发给 \(message.to)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(message.body)
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.accentColor),
                    )
                timestamp
            }
        }
    }

    private var directUserBubble: some View {
        HStack {
            Spacer(minLength: 68)
            VStack(alignment: .trailing, spacing: 4) {
                if !message.to.isEmpty {
                    Text("发给 \(message.to)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(message.body)
                    .font(.body)
                    .foregroundStyle(Color.accentColor)
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(Color.accentColor.opacity(0.12)),
                    )
                timestamp
            }
        }
    }

    // MARK: - 系统消息

    private var systemLine: some View {
        Text(message.body)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
    }

    // MARK: - Agent 消息

    private var directAgentContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            bubbleContent
                .frame(maxWidth: .infinity, alignment: .leading)
            timestamp
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var agentBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            avatar
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(message.from)
                        .font(.caption.weight(.semibold))
                    if let roleName {
                        Text(roleName)
                            .font(.caption2)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color(.systemGray5)))
                            .foregroundStyle(.secondary)
                    }
                }
                bubbleContent
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color(.systemGray6)),
                    )
                timestamp
            }
            Spacer(minLength: 36)
        }
    }

    private var avatar: some View {
        AgentAvatarView(
            platform: agent?.platform,
            name: agent?.name ?? message.from,
            color: AgentColorPalette.color(for: agent?.avatarColor ?? "blue"),
            size: 32,
            cornerRadius: 16,
            circular: true,
        )
        .overlay(alignment: .bottomLeading) {
            AgentPresenceIndicator(
                state: avatarPresence,
                detail: agentError,
                size: 10,
                borderWidth: 1.8,
            )
            .offset(x: -1, y: 1)
        }
        .contentShape(Circle())
        .onLongPressGesture(minimumDuration: 0.45) {
            guard let agent else { return }
            onLongPressAvatar?(agent)
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            let entries = visibleEntries
            let toolEntries = visibleToolEntries(from: entries)
            let contentEntries = entries.filter { $0.role != "tool" || $0.humanInput != nil }
            if !entries.isEmpty {
                if !toolEntries.isEmpty {
                    toolSummaryView(entries: toolEntries)
                }
                ForEach(contentEntries) { entry in
                    entryView(entry)
                }
            } else if !message.body.isEmpty {
                MarkdownMessageView(raw: message.body, isDirectChat: isDirectChat)
                    .textSelection(.enabled)
            }

            if message.isStreaming {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text(isEmptyContent ? "正在思考…" : "正在输出…")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else if isEmptyContent {
                Text("（空消息）")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var isEmptyContent: Bool {
        message.body.isEmpty && visibleEntries.isEmpty
    }

    private var visibleEntries: [ConversationEntry] {
        guard let entries = message.entries else { return [] }
        let nonEmptyEntries = entries.filter {
            !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let hasFinalAnswer = nonEmptyEntries.contains {
            $0.role == "assistant" && $0.phase == "final_answer"
        }
        guard hasFinalAnswer else { return nonEmptyEntries }
        return nonEmptyEntries.filter {
            $0.role != "assistant" || $0.phase == "final_answer"
        }
    }

    private func visibleToolEntries(from entries: [ConversationEntry]) -> [ConversationEntry] {
        var seen = Set<String>()
        return entries.filter { entry in
            guard entry.role == "tool", entry.humanInput == nil else { return false }
            let key = entry.dedupeKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                ? entry.dedupeKey!
                : entry.id
            return seen.insert(key).inserted
        }
    }

    private func toolSummaryGroups(from entries: [ConversationEntry]) -> [ToolSummaryGroup] {
        var orderedNames: [String] = []
        var groupedEntries: [String: [ConversationEntry]] = [:]

        for entry in entries {
            let name = normalizedToolName(entry.toolName)
            if groupedEntries[name] == nil {
                orderedNames.append(name)
                groupedEntries[name] = []
            }
            groupedEntries[name, default: []].append(entry)
        }

        return orderedNames.map { name in
            ToolSummaryGroup(name: name, entries: groupedEntries[name] ?? [])
        }
    }

    private func normalizedToolName(_ name: String?) -> String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "工具调用" : trimmed
    }

    private func toolSummaryOverview(_ groups: [ToolSummaryGroup]) -> String {
        let visibleGroups = groups.prefix(3).map { group in
            group.count > 1 ? "\(group.name) × \(group.count)" : group.name
        }
        let suffix = groups.count > 3 ? " 等 \(groups.count) 类" : ""
        return visibleGroups.joined(separator: ", ") + suffix
    }

    @ViewBuilder
    private func toolSummaryView(entries: [ConversationEntry]) -> some View {
        let groups = toolSummaryGroups(from: entries)
        let overview = toolSummaryOverview(groups)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isToolSummaryExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver")
                    Text("调用了 \(entries.count) 个工具")
                        .fontWeight(.semibold)
                    if !overview.isEmpty {
                        Text("· \(overview)")
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(isToolSummaryExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isToolSummaryExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(groups) { group in
                        toolSummaryGroupView(group)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.gray.opacity(0.10)),
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.gray.opacity(0.14), lineWidth: 1),
        )
    }

    @ViewBuilder
    private func toolSummaryGroupView(_ group: ToolSummaryGroup) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(group.name)
                    .fontWeight(.semibold)
                    .lineLimit(1)
                if group.count > 1 {
                    Text("× \(group.count)")
                        .foregroundStyle(.tertiary)
                }
            }

            ForEach(group.entries.prefix(2)) { entry in
                let preview = firstLine(entry.content)
                if !preview.isEmpty {
                    Text(preview)
                        .font(.caption2.monospaced())
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(.tertiary)
                }
            }

            if group.count > 2 {
                Text("另 \(group.count - 2) 条…")
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.leading, 2)
    }

    @ViewBuilder
    private func entryView(_ entry: ConversationEntry) -> some View {
        if let humanInput = entry.humanInput {
            HumanInputRequestCard(
                request: humanInput,
                isDirectChat: isDirectChat
            ) { answerText in
                try await sendHumanInputAnswer(answerText)
            }
        } else {
            switch entry.role {
            case "assistant":
                MarkdownMessageView(raw: entry.content, isDirectChat: isDirectChat)
                    .textSelection(.enabled)
            case "thinking":
                Label {
                    Text(entry.content)
                        .lineLimit(2)
                } icon: {
                    Image(systemName: "brain")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            case "tool":
                Label {
                    Text(entry.toolName ?? "工具调用")
                        + Text(firstLine(entry.content).isEmpty ? "" : " · \(firstLine(entry.content))")
                } icon: {
                    Image(systemName: "wrench.and.screwdriver")
                }
                .font(.caption2)
                .lineLimit(1)
                .foregroundStyle(.secondary)
            default:
                EmptyView()
            }
        }
    }

    private var timestamp: some View {
        Text(message.date, style: .time)
            .font(.caption2)
            .foregroundStyle(.tertiary)
    }

    private func firstLine(_ text: String) -> String {
        text.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
    }

    private func sendHumanInputAnswer(_ text: String) async throws {
        guard let taskSessionId = message.taskSessionId else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let agent {
            try await store.sendMessage(
                text: trimmed,
                group: group,
                taskSessionId: taskSessionId,
                to: agent.name,
                agentIds: [agent.id],
                serverId: serverId
            )
        } else {
            try await store.sendMessage(
                text: trimmed,
                group: group,
                taskSessionId: taskSessionId,
                serverId: serverId
            )
        }
    }
}

private struct ToolSummaryGroup: Identifiable, Hashable {
    let name: String
    let entries: [ConversationEntry]

    var id: String { name }
    var count: Int { entries.count }
}

private struct HumanInputRequestCard: View {
    let request: HumanInputRequest
    let isDirectChat: Bool
    let onSubmit: (String) async throws -> Void

    @State private var pageIndex = 0
    @State private var selectedAnswers: [String: [String]] = [:]
    @State private var customAnswers: [String: String] = [:]
    @State private var isSending = false
    @State private var errorMessage: String?

    private var safeQuestions: [HumanInputQuestion] {
        request.questions.isEmpty
            ? [HumanInputQuestion(id: "question", header: nil, question: "需要你的回答", options: [], multiSelect: nil)]
            : request.questions
    }

    private var currentQuestion: HumanInputQuestion {
        safeQuestions[min(max(pageIndex, 0), safeQuestions.count - 1)]
    }

    private var currentCustomBinding: Binding<String> {
        Binding(
            get: { customAnswers[currentQuestion.id] ?? "" },
            set: { customAnswers[currentQuestion.id] = $0 }
        )
    }

    private var hasAnyAnswer: Bool {
        safeQuestions.contains { question in
            let custom = (customAnswers[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return !custom.isEmpty || !(selectedAnswers[question.id] ?? []).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            questionBody
            footer
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.secondarySystemBackground).opacity(0.96)),
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.42), lineWidth: 1),
        )
        .shadow(color: Color.black.opacity(0.10), radius: 18, x: 0, y: 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                pageIndex = max(0, pageIndex - 1)
            } label: {
                Image(systemName: "chevron.left")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(pageIndex > 0 ? .primary : .tertiary)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(pageIndex == 0)

            Text("\(pageIndex + 1)/\(safeQuestions.count)")
                .font(.headline.monospacedDigit())
                .foregroundStyle(.secondary)

            Button {
                pageIndex = min(safeQuestions.count - 1, pageIndex + 1)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(pageIndex < safeQuestions.count - 1 ? .primary : .tertiary)
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            .disabled(pageIndex >= safeQuestions.count - 1)

            Spacer(minLength: 0)

            if request.isAnswered {
                Label("已回答", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var questionBody: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let header = currentQuestion.header, !header.isEmpty {
                Text(header)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            Text(currentQuestion.question)
                .font(isDirectChat ? .title3.weight(.bold) : .headline.weight(.bold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(currentQuestion.options.enumerated()), id: \.offset) { offset, option in
                    optionRow(option)
                    if offset < currentQuestion.options.count - 1 {
                        Divider()
                    }
                }
            }
        }
    }

    private func optionRow(_ option: HumanInputOption) -> some View {
        let isSelected = selectedLabels(for: currentQuestion.id).contains(option.label)
        return Button {
            guard !request.isAnswered else { return }
            if currentQuestion.allowsMultipleSelection {
                var labels = selectedAnswers[currentQuestion.id] ?? []
                if labels.contains(option.label) {
                    labels.removeAll { $0 == option.label }
                } else {
                    labels.append(option.label)
                }
                selectedAnswers[currentQuestion.id] = labels
            } else {
                selectedAnswers[currentQuestion.id] = [option.label]
            }
            customAnswers[currentQuestion.id] = ""
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.label)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(request.isAnswered)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Image(systemName: "pencil")
                .font(.body)
                .foregroundStyle(.secondary)

            TextField("请描述其他答案", text: currentCustomBinding, axis: .vertical)
                .font(.body)
                .lineLimit(1...3)
                .disabled(request.isAnswered)
                .onChange(of: customAnswers[currentQuestion.id] ?? "") { _, value in
                    if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        selectedAnswers[currentQuestion.id] = nil
                    }
                }

            Spacer(minLength: 0)

            Button {
                submitCurrent()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 44)
                } else {
                    Text(request.isAnswered ? "已发送" : hasAnyAnswer ? "发送" : "跳过")
                        .font(.body.weight(.semibold))
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
            .disabled(request.isAnswered || isSending)
        }
    }

    private func selectedLabels(for questionId: String) -> [String] {
        if let local = selectedAnswers[questionId] {
            return local
        }
        return request.selectedAnswers?[questionId] ?? []
    }

    private func submitCurrent() {
        let answerText = answerTextForSubmission()
        isSending = true
        errorMessage = nil
        Task { @MainActor in
            do {
                try await onSubmit(answerText)
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }

    private func answerTextForSubmission() -> String {
        let rows = safeQuestions.compactMap { question -> String? in
            let custom = (customAnswers[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let selected = selectedAnswers[question.id] ?? []
            let answer = !custom.isEmpty ? custom : selected.joined(separator: ", ")
            guard !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            if safeQuestions.count == 1 {
                return answer
            }
            return "\(question.question)\n答案：\(answer)"
        }

        if rows.isEmpty {
            return "跳过"
        }
        return rows.joined(separator: "\n\n")
    }
}

private struct MarkdownMessageView: View {
    let raw: String
    let isDirectChat: Bool

    private var blocks: [MarkdownBlock] {
        MarkdownBlockParser.parseCached(raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                blockView(block, index: index)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock, index: Int) -> some View {
        switch block {
        case .paragraph(let text):
            inlineMarkdownText(text)
                .font(bodyFont)
                .fixedSize(horizontal: false, vertical: true)

        case .heading(let level, let text):
            inlineMarkdownText(text)
                .font(headingFont(level: level))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, index == 0 ? 0 : 4)

        case .unorderedList(let items):
            listStack(items: items) { _ in
                Text("•")
                    .font(bodyFont.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 14, alignment: .trailing)
            }

        case .orderedList(let items):
            listStack(items: items.map(\.text)) { offset in
                Text("\(items[offset].number).")
                    .font(bodyFont.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 28, alignment: .trailing)
            }

        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Capsule()
                    .fill(Color.accentColor.opacity(0.45))
                    .frame(width: 3)
                MarkdownMessageView(raw: text, isDirectChat: isDirectChat)
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.gray.opacity(0.09)),
            )

        case .codeBlock(let language, let code):
            codeBlock(language: language, code: code)

        case .divider:
            Divider()
                .padding(.vertical, 4)
        }
    }

    private func listStack<Marker: View>(
        items: [String],
        @ViewBuilder marker: @escaping (Int) -> Marker
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(offset)
                    inlineMarkdownText(item)
                        .font(bodyFont)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func codeBlock(language: String?, code: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language, !language.isEmpty {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold).monospaced())
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code.isEmpty ? " " : code)
                    .font(codeBlockFont)
                    .foregroundStyle(.primary)
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.gray.opacity(0.10)),
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.gray.opacity(0.18), lineWidth: 1),
        )
    }

    private var bodyFont: Font {
        isDirectChat ? .body : .subheadline
    }

    private var codeBlockFont: Font {
        .system(isDirectChat ? .callout : .caption, design: .monospaced)
    }

    private func headingFont(level: Int) -> Font {
        if isDirectChat {
            switch level {
            case 1: return .title3.weight(.bold)
            case 2: return .headline.weight(.bold)
            case 3: return .body.weight(.semibold)
            default: return .callout.weight(.semibold)
            }
        }

        switch level {
        case 1: return .headline.weight(.bold)
        case 2: return .subheadline.weight(.bold)
        default: return .subheadline.weight(.semibold)
        }
    }

    /// 渲染 Markdown 行内语法；块级布局由 MarkdownMessageView 自己处理。
    private func inlineMarkdownText(_ raw: String) -> Text {
        if let attributed = MarkdownInlineCache.shared.attributedText(
            for: raw,
            isDirectChat: isDirectChat
        ) {
            return Text(attributed)
        }
        return Text(raw)
    }
}

private enum MarkdownBlock {
    case paragraph(String)
    case heading(level: Int, text: String)
    case unorderedList([String])
    case orderedList([(number: String, text: String)])
    case quote(String)
    case codeBlock(language: String?, code: String)
    case divider
}

private enum MarkdownBlockParser {
    private static let cache = MarkdownBlockCache()

    static func parseCached(_ raw: String) -> [MarkdownBlock] {
        cache.blocks(for: raw) {
            parse(raw)
        }
    }

    static func parse(_ raw: String) -> [MarkdownBlock] {
        let lines = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = trim(line)

            if trimmed.isEmpty {
                index += 1
                continue
            }

            if let fence = fenceStart(trimmed) {
                index += 1
                var codeLines: [String] = []
                while index < lines.count {
                    if trim(lines[index]).hasPrefix(fence.marker) {
                        index += 1
                        break
                    }
                    codeLines.append(lines[index])
                    index += 1
                }
                blocks.append(.codeBlock(language: fence.language, code: codeLines.joined(separator: "\n")))
                continue
            }

            if isDivider(trimmed) {
                blocks.append(.divider)
                index += 1
                continue
            }

            if let heading = heading(trimmed) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if unorderedListItem(line) != nil {
                var items: [String] = []
                while index < lines.count, let item = unorderedListItem(lines[index]) {
                    index += 1
                    items.append(consumeContinuationLines(after: item, lines: lines, index: &index))
                }
                blocks.append(.unorderedList(items))
                continue
            }

            if orderedListItem(line) != nil {
                var items: [(number: String, text: String)] = []
                while index < lines.count, let item = orderedListItem(lines[index]) {
                    index += 1
                    let text = consumeContinuationLines(after: item.text, lines: lines, index: &index)
                    items.append((number: item.number, text: text))
                }
                blocks.append(.orderedList(items))
                continue
            }

            if quoteLine(line) != nil {
                var quoteLines: [String] = []
                while index < lines.count, let quote = quoteLine(lines[index]) {
                    quoteLines.append(quote)
                    index += 1
                }
                blocks.append(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            var paragraphLines = [trimmed]
            index += 1
            while index < lines.count {
                let next = lines[index]
                let nextTrimmed = trim(next)
                if nextTrimmed.isEmpty || startsBlock(next) {
                    break
                }
                paragraphLines.append(nextTrimmed)
                index += 1
            }
            blocks.append(.paragraph(paragraphLines.joined(separator: "\n")))
        }

        return blocks
    }

    private static func consumeContinuationLines(
        after firstLine: String,
        lines: [String],
        index: inout Int
    ) -> String {
        var itemLines = [firstLine]
        while index < lines.count {
            let line = lines[index]
            let trimmed = trim(line)
            if trimmed.isEmpty || startsBlock(line) {
                break
            }
            itemLines.append(trimmed)
            index += 1
        }
        return itemLines.joined(separator: "\n")
    }

    private static func startsBlock(_ line: String) -> Bool {
        let trimmed = trim(line)
        return trimmed.isEmpty
            || fenceStart(trimmed) != nil
            || isDivider(trimmed)
            || heading(trimmed) != nil
            || unorderedListItem(line) != nil
            || orderedListItem(line) != nil
            || quoteLine(line) != nil
    }

    private static func fenceStart(_ trimmed: String) -> (marker: String, language: String?)? {
        guard trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") else { return nil }
        let marker = String(trimmed.prefix(3))
        let language = trim(String(trimmed.dropFirst(3)))
        return (marker: marker, language: language.isEmpty ? nil : language)
    }

    private static func heading(_ trimmed: String) -> (level: Int, text: String)? {
        let level = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(level) else { return nil }

        let remainder = trimmed.dropFirst(level)
        guard remainder.first == " " else { return nil }

        let text = trim(String(remainder))
        return text.isEmpty ? nil : (level: level, text: text)
    }

    private static func unorderedListItem(_ line: String) -> String? {
        let trimmed = trim(line)
        guard let marker = trimmed.first, marker == "-" || marker == "*" || marker == "+" else { return nil }
        let remainder = trimmed.dropFirst()
        guard remainder.first == " " else { return nil }
        let text = trim(String(remainder))
        return text.isEmpty ? nil : text
    }

    private static func orderedListItem(_ line: String) -> (number: String, text: String)? {
        let trimmed = trim(line)
        var number = ""
        var cursor = trimmed.startIndex

        while cursor < trimmed.endIndex, trimmed[cursor].isNumber {
            number.append(trimmed[cursor])
            cursor = trimmed.index(after: cursor)
        }

        guard !number.isEmpty, cursor < trimmed.endIndex else { return nil }
        let delimiter = trimmed[cursor]
        guard delimiter == "." || delimiter == ")" else { return nil }
        cursor = trimmed.index(after: cursor)
        guard cursor < trimmed.endIndex, trimmed[cursor] == " " else { return nil }

        let text = trim(String(trimmed[cursor...]))
        return text.isEmpty ? nil : (number: number, text: text)
    }

    private static func quoteLine(_ line: String) -> String? {
        let trimmed = trim(line)
        guard trimmed.hasPrefix(">") else { return nil }
        return trim(String(trimmed.dropFirst()))
    }

    private static func isDivider(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { !$0.isWhitespace }
        guard compact.count >= 3, let first = compact.first else { return false }
        guard first == "-" || first == "*" || first == "_" else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespaces)
    }
}

private final class MarkdownBlockCache {
    private let storage = NSCache<NSString, MarkdownBlockCacheEntry>()

    init() {
        storage.countLimit = 240
        storage.totalCostLimit = 2 * 1024 * 1024
    }

    func blocks(for raw: String, parse: () -> [MarkdownBlock]) -> [MarkdownBlock] {
        let key = raw as NSString
        if let cached = storage.object(forKey: key) {
            return cached.blocks
        }

        let blocks = parse()
        storage.setObject(
            MarkdownBlockCacheEntry(blocks: blocks),
            forKey: key,
            cost: max(1, raw.utf8.count)
        )
        return blocks
    }
}

private final class MarkdownBlockCacheEntry {
    let blocks: [MarkdownBlock]

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }
}

private final class MarkdownInlineCache {
    static let shared = MarkdownInlineCache()

    private let storage = NSCache<NSString, MarkdownInlineCacheEntry>()

    private init() {
        storage.countLimit = 900
        storage.totalCostLimit = 2 * 1024 * 1024
    }

    func attributedText(for raw: String, isDirectChat: Bool) -> AttributedString? {
        let key = "\(isDirectChat ? "direct" : "group"):\(raw)" as NSString
        if let cached = storage.object(forKey: key) {
            return cached.value
        }

        guard let parsed = try? AttributedString(
            markdown: raw,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
            ),
        ) else {
            return nil
        }

        let highlighted = highlightInlineCode(in: parsed, isDirectChat: isDirectChat)
        storage.setObject(
            MarkdownInlineCacheEntry(value: highlighted),
            forKey: key,
            cost: max(1, raw.utf8.count)
        )
        return highlighted
    }

    private func highlightInlineCode(in source: AttributedString, isDirectChat: Bool) -> AttributedString {
        var attributed = source
        let inlineCodeFont = Font.system(isDirectChat ? .body : .subheadline, design: .monospaced)
        for run in attributed.runs {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            attributed[run.range].font = inlineCodeFont
            attributed[run.range].foregroundColor = .accentColor
            attributed[run.range].backgroundColor = Color.gray.opacity(0.14)
        }
        return attributed
    }
}

private final class MarkdownInlineCacheEntry {
    let value: AttributedString

    init(value: AttributedString) {
        self.value = value
    }
}
