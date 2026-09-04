import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageStore, type StoredMessage } from './message-store';

let tmpDir: string;
let store: MessageStore;

function makeMsgRow(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg-1',
    groupId: 'g1',
    fromPeer: 'ai',
    toPeer: 'user',
    body: 'hello',
    status: 'complete',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msgstore-'));
  store = new MessageStore(tmpDir);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('MessageStore', () => {
  it('inserts and retrieves a message', () => {
    store.insert(makeMsgRow());
    const msg = store.findById('msg-1');
    expect(msg).toBeDefined();
    expect(msg!.body).toBe('hello');
    expect(msg!.fromPeer).toBe('ai');
  });

  it('updates message body', () => {
    store.insert(makeMsgRow());
    store.updateBody('msg-1', 'updated body', 'streaming');
    const msg = store.findById('msg-1');
    expect(msg!.body).toBe('updated body');
    expect(msg!.status).toBe('streaming');
  });

  it('marks persisted streaming messages complete when loading from disk', () => {
    store.insert(makeMsgRow({ id: 'stale-stream', status: 'streaming' }));
    store.close();

    const store2 = new MessageStore(tmpDir);
    const msg = store2.findById('stale-stream');
    expect(msg!.status).toBe('complete');
    store2.close();
  });

  it('splits persisted agent entries when a user JSONL boundary was merged into the same message', () => {
    store.insert(makeMsgRow({
      id: 'merged-agent',
      status: 'streaming',
      createdAt: 10,
      updatedAt: 10,
      body: 'first answer\nsecond answer',
      entries: [
        { id: 'think-1', role: 'thinking', content: 'thinking 1', timestamp: 1_783_324_474_387 },
        { id: 'answer-1', role: 'assistant', content: 'first answer', timestamp: 1_783_324_474_875 },
        { id: 'user-2', role: 'user', content: 'second question', timestamp: 1_783_324_485_340 },
        { id: 'think-2', role: 'thinking', content: 'thinking 2', timestamp: 1_783_324_487_785 },
        { id: 'answer-2', role: 'assistant', content: 'second answer', timestamp: 1_783_324_489_170 },
      ],
    }));
    store.close();

    const store2 = new MessageStore(tmpDir);
    const messages = store2.findByGroup('g1');

    expect(messages).toHaveLength(2);
    expect(messages.map(msg => msg.status)).toEqual(['complete', 'complete']);
    expect(messages.map(msg => msg.body)).toEqual(['first answer', 'second answer']);
    expect(messages.map(msg => msg.createdAt)).toEqual([1783324474.387, 1783324487.785]);
    expect(messages.flatMap(msg => msg.entries ?? []).map(entry => entry.role)).toEqual([
      'thinking',
      'assistant',
      'thinking',
      'assistant',
    ]);
    store2.close();
  });

  it('finds messages by group', () => {
    store.insert(makeMsgRow({ id: 'a', groupId: 'g1', createdAt: 1 }));
    store.insert(makeMsgRow({ id: 'b', groupId: 'g2', createdAt: 2 }));
    store.insert(makeMsgRow({ id: 'c', groupId: 'g1', createdAt: 3 }));

    const g1 = store.findByGroup('g1');
    expect(g1).toHaveLength(2);
    expect(g1.map(m => m.id)).toEqual(['a', 'c']);
  });

  it('converts to envelope format', () => {
    store.insert(makeMsgRow({ id: 'e1', fromPeer: 'bot', toPeer: 'user', groupId: 'g1', createdAt: 42 }));
    const envelopes = store.toEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toEqual({
      id: 'e1',
      from: 'bot',
      to: 'user',
      body: 'hello',
      ts: 42,
      groupId: 'g1',
      taskSessionId: undefined,
      status: 'complete',
      entries: undefined,
    });
  });

  it('persists data across instances', () => {
    store.insert(makeMsgRow({ id: 'persist-1' }));
    store.close();

    const store2 = new MessageStore(tmpDir);
    const msg = store2.findById('persist-1');
    expect(msg).toBeDefined();
    expect(msg!.body).toBe('hello');
    store2.close();
  });

  it('clears every persisted message for a workspace data reset', () => {
    store.insert(makeMsgRow({ id: 'g1-message', groupId: 'g1' }));
    store.insert(makeMsgRow({ id: 'orphan-message', groupId: 'orphan' }));

    store.clear();

    expect(store.allMessages()).toEqual([]);
    const reloaded = new MessageStore(tmpDir);
    expect(reloaded.allMessages()).toEqual([]);
    reloaded.close();
  });

  it('deletes messages only for reset collaboration groups', () => {
    store.insert(makeMsgRow({ id: 'legacy-1', groupId: 'legacy-group' }));
    store.insert(makeMsgRow({ id: 'direct-1', groupId: 'direct-group' }));

    store.deleteGroups(['legacy-group']);

    expect(store.allMessages().map(message => message.id)).toEqual(['direct-1']);
  });
});
