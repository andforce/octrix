import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';

const WATCH_EVENT_DEBOUNCE_MS = 150;

export interface WorkspaceWatchGroup {
  id: string;
  workingDirectory?: string;
}

interface WatchRegistration {
  root: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WorkspaceWatchRegistry {
  private readonly watchers = new Map<string, WatchRegistration>();

  constructor(private readonly onWorkspaceChange: (groupId: string) => void) {}

  sync(groups: WorkspaceWatchGroup[]) {
    const desired = new Map<string, string>();
    for (const group of groups) {
      if (!group.workingDirectory) continue;
      desired.set(group.id, resolve(group.workingDirectory));
    }

    for (const [groupId, registration] of this.watchers) {
      if (desired.get(groupId) !== registration.root) {
        this.stopWatching(groupId);
      }
    }

    for (const [groupId, root] of desired) {
      const existing = this.watchers.get(groupId);
      if (existing?.root === root || !existsSync(root)) continue;
      this.startWatching(groupId, root);
    }
  }

  destroy() {
    for (const groupId of [...this.watchers.keys()]) {
      this.stopWatching(groupId);
    }
  }

  private startWatching(groupId: string, root: string) {
    try {
      const watcher = this.createWatcher(root, () => this.scheduleEmit(groupId));
      this.watchers.set(groupId, { root, watcher, timer: null });
    } catch {
      // Ignore unsupported or temporarily unavailable watch targets.
    }
  }

  private stopWatching(groupId: string) {
    const registration = this.watchers.get(groupId);
    if (!registration) return;
    if (registration.timer) clearTimeout(registration.timer);
    registration.watcher.close();
    this.watchers.delete(groupId);
  }

  private scheduleEmit(groupId: string) {
    const registration = this.watchers.get(groupId);
    if (!registration) return;
    if (registration.timer) clearTimeout(registration.timer);
    registration.timer = setTimeout(() => {
      registration.timer = null;
      this.onWorkspaceChange(groupId);
    }, WATCH_EVENT_DEBOUNCE_MS);
  }

  private createWatcher(root: string, listener: () => void): FSWatcher {
    if (process.platform === 'linux') {
      return watch(root, listener);
    }
    try {
      return watch(root, { recursive: true }, listener);
    } catch {
      return watch(root, listener);
    }
  }
}
