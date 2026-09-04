import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ConversationEntry } from './models.js';

export interface StoredMessage {
  id: string;
  groupId: string;
  taskSessionId?: string;
  fromPeer: string;
  toPeer: string;
  body: string;
  status: 'streaming' | 'complete';
  createdAt: number;
  updatedAt: number;
  entries?: ConversationEntry[];
}

interface MessageStoreData {
  version: 1;
  messages: StoredMessage[];
}

export class MessageStore {
  private readonly storagePath: string;
  private messages: StoredMessage[] = [];

  constructor(directory?: string) {
    const dir = directory ?? path.join(os.homedir(), '.cli-bridge');
    fs.mkdirSync(dir, { recursive: true });
    this.storagePath = path.join(dir, 'messages.json');
    this.load(path.join(dir, 'messages.db'));
  }

  insert(msg: StoredMessage): void {
    this.messages = this.messages.filter(existing => existing.id !== msg.id);
    this.messages.push({ ...msg });
    this.sortAndSave();
  }

  updateBody(id: string, body: string, status?: 'streaming' | 'complete', entries?: ConversationEntry[]): void {
    const now = Date.now() / 1000;
    const msg = this.messages.find(existing => existing.id === id);
    if (!msg) return;
    msg.body = body;
    msg.updatedAt = now;
    if (status) msg.status = status;
    if (entries !== undefined) msg.entries = entries;
    this.sortAndSave();
  }

  findById(id: string): StoredMessage | undefined {
    const msg = this.messages.find(existing => existing.id === id);
    return msg ? { ...msg } : undefined;
  }

  findByGroup(groupId: string): StoredMessage[] {
    return this.messages
      .filter(msg => msg.groupId === groupId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(msg => ({ ...msg }));
  }

  findByGroupAndTaskSession(groupId: string, taskSessionId: string): StoredMessage[] {
    return this.messages
      .filter(msg => msg.groupId === groupId && msg.taskSessionId === taskSessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(msg => ({ ...msg }));
  }

  assignMissingTaskSessionIds(
    resolveTaskSessionId: (groupId: string) => string | undefined,
  ): boolean {
    let changed = false;
    for (const msg of this.messages) {
      if (msg.taskSessionId || !msg.groupId) continue;
      const taskSessionId = resolveTaskSessionId(msg.groupId);
      if (!taskSessionId) continue;
      msg.taskSessionId = taskSessionId;
      changed = true;
    }
    if (changed) this.sortAndSave();
    return changed;
  }

  allMessages(): StoredMessage[] {
    return this.messages
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(msg => ({ ...msg }));
  }

  deleteGroups(groupIds: string[]): void {
    if (groupIds.length === 0) return;
    const removed = new Set(groupIds);
    const remaining = this.messages.filter(message => !removed.has(message.groupId));
    if (remaining.length === this.messages.length) return;
    this.messages = remaining;
    this.sortAndSave();
  }

  clear(): void {
    if (this.messages.length === 0) return;
    this.messages = [];
    this.sortAndSave();
  }

  toEnvelopes(): Array<{ id: string; from: string; to: string; body: string; ts: number; groupId: string; taskSessionId?: string; status: StoredMessage['status']; entries?: ConversationEntry[] }> {
    const rows = this.allMessages();
    return rows.map(r => {
      let entries: ConversationEntry[] | undefined;
      if (Array.isArray((r as any).entries)) {
        entries = (r as any).entries;
      } else if ((r as any).entries) {
        try {
          entries = JSON.parse((r as any).entries);
        } catch { /* ignore */ }
      }
      return {
        id: r.id,
        from: r.fromPeer,
        to: r.toPeer,
        body: r.body,
        ts: r.createdAt,
        groupId: r.groupId,
        taskSessionId: r.taskSessionId,
        status: r.status,
        entries,
      };
    });
  }

  close(): void {
    // No-op for file-backed storage.
  }

  private load(legacyDbPath: string) {
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(raw) as Partial<MessageStoreData>;
        this.messages = Array.isArray(data.messages) ? data.messages : [];
      } catch {
        this.messages = [];
      }
      this.sortMessages();
      this.normalizeLoadedMessageTimestamps();
      this.repairLoadedConversationEntryBoundaries();
      this.completeLoadedStreamingMessages();
      return;
    }

    if (this.tryMigrateLegacySqlite(legacyDbPath)) {
      this.normalizeLoadedMessageTimestamps();
      this.repairLoadedConversationEntryBoundaries();
      this.completeLoadedStreamingMessages();
      this.sortAndSave();
    }
  }

  private normalizeLoadedMessageTimestamps() {
    let changed = false;
    for (const msg of this.messages) {
      const createdAt = this.timestampSeconds(msg.createdAt, msg.createdAt);
      const updatedAt = this.timestampSeconds(msg.updatedAt, msg.updatedAt);
      if (createdAt !== msg.createdAt) {
        msg.createdAt = createdAt;
        changed = true;
      }
      if (updatedAt !== msg.updatedAt) {
        msg.updatedAt = updatedAt;
        changed = true;
      }
    }
    if (changed) this.sortAndSave();
  }

