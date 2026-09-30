// The desktop picker's page (Phase 11) gets this small, typed API — nothing else from Electron or Node.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopPickerApi, DesktopPickerState } from '../shared/types';

const api: DesktopPickerApi = {
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: DesktopPickerState) => listener(state);
    ipcRenderer.on('picker:state', handler);
    return () => ipcRenderer.removeListener('picker:state', handler);
  },
  pick: (row, column) => ipcRenderer.send('picker:pick', row, column),
  resize: (width, height) => ipcRenderer.send('picker:resize', width, height),
  close: () => ipcRenderer.send('picker:close'),
};

contextBridge.exposeInMainWorld('picker', api);
