import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import express from 'express';
import { createApp } from './app.js';
import { Store, WORKSPACE_DATA_VERSION } from './store.js';
import { Hub } from './hub.js';
import { ProcessManager } from './process-manager.js';
import { RelayClient } from './relay-client.js';
import { WorkflowEngine } from './workflow-engine.js';
import { MessageStore } from './message-store.js';
import { groupMemberIds } from './models.js';
import { detectPlatformInstallState } from './agent-installation.js';
import { WorkspaceWatchRegistry } from './workspace-watchers.js';
import { ENABLED_AGENT_PLATFORMS } from '../src/agent-platforms.js';

const PORT = parseInt(process.env.CLI_BRIDGE_PORT ?? '39800', 10);

// --- Dependency injection ---

const store = new Store();
const messageStore = new MessageStore();
if (store.didResetWorkData) messageStore.clear();
else messageStore.deleteGroups(store.removedLegacyGroupIds);
messageStore.assignMissingTaskSessionIds(groupId => store.activeTaskSessionForGroup(groupId)?.id);
const hub = new Hub(store, PORT, messageStore);
const pm = new ProcessManager();
const wf = new WorkflowEngine(store);
const relayClient = new RelayClient(PORT);
relayClient.onStatusChange = status => {
  hub.broadcast('relay:status', status);
};
const workspaceWatchers = new WorkspaceWatchRegistry((groupId) => {
  hub.broadcast('workspace:files-changed', { groupId });
});

hub.workflowEngine = wf;
hub.processManager = pm;

pm.onAgentOutput = (agentName, groupId, taskSessionId, content, existingId) => {
  return hub.appendOrUpdateAgentMessage(existingId, agentName, content, groupId, taskSessionId);
};

pm.onConversationEntries = (agentName, groupId, taskSessionId, entries, existingId, status) => {
  return hub.appendOrUpdateAgentEntries(existingId, agentName, entries, groupId, taskSessionId, status);
};

pm.onAgentOutputComplete = (name, gid, taskSessionId, content) => {
  const lastMsg = hub.messages.filter(m => (
    m.from === name
    && m.groupId === gid
    && m.taskSessionId === taskSessionId
  )).at(-1);
  if (lastMsg) hub.markMessageComplete(lastMsg.id);
  hub.routeCollaborationControlBlocks(name, content, gid, taskSessionId);
};

const broadcastState = () => {
  hub.broadcast('state:update', getFullState());
};

const syncWorkspaceWatchers = () => {
  workspaceWatchers.sync(store.groups);
};

syncWorkspaceWatchers();

store.setOnChange(() => {
  syncWorkspaceWatchers();
  broadcastState();
});

const collaborationTimeoutTimer = setInterval(() => {
  const result = store.evaluateCollaborationTimeouts();
  for (const workItem of result.unresponsive) {
    if (!workItem.taskSessionId) continue;
    hub.addSystemNotice(
      workItem.groupId,
      workItem.taskSessionId,
      `工作项「${workItem.title}」派单 3 分钟未回执，已标记为未响应；系统不会自动改派。`,
    );
    const mission = store.taskSessionById(workItem.taskSessionId);
    const group = store.groupById(workItem.groupId);
    const leaderMemberId = workItem.roleId ? mission?.leaderSnapshot?.[workItem.roleId] : undefined;
    const leader = group?.members.find(member => member.id === leaderMemberId);
    if (leader && leader.id !== workItem.ownerMemberId) {
      pm.sendKeys(
        leader.agentId,
        `[系统提醒]\n同角色工作项 ${workItem.id} 已超过 3 分钟未回执，请关注但不要静默改派。`,
        workItem.groupId,
        workItem.taskSessionId,
      );
    }
  }
  for (const workItem of result.progressReminders) {
    if (!workItem.taskSessionId) continue;
    hub.addSystemNotice(
      workItem.groupId,
      workItem.taskSessionId,
      `工作项「${workItem.title}」已 15 分钟没有有效进度，已提醒负责人提交 work.progress。`,
    );
    pm.sendKeys(
      workItem.ownerAgentId,
      `[进度提醒]\n工作项 ${workItem.id} 已 15 分钟没有有效推进。请提交包含已完成内容和下一步的 work.progress；若受阻请明确说明。`,
      workItem.groupId,
      workItem.taskSessionId,
    );
  }
  for (const workItem of result.stalled) {
    if (!workItem.taskSessionId) continue;
    hub.addSystemNotice(
      workItem.groupId,
      workItem.taskSessionId,
      `工作项「${workItem.title}」已 30 分钟没有有效推进，主任务进入 stalled，等待群主核对后恢复。AI 进程未被自动终止。`,
    );
  }
}, 30_000);
collaborationTimeoutTimer.unref();
pm.onProcessChange = () => {
  hub.broadcast('process:status', {
    runningAgentIdsByGroup: pm.getRunningAgentIdsByGroup(),
    busyAgentIdsByGroup: pm.getBusyAgentIdsByGroup(),
    agentErrorsByGroup: pm.getRecentAgentErrorsByGroup(),
  });
};

function getFullState() {
  return {
    agents: store.agents,
    groups: store.groups,
    roles: store.roles,
    taskSessions: store.taskSessions,
    workItems: store.taskCards,
    issues: store.issues,
    messages: hub.messages,
    runningAgentIdsByGroup: pm.getRunningAgentIdsByGroup(),
    busyAgentIdsByGroup: pm.getBusyAgentIdsByGroup(),
    agentErrorsByGroup: pm.getRecentAgentErrorsByGroup(),
    port: hub.port,
    isRunning: hub.isRunning,
    platformInstallState: detectPlatformInstallState(),
    enabledAgentPlatforms: [...ENABLED_AGENT_PLATFORMS],
    workspaceDataVersion: WORKSPACE_DATA_VERSION,
  };
}