  private repairLoadedConversationEntryBoundaries() {
    const existingIds = new Set(this.messages.map(msg => msg.id));
    const repairedMessages: StoredMessage[] = [];
    let changed = false;

    for (const msg of this.messages) {
      const entries = this.coerceEntries(msg.entries);
      if (!entries || !entries.some(entry => entry.role === 'user')) {
        repairedMessages.push(msg);
        continue;
      }

      const segments = this.splitAgentEntrySegments(entries);
      if (segments.length === 0) {
        repairedMessages.push({ ...msg, entries: undefined });
        changed = true;
        continue;
      }

      changed = true;
      segments.forEach((segment, index) => {
        const firstTs = this.timestampSeconds(segment[0]?.timestamp, msg.createdAt);
        const lastTs = this.timestampSeconds(segment[segment.length - 1]?.timestamp, msg.updatedAt);
        repairedMessages.push({
          ...msg,
          id: index === 0 ? msg.id : this.nextSplitMessageId(msg.id, index, existingIds),
          body: this.bodyFromEntries(segment),
          status: 'complete',
          createdAt: firstTs,
          updatedAt: lastTs,
          entries: segment,
        });
      });
    }

    if (changed) {
      this.messages = repairedMessages;
      this.sortAndSave();
    }
  }

  private coerceEntries(entries: unknown): ConversationEntry[] | undefined {
    if (!entries) return undefined;
    if (Array.isArray(entries)) return entries;
    if (typeof entries === 'string') {
      try {
        const parsed = JSON.parse(entries) as unknown;
        return Array.isArray(parsed) ? parsed as ConversationEntry[] : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private splitAgentEntrySegments(entries: ConversationEntry[]): ConversationEntry[][] {
    const segments: ConversationEntry[][] = [];
    let segment: ConversationEntry[] = [];
    const flush = () => {
      const nonEmpty = segment.filter(entry => entry.content.trim().length > 0);
      if (nonEmpty.length > 0) segments.push(nonEmpty);
      segment = [];
    };

    for (const entry of entries) {
      if (entry.role === 'user') {
        flush();
      } else {
        segment.push(entry);
      }
    }
    flush();
    return segments;
  }

  private bodyFromEntries(entries: ConversationEntry[]): string {
    const assistantEntries = entries.filter(entry => entry.role === 'assistant');
    const finalAnswerEntries = assistantEntries.filter(entry => entry.phase === 'final_answer');
    return (finalAnswerEntries.length > 0 ? finalAnswerEntries : assistantEntries)
      .map(entry => entry.content)
      .join('\n');
  }

  private nextSplitMessageId(baseId: string, index: number, existingIds: Set<string>): string {
    let candidate = `${baseId}-split-${index}`;
    while (existingIds.has(candidate)) {
      candidate = `${baseId}-split-${index}-${randomUUID()}`;
    }
    existingIds.add(candidate);
    return candidate;
  }

  private timestampSeconds(value: unknown, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return numeric > 100_000_000_000 ? numeric / 1000 : numeric;
  }

  private completeLoadedStreamingMessages() {
    let changed = false;
    for (const msg of this.messages) {
      if (msg.status !== 'streaming') continue;
      msg.status = 'complete';
      changed = true;
    }
    if (changed) this.save();
  }

  private tryMigrateLegacySqlite(legacyDbPath: string): boolean {
    if (!fs.existsSync(legacyDbPath)) return false;

    const result = spawnSync(
      'sqlite3',
      [
        '-json',
        legacyDbPath,
        'SELECT id, groupId, fromPeer, toPeer, body, status, createdAt, updatedAt, entries FROM messages ORDER BY createdAt ASC;',
      ],
      { encoding: 'utf-8' },
    );

    if (result.status !== 0 || !result.stdout.trim()) {
      console.warn('[message-store] Failed to migrate legacy messages.db:', result.stderr.trim());
      return false;
    }

    try {
      const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      this.messages = rows.map((row) => {
        let entries: ConversationEntry[] | undefined;
        if (typeof row.entries === 'string' && row.entries.length > 0) {
          try {
            entries = JSON.parse(row.entries);
          } catch {
            entries = undefined;
          }
        }

        return {
          id: String(row.id ?? ''),
          groupId: String(row.groupId ?? ''),
          taskSessionId: typeof row.taskSessionId === 'string' ? row.taskSessionId : undefined,
          fromPeer: String(row.fromPeer ?? ''),
          toPeer: String(row.toPeer ?? ''),
          body: String(row.body ?? ''),
          status: (row.status === 'streaming' ? 'streaming' : 'complete') as StoredMessage['status'],
          createdAt: Number(row.createdAt ?? 0),
          updatedAt: Number(row.updatedAt ?? 0),
          ...(entries ? { entries } : {}),
        };
      }).filter(msg => msg.id);
      console.log('[message-store] Migrated legacy messages from', legacyDbPath);
      return true;
    } catch {
      console.warn('[message-store] Failed to parse migrated legacy messages');
      return false;
    }
  }

  private sortAndSave() {
    this.sortMessages();
    this.save();
  }

  private sortMessages() {
    this.messages.sort((a, b) => a.createdAt - b.createdAt);
  }

  private save() {
    const payload: MessageStoreData = {
      version: 1,
      messages: this.messages,
    };
    const tempPath = `${this.storagePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.storagePath);
  }
}
