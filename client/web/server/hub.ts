import type { WebSocket } from 'ws';
import {
  type Envelope, type EmitRequest,
  type ConversationEntry, type ServerEventEnvelope,
  conversationEntryKey, createEnvelope, groupMemberIds,
} from './models.js';
import { isStreamingConversationEntry } from './conversation-watcher.js';
import type { Store } from './store.js';
import type { ProcessManager } from './process-manager.js';
import type { WorkflowEngine } from './workflow-engine.js';
import type { MessageStore } from './message-store.js';
import { parseCollaborationControlBlocks } from './collaboration-protocol.js';

function mergeConversationEntries(
  existing: ConversationEntry[] | undefined,
  incoming: ConversationEntry[],
): ConversationEntry[] {
  const merged = existing ? [...existing] : [];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    indexById.set(conversationEntryKey(entry), index);
  }

  for (const entry of incoming) {
    const key = conversationEntryKey(entry);
    const index = indexById.get(key);
    if (index === undefined) {
      indexById.set(key, merged.length);
      merged.push(entry);
    } else {
      const previous = merged[index];
      const previousHumanInput = previous.humanInput;
      const incomingHumanInput = entry.humanInput;
      merged[index] = {
        ...previous,
        ...entry,
        humanInput: incomingHumanInput
          ? {
              ...previousHumanInput,
              ...incomingHumanInput,
              questions: incomingHumanInput.questions.length > 0
                ? incomingHumanInput.questions
                : previousHumanInput?.questions ?? [],
            }
          : previousHumanInput,
      };
    }
  }

  return merged;
}

const EVENT_LOG_LIMIT = 5000;

const ENTRY_PREVIEW_MAX_CHARS = 320;

function compactEntryPreview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length > ENTRY_PREVIEW_MAX_CHARS
    ? `${text.slice(0, ENTRY_PREVIEW_MAX_CHARS)}…`
    : text;
}

function previewEntry(entry: ConversationEntry): string | null {
  const content = compactEntryPreview(entry.content);
  switch (entry.role) {
    case 'assistant':
      return entry.content.trim();
    case 'thinking':
      return content ? `思考：${content}` : '思考中…';
    case 'tool':
      return `工具${entry.toolName ? ` ${entry.toolName}` : ''}：${content || '正在执行'}`;
    case 'system':
      return content ? `系统：${content}` : null;
    case 'user':
      return null;
  }
}

export function bodyFromConversationEntries(entries: ConversationEntry[]): string {
  const assistantEntries = entries.filter(e => e.role === 'assistant');
  const completedAssistantEntries = assistantEntries.filter(e => !isStreamingConversationEntry(e));
  const finalAnswerEntries = completedAssistantEntries.filter(e => e.phase === 'final_answer');
  const visibleAssistantEntries = finalAnswerEntries.length > 0
    ? finalAnswerEntries
    : completedAssistantEntries.length > 0
      ? completedAssistantEntries
      : assistantEntries;
  const assistantBody = visibleAssistantEntries
    .map(e => e.content.trim())
    .filter(Boolean)
    .join('\n');
  if (assistantBody) return assistantBody;

  return entries
    .map(previewEntry)
    .filter((preview): preview is string => Boolean(preview))
    .slice(-3)
    .join('\n');
}

export class Hub {
  messages: Envelope[] = [];
  knownPeers: string[] = [];
  readonly port: number;
  isRunning = false;

  store: Store;
  messageStore?: MessageStore;
  workflowEngine?: WorkflowEngine;
  processManager?: ProcessManager;

  private wsClients = new Set<WebSocket>();
  private eventSeq = 0;
  private eventLog: ServerEventEnvelope[] = [];

  constructor(store: Store, port: number, messageStore?: MessageStore) {
    this.store = store;
    this.port = port;
    this.messageStore = messageStore;
    if (messageStore) {
      this.messages = messageStore.toEnvelopes();
    }
  }

  // MARK: - WebSocket broadcast

  addWsClient(ws: WebSocket) {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
  }

