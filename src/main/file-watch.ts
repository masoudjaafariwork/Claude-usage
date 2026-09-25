// Calls back (debounced) when a file with a given name changes in any of the given folders.
// Watches the folders, not the file: programs that write atomically (temp file + rename), like
// Claude Desktop and Claude Code, would orphan a watcher on the file itself.
// Folders that don't exist are skipped. Pure module (Node fs only).
import { watch, type FSWatcher } from 'node:fs';

/** Returns a function that stops watching. */
export function watchFileInDirs(dirs: readonly string[], fileName: string, onChange: () => void, debounceMs = 1500): () => void {
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;
  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, file) => {
        // Some platforms don't report the name; then assume it was our file.
        if (file !== null && file.toString() !== fileName) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, debounceMs);
      });
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Folder missing or not watchable: the regular polls still read the file.
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
