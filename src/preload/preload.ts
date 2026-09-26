// Exposes a small, typed API to the sandboxed renderer. The renderer never sees tokens or Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppState, OverlayApi } from '../shared/types';

const api: OverlayApi = {
  getState: () => ipcRenderer.invoke('state:get') as Promise<AppState>,
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
  onHover: (listener) => {
    const handler = (_event: IpcRendererEvent, hovered: boolean) => listener(hovered);
    ipcRenderer.on('hover:changed', handler);
    return () => ipcRenderer.removeListener('hover:changed', handler);
  },
  refresh: () => ipcRenderer.send('usage:refresh'),
  setCompact: (compact) => ipcRenderer.send('view:set-compact', compact),
  resize: (width, height) => ipcRenderer.send('window:resize', width, height),
  showMenu: () => ipcRenderer.send('menu:show'),
  openClaudeCode: () => ipcRenderer.send('claude-code:open'),
};

contextBridge.exposeInMainWorld('overlay', api);