const app = createApp({ store, hub, pm, port: PORT, relay: relayClient });

// --- Serve static frontend in production ---

const staticDir = process.env.STATIC_DIR
  || (() => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const candidate = path.resolve(__dirname, '..', 'dist');
    return fs.existsSync(candidate) ? candidate : '';
  })();

if (staticDir && fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
}

// --- Terminal WebSocket tracking ---

const terminalAttachments = new Map<WebSocket, { agentId: string; groupId: string }>();
const workspaceTerminalAttachments = new Map<WebSocket, string>();

pm.onPtyOutput = (agentId, groupId, data) => {
  let sent = 0;
  for (const [ws, attached] of terminalAttachments) {
    if (attached.agentId === agentId && attached.groupId === groupId && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'terminal:output', data: { agentId, groupId, data } }));
      sent++;
    }
  }
  if (sent === 0 && data.length > 0) {
    // Data buffered, no clients attached yet
  }
};

pm.onPtyExit = (agentId, groupId, exitCode) => {
  for (const [ws, attached] of terminalAttachments) {
    if (attached.agentId === agentId && attached.groupId === groupId && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'terminal:exit', data: { agentId, groupId, exitCode } }));
    }
  }
};

pm.onWorkspaceTerminalOutput = (terminalId, data) => {
  for (const [ws, attachedId] of workspaceTerminalAttachments) {
    if (attachedId === terminalId && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'workspace-terminal:output', data: { terminalId, data } }));
    }
  }
};

pm.onWorkspaceTerminalExit = (terminalId, exitCode) => {
  for (const [ws, attachedId] of workspaceTerminalAttachments) {
    if (attachedId === terminalId && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: 'workspace-terminal:exit', data: { terminalId, exitCode } }));
    }
  }
};

// --- HTTP + WebSocket server ---

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  hub.addWsClient(ws);
  const url = new URL(req.url ?? '/ws', 'http://127.0.0.1');
  if (url.searchParams.get('initial') !== '0') {
    ws.send(JSON.stringify(hub.eventSnapshot('state:update', getFullState())));
  }

  ws.on('message', (raw) => {
    try {
      const { event, data } = JSON.parse(raw.toString());
      switch (event) {
        case 'terminal:attach': {
          const agentId = data.agentId as string;
          const groupId = (data.groupId as string) || '';
          terminalAttachments.set(ws, { agentId, groupId });
          const buffer = pm.getOutputBuffer(agentId, groupId);
          const exitStatus = pm.hasAgentExited(agentId, groupId);
          if (buffer.length > 0) {
            const payload = '\x1b[?2026l' + buffer.join('');
            ws.send(JSON.stringify({
              event: 'terminal:output',
              data: { agentId, groupId, data: payload },
            }));
          }
          if (exitStatus.exited) {
            ws.send(JSON.stringify({
              event: 'terminal:exit',
              data: { agentId, groupId, exitCode: exitStatus.exitCode },
            }));
          }
          break;
        }
        case 'terminal:input':
          pm.writeInput(data.agentId, data.data, data.groupId);
          break;
        case 'terminal:resize':
          pm.resizePty(data.agentId, data.cols, data.rows, data.groupId);
          break;
        case 'terminal:detach':
          terminalAttachments.delete(ws);
          break;
        case 'workspace-terminal:attach': {
          const groupId = data.groupId as string;
          const terminalId = data.terminalId as string;
          const terminalName = (data.terminalName as string) || terminalId;
          const group = store.groupById(groupId);
          if (!group || !group.workingDirectory) {
            ws.send(JSON.stringify({
              event: 'workspace-terminal:output',
              data: { terminalId, data: '\r\n[无法打开工作空间终端：未找到关联的工作目录]\r\n' },
            }));
            break;
          }

          const result = pm.ensureWorkspaceTerminal(terminalId, terminalName, group.workingDirectory);
          workspaceTerminalAttachments.set(ws, result.terminalId);
          if (result.error) {
            ws.send(JSON.stringify({
              event: 'workspace-terminal:output',
              data: { terminalId: result.terminalId, data: `\r\n[${result.error}]\r\n` },
            }));
            break;
          }

          const buffer = pm.getWorkspaceTerminalBuffer(result.terminalId);
          if (buffer.length > 0) {
            ws.send(JSON.stringify({
              event: 'workspace-terminal:output',
              data: { terminalId: result.terminalId, data: buffer.join('') },
            }));
          }
          break;
        }
        case 'workspace-terminal:input':
          pm.writeWorkspaceTerminalInput(data.terminalId, data.data);
          break;
        case 'workspace-terminal:resize':
          pm.resizeWorkspaceTerminal(data.terminalId, data.cols, data.rows);
          break;
        case 'workspace-terminal:detach':
          workspaceTerminalAttachments.delete(ws);
          break;
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    terminalAttachments.delete(ws);
    workspaceTerminalAttachments.delete(ws);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  hub.isRunning = true;
  console.log(`[cli-bridge] Server running at http://127.0.0.1:${PORT}`);
  if (relayClient.getConfig().enabled) {
    relayClient.start();
  }
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cli-bridge] ${signal} received, stopping Octrix Host`);
  clearInterval(collaborationTimeoutTimer);
  relayClient.destroy();
  workspaceWatchers.destroy();
  pm.destroy();
  for (const client of wss.clients) client.close(1001, 'Octrix Host stopping');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