  broadcast(event: string, data: unknown) {
    const envelope = this.recordEvent(event, data);
    const msg = JSON.stringify(envelope);
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  eventSnapshot(event: string, data: unknown): { event: string; data: unknown; serverTime: number } {
    return { event, data, serverTime: Date.now() / 1000 };
  }

  eventsSince(since: number, limit = 500): { events: ServerEventEnvelope[]; latestSeq: number; resetRequired: boolean } {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const normalizedSince = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0;
    const firstSeq = this.eventLog[0]?.seq ?? this.eventSeq + 1;
    const resetRequired = normalizedSince > this.eventSeq
      || (normalizedSince > 0 && this.eventLog.length > 0 && normalizedSince < firstSeq - 1);
    const events = this.eventLog
      .filter(envelope => envelope.seq > normalizedSince)
      .slice(0, boundedLimit);
    return { events, latestSeq: this.eventSeq, resetRequired };
  }

  latestSeq(): number {
    return this.eventSeq;
  }

  deleteGroupMessages(groupId: string) {
    this.messages = this.messages.filter(message => message.groupId !== groupId);
    this.messageStore?.deleteGroups([groupId]);
  }

  addSystemNotice(groupId: string, taskSessionId: string | undefined, body: string) {
    this.appendInternal(createEnvelope('system', 'user', body, groupId, taskSessionId));
  }

  // MARK: - Core messaging

  emit(req: EmitRequest): Envelope[] {
    const taskSessionId = this.resolveWritableTaskSessionId(req.groupId, req.taskSessionId);
    let envelopes: Envelope[];
    if (req.groupId && (!req.to || req.to === '')) {
      envelopes = this.broadcastToGroup(req.from, req.body, req.groupId, taskSessionId);
    } else {
      const envelope = createEnvelope(req.from, req.to ?? '', req.body, req.groupId, taskSessionId);
      this.appendInternal(envelope);
      envelopes = [envelope];
    }

    for (const envelope of envelopes) {
      this.processWorkflow(envelope);
    }

    if (req.to && req.to !== '' && req.to !== 'user' && req.to !== 'system'
        && req.from !== 'user' && req.from !== 'system') {
      this.pushToAgent(req.to, req.body, req.from, req.groupId ?? '', taskSessionId);
    }

    return envelopes;
  }

  inbox(peer: string, after?: number): Envelope[] {
    const threshold = after ?? 0;
    return this.messages.filter(m => m.to === peer && m.ts > threshold);
  }

  allPeers(): string[] {
    return [...this.knownPeers];
  }

  clearMessages() {
    this.messages = [];
  }

  messagesForGroup(groupId: string, taskSessionId?: string): Envelope[] {
    return this.messages.filter(m => (
      m.groupId === groupId
      && (taskSessionId === undefined || m.taskSessionId === taskSessionId)
    ));
  }

  sendUserMessage(body: string, groupId: string, taskSessionId?: string, to = '', clientMsgId?: string) {
    const resolvedTaskSessionId = this.resolveWritableTaskSessionId(groupId, taskSessionId);
    const envelope = createEnvelope('user', to, body, groupId, resolvedTaskSessionId, clientMsgId);
    this.appendInternal(envelope);
    this.processWorkflow(envelope);
  }

  appendOrUpdateAgentMessage(
    id: string | undefined, from: string, body: string, groupId: string, taskSessionId?: string,
  ): string {
    if (id) {
      const idx = this.messages.findIndex(m => m.id === id);
      if (idx >= 0) {
        if (body.length >= this.messages[idx].body.length) {
          this.messages[idx].body = body;
          this.messages[idx].status = 'streaming';
          this.messageStore?.updateBody(id, body, 'streaming');
          this.broadcast('messages:update', { id, body, status: 'streaming' });
        }
        return id;
      }
    }
    const envelope = createEnvelope(from, 'user', body, groupId, taskSessionId);
    envelope.status = 'streaming';
    this.appendInternal(envelope);
    return envelope.id;
  }

  appendOrUpdateAgentEntries(
    id: string | undefined,
    from: string,
    entries: ConversationEntry[],
    groupId: string,
    taskSessionId?: string,
    status: Envelope['status'] = 'streaming',
  ): string {
    if (id) {
      const idx = this.messages.findIndex(m => m.id === id);
      if (idx >= 0) {
        const mergedEntries = mergeConversationEntries(this.messages[idx].entries, entries);
        const body = bodyFromConversationEntries(mergedEntries);
        this.messages[idx].body = body;
        this.messages[idx].entries = mergedEntries;
        this.messages[idx].status = status;
        this.messageStore?.updateBody(id, body, status, mergedEntries);
        this.broadcast('messages:update', {
          id,
          body,
          entries: mergedEntries,
          status,
        });
        return id;
      }
    }

    const body = bodyFromConversationEntries(entries);
    const envelope = createEnvelope(from, 'user', body, groupId, taskSessionId);
    envelope.entries = entries;
    envelope.status = status;
    this.appendInternal(envelope, entries);
    return envelope.id;
  }

  // MARK: - Collaboration protocol routing

  routeCollaborationControlBlocks(
    senderName: string,
    content: string,
    groupId: string,
    taskSessionId?: string,
  ) {
    const group = this.store.groupById(groupId);
    const sender = this.store.agentByName(senderName);
    if (!group || !sender || group.groupType === 'direct') return;
    const senderMember = group.members.find(member => member.agentId === sender.id);

    const parsed = parseCollaborationControlBlocks(content);
    for (const error of parsed.errors) {
      const body = `⚠️ 协作协议错误（控制块 ${error.blockIndex + 1}）：${error.message}`;
      this.appendInternal(createEnvelope('system', senderName, body, groupId, taskSessionId));
      this.sendFeedbackToSender(senderName, body, groupId, taskSessionId);
    }
    if (parsed.errors.length > 0 && taskSessionId && senderMember) {
      const detail = parsed.errors.map(error => error.message).join('；');
      const consecutive = this.store.recordProtocolFailure(
        group.id,
        taskSessionId,
        senderMember.id,
        detail,
      );
      if (consecutive > 0) {
        const body = consecutive >= 3
          ? '⛔ 连续 3 次协作协议失败，任务已进入 protocol_error，等待群主修正并恢复。'
          : `🔁 协作协议失败 ${consecutive}/3：请按 .ai-team/dispatch.md 模板修正后重试。`;
        this.appendInternal(createEnvelope('system', senderName, body, groupId, taskSessionId));
        this.sendFeedbackToSender(senderName, body, groupId, taskSessionId);
      }
    }

    for (const action of parsed.actions) {
      if (taskSessionId && action.missionId !== taskSessionId) {
        const body = '⚠️ 协作请求引用的主任务不是当前终端任务';
        this.appendInternal(createEnvelope('system', senderName, body, groupId, taskSessionId));
        this.sendFeedbackToSender(senderName, body, groupId, taskSessionId);
        continue;
      }
      try {
        const result = this.store.applyCollaborationAction(group.id, sender.id, action);
        if (senderMember) this.store.clearProtocolFailures(group.id, result.mission.id, senderMember.id);
        const status = result.duplicate ? '重复请求已忽略' : '已执行';
        this.appendInternal(createEnvelope(
          'system',
          senderName,
          `📋 [${status}] ${action.action} · ${result.workItem.title}`,
          groupId,
          taskSessionId,
        ));
        for (const offeredWorkItem of [
          ...(result.createdWorkItem ? [result.createdWorkItem] : []),
          ...(result.createdWorkItems ?? []),
        ]) {
          if (offeredWorkItem.status !== 'offered') continue;
          const targetMember = group.members.find(member => member.id === offeredWorkItem.ownerMemberId);
          if (targetMember && this.processManager?.isAgentRunning(targetMember.agentId, group.id)) {
            const hasVersionedHandoff = offeredWorkItem.id === result.createdWorkItem?.id
              && Boolean(action.artifact);
            const inboxFile = hasVersionedHandoff ? `${action.requestId}.md` : 'offer-001.md';
            const inbox = `.ai-team/tasks/${result.mission.id}/work-items/${offeredWorkItem.id}/inbox/${inboxFile}`;
            this.processManager.sendKeys(
              targetMember.agentId,
              `[正式交接]\n请读取 ${inbox} 并使用 octrix-action 控制块回执。`,
              group.id,
              result.mission.id,
            );
          }
        }
      } catch (error) {
        const body = `⚠️ 协作请求被拒绝：${error instanceof Error ? error.message : String(error)}`;
        this.appendInternal(createEnvelope('system', senderName, body, groupId, taskSessionId));
        this.sendFeedbackToSender(senderName, body, groupId, taskSessionId);
      }
    }
  }

  // MARK: - Private helpers

  private sendFeedbackToSender(senderName: string, body: string, groupId: string, taskSessionId?: string) {
    const pm = this.processManager;
    if (!pm) return;
    const senderAgent = this.store.agentByName(senderName);
    if (!senderAgent || !pm.isAgentRunning(senderAgent.id, groupId)) return;
    pm.sendKeys(senderAgent.id, `[系统反馈]\n${body}`, groupId, taskSessionId);
  }

  private pushToAgent(name: string, body: string, from: string, groupId: string, taskSessionId?: string) {
    const pm = this.processManager;
    if (!pm) return;
    const agent = this.store.agentByName(name);
    if (!agent || !pm.isAgentRunning(agent.id, groupId)) return;
    pm.sendKeys(agent.id, `[来自 ${from} 的消息]\n${body}`, groupId, taskSessionId);
  }

  private processWorkflow(envelope: Envelope) {
    if (!this.workflowEngine || envelope.from === 'system') return;
    const responses = this.workflowEngine.process(envelope);
    for (const req of responses) {
      this.emit(req);
    }
  }

  private recordEvent(event: string, data: unknown): ServerEventEnvelope {
    const envelope: ServerEventEnvelope = {
      event,
      data,
      seq: ++this.eventSeq,
      serverTime: Date.now() / 1000,
    };
    this.eventLog.push(envelope);
    if (this.eventLog.length > EVENT_LOG_LIMIT) {
      this.eventLog.splice(0, this.eventLog.length - EVENT_LOG_LIMIT);
    }
    return envelope;
  }

  private broadcastToGroup(from: string, body: string, groupId: string, taskSessionId?: string): Envelope[] {
    const group = this.store.groupById(groupId);
    if (!group) return [];
    const memberNames = groupMemberIds(group)
      .map(id => this.store.agentById(id)?.name)
      .filter((n): n is string => !!n);
    const envelopes: Envelope[] = [];
    for (const name of memberNames) {
      if (name === from) continue;
      const envelope = createEnvelope(from, name, body, groupId, taskSessionId);
      this.appendInternal(envelope);
      envelopes.push(envelope);
    }
    return envelopes;
  }

  private resolveWritableTaskSessionId(groupId?: string, requestedTaskSessionId?: string): string | undefined {
    if (!groupId) return requestedTaskSessionId;
    const group = this.store.groupById(groupId);
    if (group?.archivedAt) {
      throw new Error('会话已归档，请恢复后继续对话');
    }
    const activeTaskSessionId = this.store.activeTaskSessionForGroup(groupId)?.id;
    if (!activeTaskSessionId) return requestedTaskSessionId;
    if (!requestedTaskSessionId) return activeTaskSessionId;
    if (requestedTaskSessionId !== activeTaskSessionId) {
      throw new Error('当前任务已归档，请创建新任务后继续对话');
    }
    return requestedTaskSessionId;
  }

  markMessageComplete(id: string) {
    const message = this.messages.find(m => m.id === id);
    if (message) {
      message.status = 'complete';
    }
    this.messageStore?.updateBody(id, message?.body ?? '', 'complete', message?.entries);
    this.broadcast('messages:update', {
      id,
      body: message?.body ?? '',
      entries: message?.entries,
      status: 'complete',
    });
  }

  private appendInternal(envelope: Envelope, entries?: ConversationEntry[]) {
    this.messages.push(envelope);
    this.messageStore?.insert({
      id: envelope.id,
      groupId: envelope.groupId ?? '',
      taskSessionId: envelope.taskSessionId,
      fromPeer: envelope.from,
      toPeer: envelope.to,
      body: envelope.body,
      status: envelope.status ?? 'complete',
      createdAt: envelope.ts,
      updatedAt: envelope.ts,
      entries: entries ?? undefined,
    });
    for (const id of [envelope.from, envelope.to]) {
      if (id && !this.knownPeers.includes(id)) {
        this.knownPeers.push(id);
      }
    }
    this.broadcast('messages:new', envelope);
  }
}
