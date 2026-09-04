import Foundation
import SQLite3

struct CachedConversationState {
    var agents: [Agent]
    var groups: [AgentGroup]
    var roles: [Role]
    var taskSessions: [TaskSession]
    var messages: [Envelope]

    var isEmpty: Bool {
        agents.isEmpty && groups.isEmpty && roles.isEmpty && taskSessions.isEmpty && messages.isEmpty
    }
}

final class LocalConversationDatabase: @unchecked Sendable {
    private let db: OpaquePointer
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    static func makeDefault() -> LocalConversationDatabase? {
        do {
            let supportURL = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            let directory = supportURL.appendingPathComponent("OctrixMobile", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("LocalConversations.sqlite")
            return try LocalConversationDatabase(url: url)
        } catch {
            print("[local-conversations] Failed to open database: \(error.localizedDescription)")
            return nil
        }
    }

    init(url: URL) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown sqlite error"
            if let handle { sqlite3_close(handle) }
            throw LocalConversationDatabaseError.sqlite(message)
        }
        db = handle
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA foreign_keys = ON")
        try migrate()
    }

    deinit {
        sqlite3_close(db)
    }

    func restore(serverId: String) -> CachedConversationState {
        do {
            let groups: [AgentGroup] = try fetchPayloads(
                sql: """
                SELECT g.payload_json
                FROM groups g
                INNER JOIN tracked_groups t ON t.server_id = g.server_id AND t.group_id = g.id
                WHERE g.server_id = ?
                ORDER BY g.created_at DESC
                """,
                serverId: serverId
            )
            let taskSessions: [TaskSession] = try fetchPayloads(
                sql: """
                SELECT s.payload_json
                FROM task_sessions s
                INNER JOIN tracked_groups t ON t.server_id = s.server_id AND t.group_id = s.group_id
                WHERE s.server_id = ?
                ORDER BY s.created_at DESC
                """,
                serverId: serverId
            )
            let messages: [Envelope] = try fetchPayloads(
                sql: """
                SELECT m.payload_json
                FROM messages m
                INNER JOIN tracked_groups t ON t.server_id = m.server_id AND t.group_id = m.group_id
                WHERE m.server_id = ?
                ORDER BY m.ts ASC
                """,
                serverId: serverId
            )

            let agentIds = Set(groups.flatMap { $0.members.map(\.agentId) })
            let roleIds = Set(groups.flatMap { $0.members.compactMap(\.roleId) })
            let agents: [Agent] = try fetchPayloads(
                sql: "SELECT payload_json FROM agents WHERE server_id = ?",
                serverId: serverId
            ).filter { agentIds.contains($0.id) }
            let roles: [Role] = try fetchPayloads(
                sql: "SELECT payload_json FROM roles WHERE server_id = ?",
                serverId: serverId
            ).filter { roleIds.contains($0.id) }

            return CachedConversationState(
                agents: agents,
                groups: groups,
                roles: roles,
                taskSessions: taskSessions,
                messages: messages
            )
        } catch {
            print("[local-conversations] Failed to restore \(serverId): \(error.localizedDescription)")
            return CachedConversationState(agents: [], groups: [], roles: [], taskSessions: [], messages: [])
        }
    }

    func trackGroup(
        serverId: String,
        group: AgentGroup,
        agents: [Agent] = [],
        roles: [Role] = [],
        taskSessions: [TaskSession] = [],
        messages: [Envelope] = []
    ) {
        do {
            try withTransaction {
                let now = Date().timeIntervalSince1970
                try trackGroupNoTransaction(serverId: serverId, groupId: group.id, now: now)
                try upsertGroupNoTransaction(serverId: serverId, group: group, now: now)
                for agent in agents {
                    try upsertAgentNoTransaction(serverId: serverId, agent: agent, now: now)
                }
                for role in roles {
                    try upsertRoleNoTransaction(serverId: serverId, role: role, now: now)
                }
                for session in taskSessions where session.groupId == group.id {
                    try upsertTaskSessionNoTransaction(serverId: serverId, session: session, now: now)
                }
                for message in messages where message.groupId == group.id {
                    try upsertMessageNoTransaction(serverId: serverId, message: message, now: now)
                }
            }
        } catch {
            print("[local-conversations] Failed to track group \(group.id): \(error.localizedDescription)")
        }
    }

    func mergeState(serverId: String, state: AppState) {
        do {
            try withTransaction {
                let trackedIds = try trackedGroupIdsNoTransaction(serverId: serverId)
                guard !trackedIds.isEmpty else { return }

                let groups = state.groups.filter { trackedIds.contains($0.id) }
                guard !groups.isEmpty else { return }

                let now = Date().timeIntervalSince1970
                let groupIds = Set(groups.map(\.id))
                let agentIds = Set(groups.flatMap { $0.members.map(\.agentId) })
                let roleIds = Set(groups.flatMap { $0.members.compactMap(\.roleId) })

                for group in groups {
                    try upsertGroupNoTransaction(serverId: serverId, group: group, now: now)
                }
                for agent in state.agents where agentIds.contains(agent.id) {
                    try upsertAgentNoTransaction(serverId: serverId, agent: agent, now: now)
                }
                for role in state.roles where roleIds.contains(role.id) {
                    try upsertRoleNoTransaction(serverId: serverId, role: role, now: now)
                }
                for session in state.taskSessions where groupIds.contains(session.groupId) {
                    try upsertTaskSessionNoTransaction(serverId: serverId, session: session, now: now)
                }
                for message in state.messages {
                    guard let groupId = message.groupId, groupIds.contains(groupId) else { continue }
                    try upsertMessageNoTransaction(serverId: serverId, message: message, now: now)
                }
            }
        } catch {
            print("[local-conversations] Failed to merge state for \(serverId): \(error.localizedDescription)")
        }
    }

    func upsertMessage(serverId: String, message: Envelope) {
        guard let groupId = message.groupId else { return }
        do {
            try withTransaction {
                guard try isTrackedNoTransaction(serverId: serverId, groupId: groupId) else { return }
                try upsertMessageNoTransaction(
                    serverId: serverId,
                    message: message,
                    now: Date().timeIntervalSince1970
                )
            }
        } catch {
            print("[local-conversations] Failed to upsert message \(message.id): \(error.localizedDescription)")
        }
    }

    func updateMessage(serverId: String, update: MessageUpdate) {
        do {
            try withTransaction {
                guard var message = try messageNoTransaction(serverId: serverId, id: update.id) else { return }
                if let body = update.body { message.body = body }
                if let entries = update.entries { message.entries = entries }
                if let status = update.status { message.status = status }
                try upsertMessageNoTransaction(
                    serverId: serverId,
                    message: message,
                    now: Date().timeIntervalSince1970
                )
            }
        } catch {
            print("[local-conversations] Failed to update message \(update.id): \(error.localizedDescription)")
        }
    }

    func upsertGroup(serverId: String, group: AgentGroup) {
        do {
            try withTransaction {
                guard try isTrackedNoTransaction(serverId: serverId, groupId: group.id) else { return }
                try upsertGroupNoTransaction(
                    serverId: serverId,
                    group: group,
                    now: Date().timeIntervalSince1970
                )
            }
        } catch {
            print("[local-conversations] Failed to upsert group \(group.id): \(error.localizedDescription)")
        }
    }

    func upsertTaskSession(serverId: String, session: TaskSession) {
        do {
            try withTransaction {
                guard try isTrackedNoTransaction(serverId: serverId, groupId: session.groupId) else { return }
                try upsertTaskSessionNoTransaction(
                    serverId: serverId,
                    session: session,
                    now: Date().timeIntervalSince1970
                )
            }
        } catch {
            print("[local-conversations] Failed to upsert task session \(session.id): \(error.localizedDescription)")
        }
    }

    func removeGroup(serverId: String, groupId: String) {
        do {
            try withTransaction {
                try execute("DELETE FROM messages WHERE server_id = ? AND group_id = ?", [serverId, groupId])
                try execute("DELETE FROM task_sessions WHERE server_id = ? AND group_id = ?", [serverId, groupId])
                try execute("DELETE FROM groups WHERE server_id = ? AND id = ?", [serverId, groupId])
                try execute("DELETE FROM tracked_groups WHERE server_id = ? AND group_id = ?", [serverId, groupId])
            }
        } catch {
            print("[local-conversations] Failed to remove group \(groupId): \(error.localizedDescription)")
        }
    }

    func removeServer(serverId: String) {
        do {
            try withTransaction {
                for table in ["messages", "task_sessions", "groups", "agents", "roles", "tracked_groups"] {
                    try execute("DELETE FROM \(table) WHERE server_id = ?", [serverId])
                }
            }
        } catch {
            print("[local-conversations] Failed to remove server \(serverId): \(error.localizedDescription)")
        }
    }

    func removeAll() {
        do {
            try withTransaction {
                for table in ["messages", "task_sessions", "groups", "agents", "roles", "tracked_groups"] {
                    try execute("DELETE FROM \(table)")
                }
            }
        } catch {
            print("[local-conversations] Failed to remove all data: \(error.localizedDescription)")
        }
    }

    private func migrate() throws {
        try execute("""
        CREATE TABLE IF NOT EXISTS tracked_groups (
          server_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          created_from_ios_at REAL NOT NULL,
          PRIMARY KEY (server_id, group_id)
        )
        """)
        try execute("""
        CREATE TABLE IF NOT EXISTS groups (
          server_id TEXT NOT NULL,
          id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at REAL NOT NULL,
          archived_at REAL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY (server_id, id)
        )
        """)
        try execute("""
        CREATE TABLE IF NOT EXISTS task_sessions (
          server_id TEXT NOT NULL,
          id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at REAL NOT NULL,
          archived_at REAL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY (server_id, id)
        )
        """)
        try execute("""
        CREATE TABLE IF NOT EXISTS messages (
          server_id TEXT NOT NULL,
          id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          task_session_id TEXT,
          from_peer TEXT NOT NULL,
          to_peer TEXT NOT NULL,
          body TEXT NOT NULL,
          ts REAL NOT NULL,
          status TEXT,
          entries_json TEXT,
          payload_json TEXT NOT NULL,
          updated_at_local REAL NOT NULL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY (server_id, id)
        )
        """)
        try execute("""
        CREATE TABLE IF NOT EXISTS agents (
          server_id TEXT NOT NULL,
          id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY (server_id, id)
        )
        """)
        try execute("""
        CREATE TABLE IF NOT EXISTS roles (
          server_id TEXT NOT NULL,
          id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY (server_id, id)
        )
        """)
        try execute("CREATE INDEX IF NOT EXISTS idx_groups_server ON groups(server_id, created_at)")
        try execute("CREATE INDEX IF NOT EXISTS idx_sessions_route ON task_sessions(server_id, group_id, created_at)")
        try execute("CREATE INDEX IF NOT EXISTS idx_messages_route ON messages(server_id, group_id, task_session_id, ts)")
        try execute("CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(server_id, group_id)")
    }

    private func trackGroupNoTransaction(serverId: String, groupId: String, now: Double) throws {
        try execute(
            """
            INSERT OR IGNORE INTO tracked_groups (server_id, group_id, created_from_ios_at)
            VALUES (?, ?, ?)
            """,
            [serverId, groupId, now]
        )
    }

    private func upsertGroupNoTransaction(serverId: String, group: AgentGroup, now: Double) throws {
        try execute(
            """
            INSERT INTO groups (server_id, id, payload_json, created_at, archived_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, id) DO UPDATE SET
              payload_json = excluded.payload_json,
              created_at = excluded.created_at,
              archived_at = excluded.archived_at,
              last_seen_at = excluded.last_seen_at
            """,
            [serverId, group.id, try encode(group), group.createdAt, group.archivedAt, now]
        )
    }

    private func upsertTaskSessionNoTransaction(serverId: String, session: TaskSession, now: Double) throws {
        try execute(
            """
            INSERT INTO task_sessions (server_id, id, group_id, payload_json, created_at, archived_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, id) DO UPDATE SET
              group_id = excluded.group_id,
              payload_json = excluded.payload_json,
              created_at = excluded.created_at,
              archived_at = excluded.archived_at,
              last_seen_at = excluded.last_seen_at
            """,
            [serverId, session.id, session.groupId, try encode(session), session.createdAt, session.archivedAt, now]
        )
    }

    private func upsertAgentNoTransaction(serverId: String, agent: Agent, now: Double) throws {
        try execute(
            """
            INSERT INTO agents (server_id, id, payload_json, last_seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(server_id, id) DO UPDATE SET
              payload_json = excluded.payload_json,
              last_seen_at = excluded.last_seen_at
            """,
            [serverId, agent.id, try encode(agent), now]
        )
    }

    private func upsertRoleNoTransaction(serverId: String, role: Role, now: Double) throws {
        try execute(
            """
            INSERT INTO roles (server_id, id, payload_json, last_seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(server_id, id) DO UPDATE SET
              payload_json = excluded.payload_json,
              last_seen_at = excluded.last_seen_at
            """,
            [serverId, role.id, try encode(role), now]
        )
    }

    private func upsertMessageNoTransaction(serverId: String, message: Envelope, now: Double) throws {
        guard let groupId = message.groupId else { return }
        let entriesJSON = try message.entries.map { try encode($0) }
        try execute(
            """
            INSERT INTO messages (
              server_id, id, group_id, task_session_id, from_peer, to_peer, body,
              ts, status, entries_json, payload_json, updated_at_local, last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, id) DO UPDATE SET
              group_id = excluded.group_id,
              task_session_id = excluded.task_session_id,
              from_peer = excluded.from_peer,
              to_peer = excluded.to_peer,
              body = excluded.body,
              ts = excluded.ts,
              status = excluded.status,
              entries_json = excluded.entries_json,
              payload_json = excluded.payload_json,
              updated_at_local = excluded.updated_at_local,
              last_seen_at = excluded.last_seen_at
            """,
            [
                serverId,
                message.id,
                groupId,
                message.taskSessionId,
                message.from,
                message.to,
                message.body,
                message.ts,
                message.status,
                entriesJSON,
                try encode(message),
                now,
                now,
            ]
        )
    }

    private func messageNoTransaction(serverId: String, id: String) throws -> Envelope? {
        let statement = try prepare("SELECT payload_json FROM messages WHERE server_id = ? AND id = ? LIMIT 1")
        defer { sqlite3_finalize(statement) }
        try bind(serverId, at: 1, in: statement)
        try bind(id, at: 2, in: statement)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        guard let json = columnString(statement, 0) else { return nil }
        return try decoder.decode(Envelope.self, from: Data(json.utf8))
    }

    private func trackedGroupIdsNoTransaction(serverId: String) throws -> Set<String> {
        let statement = try prepare("SELECT group_id FROM tracked_groups WHERE server_id = ?")
        defer { sqlite3_finalize(statement) }
        try bind(serverId, at: 1, in: statement)
        var ids = Set<String>()
        while sqlite3_step(statement) == SQLITE_ROW {
            if let id = columnString(statement, 0) {
                ids.insert(id)
            }
        }
        return ids
    }

    private func isTrackedNoTransaction(serverId: String, groupId: String) throws -> Bool {
        let statement = try prepare(
            "SELECT 1 FROM tracked_groups WHERE server_id = ? AND group_id = ? LIMIT 1"
        )
        defer { sqlite3_finalize(statement) }
        try bind(serverId, at: 1, in: statement)
        try bind(groupId, at: 2, in: statement)
        return sqlite3_step(statement) == SQLITE_ROW
    }

    private func fetchPayloads<T: Decodable>(sql: String, serverId: String) throws -> [T] {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        try bind(serverId, at: 1, in: statement)
        var rows: [T] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let json = columnString(statement, 0),
                  let data = json.data(using: .utf8),
                  let value = try? decoder.decode(T.self, from: data) else { continue }
            rows.append(value)
        }
        return rows
    }

    private func encode<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw LocalConversationDatabaseError.encodingFailed
        }
        return text
    }

    private func withTransaction(_ work: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE TRANSACTION")
        do {
            try work()
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func execute(_ sql: String, _ values: [Any?] = []) throws {
        if values.isEmpty {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
                throw LocalConversationDatabaseError.sqlite(String(cString: sqlite3_errmsg(db)))
            }
            return
        }

        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            try bind(value, at: Int32(index + 1), in: statement)
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw LocalConversationDatabaseError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw LocalConversationDatabaseError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        return statement
    }

    private func bind(_ value: Any?, at index: Int32, in statement: OpaquePointer) throws {
        let result: Int32
        switch value {
        case nil:
            result = sqlite3_bind_null(statement, index)
        case let text as String:
            result = sqlite3_bind_text(statement, index, text, -1, Self.transient)
        case let number as Double:
            result = sqlite3_bind_double(statement, index, number)
        default:
            throw LocalConversationDatabaseError.unsupportedBindValue
        }
        guard result == SQLITE_OK else {
            throw LocalConversationDatabaseError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func columnString(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }
}

private enum LocalConversationDatabaseError: LocalizedError {
    case sqlite(String)
    case encodingFailed
    case unsupportedBindValue

    var errorDescription: String? {
        switch self {
        case .sqlite(let message):
            return message
        case .encodingFailed:
            return "Failed to encode local conversation payload"
        case .unsupportedBindValue:
            return "Unsupported sqlite bind value"
        }
    }
}
