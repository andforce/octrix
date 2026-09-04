/**
 * Collect files (and nested paths) from a drag-and-drop DataTransfer for workspace import.
 */

function readEntriesBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function readDirectoryAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];
  do {
    batch = await readEntriesBatch(reader);
    out.push(...batch);
  } while (batch.length > 0);
  return out;
}

async function walkEntry(
  entry: FileSystemEntry,
  pathPrefix: string,
  out: Array<{ relativePath: string; file: File }>,
): Promise<void> {
  if (entry.isFile) {
    const fe = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fe.file(resolve, reject);
    });
    const rel = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
    out.push({ relativePath: rel.replace(/\\/g, '/'), file });
    return;
  }
  if (entry.isDirectory) {
    const de = entry as FileSystemDirectoryEntry;
    const nextPrefix = pathPrefix ? `${pathPrefix}/${de.name}` : de.name;
    const reader = de.createReader();
    const children = await readDirectoryAll(reader);
    for (const child of children) {
      await walkEntry(child, nextPrefix.replace(/\\/g, '/'), out);
    }
  }
}

export async function collectDroppedFilesFromDataTransfer(
  dt: DataTransfer,
): Promise<Array<{ relativePath: string; file: File }>> {
  const out: Array<{ relativePath: string; file: File }> = [];
  const items = [...dt.items];

  const canWebkit = items.some(
    item => item.kind === 'file' && typeof item.webkitGetAsEntry === 'function',
  );

  if (canWebkit) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) {
        await walkEntry(entry, '', out);
      } else {
        const f = item.getAsFile();
        if (f) {
          const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
          out.push({ relativePath: rel.replace(/\\/g, '/'), file: f });
        }
      }
    }
    if (out.length > 0) return out;
  }

  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files.item(i);
    if (!f) continue;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    out.push({ relativePath: rel.replace(/\\/g, '/'), file: f });
  }
  return out;
}

export function droppedFilesHaveNativePaths(dt: DataTransfer): boolean {
  if (dt.files.length === 0) return false;
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files.item(i);
    if (!f) return false;
    const p = (f as File & { path?: string }).path;
    if (!p || typeof p !== 'string') return false;
  }
  return true;
}

export function collectNativePathsFromDataTransfer(dt: DataTransfer): string[] {
  const paths: string[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files.item(i);
    if (!f) continue;
    const p = (f as File & { path?: string }).path;
    if (p) paths.push(p);
  }
  return paths;
}
