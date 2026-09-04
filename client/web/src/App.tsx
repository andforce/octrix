import { useState } from 'react';
import { StoreContext, DispatchContext, useStoreReducer, useAppStore, useAppDispatch } from './hooks/useStore';
import { useWebSocket, WsContext } from './hooks/useWebSocket';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { ContactsModal } from './components/modals/ContactsModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { TerminalModal } from './components/modals/TerminalModal';
import { TaskSessionCreateModal } from './components/modals/TaskSessionCreateModal';
import { TaskSessionHistoryModal } from './components/modals/TaskSessionHistoryModal';
import { RelayConnectModal } from './components/modals/RelayConnectModal';
import { AgentStartupPromptDialog } from './components/AgentStartupPromptDialog';

function AppContent() {
  const { groups, taskSessions, selectedGroupId } = useAppStore();
  const dispatch = useAppDispatch();
  const [showContacts, setShowContacts] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [showTaskHistory, setShowTaskHistory] = useState(false);
  const [showRelayConnect, setShowRelayConnect] = useState(false);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  const selectedGroup = selectedGroupId ? groups.find(g => g.id === selectedGroupId) : undefined;
  const selectedDraftMission = selectedGroup?.activeTaskSessionId
    ? taskSessions.find(session => (
      session.id === selectedGroup.activeTaskSessionId
      && session.kind === 'mission'
      && session.status === 'draft'
    ))
    : undefined;

  return (
    <div className="relative flex h-screen bg-mesh bg-surface">
      <div
        className="pointer-events-none absolute inset-0 bg-grid-subtle bg-grid opacity-[0.45]"
        aria-hidden
      />
      {/* Sidebar */}
      {isSidebarVisible && (
        <div className="relative z-10 w-72 flex-shrink-0">
          <Sidebar
            onShowCreateGroup={() => setShowCreateGroup(true)}
            onShowContacts={() => setShowContacts(true)}
            onShowRelayConnect={() => setShowRelayConnect(true)}
          />
        </div>
      )}

      {/* Main content */}
      <div className="relative z-10 flex-1 min-w-0">
        {selectedGroup ? (
          <ChatView
            group={selectedGroup}
            isSidebarVisible={isSidebarVisible}
            onToggleSidebar={() => setIsSidebarVisible(visible => !visible)}
            onOpenNewTask={() => setShowCreateTask(true)}
            onOpenTaskHistory={() => setShowTaskHistory(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8">
            <div className="max-w-md text-center">
              <div className="relative mx-auto mb-8 flex h-24 w-24 animate-fade-in-slow items-center justify-center [animation-fill-mode:both]">
                <div className="absolute inset-0 animate-pulse-soft rounded-3xl bg-accent-muted blur-2xl" />
                <div className="relative flex h-full w-full items-center justify-center rounded-3xl border border-border-strong bg-surface-elevated/90 shadow-panel backdrop-blur-sm">
                  <svg
                    className="h-12 w-12 text-accent"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.25}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                </div>
              </div>
              <h2 className="font-display animate-fade-in-slow text-2xl font-bold tracking-tight text-content [animation-delay:90ms] [animation-fill-mode:both]">
                选择群组开始
              </h2>
              <p className="mt-3 animate-fade-in-slow text-sm leading-relaxed text-content-muted [animation-delay:180ms] [animation-fill-mode:both]">
                在左侧列表中选择一个会话，或使用「建群」拉起多 Agent 协作。消息与终端会在此聚合。
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showContacts && <ContactsModal onClose={() => setShowContacts(false)} />}
      {showCreateGroup && <CreateGroupModal onClose={() => setShowCreateGroup(false)} />}
      {showRelayConnect && <RelayConnectModal onClose={() => setShowRelayConnect(false)} />}
      {showCreateTask && selectedGroup && (
        <TaskSessionCreateModal
          group={selectedGroup}
          initialMission={selectedDraftMission}
          onClose={() => setShowCreateTask(false)}
          onCreated={taskSessionId => {
            dispatch({ type: 'SELECT_TASK_SESSION', payload: { groupId: selectedGroup.id, taskSessionId } });
            setShowCreateTask(false);
          }}
        />
      )}
      {showTaskHistory && selectedGroup && (
        <TaskSessionHistoryModal
          group={selectedGroup}
          onClose={() => setShowTaskHistory(false)}
          onSelectTask={taskSessionId => {
            dispatch({ type: 'SELECT_TASK_SESSION', payload: { groupId: selectedGroup.id, taskSessionId } });
            setShowTaskHistory(false);
          }}
        />
      )}
      <TerminalModal />
      <AgentStartupPromptDialog />
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useStoreReducer();
  const wsApi = useWebSocket(dispatch);

  return (
    <StoreContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <WsContext.Provider value={wsApi}>
          <AppContent />
        </WsContext.Provider>
      </DispatchContext.Provider>
    </StoreContext.Provider>
  );
}
