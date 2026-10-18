import { contextBridge, ipcRenderer } from 'electron';

const api: SyncAPI = {
  state: () => ipcRenderer.invoke('sync:state'),
  share: input => ipcRenderer.invoke('sync:share', input),
  rotateToken: () => ipcRenderer.invoke('sync:rotateToken'),
  preview: peer => ipcRenderer.invoke('sync:preview', peer),
  apply: input => ipcRenderer.invoke('sync:apply', input),
  openBackups: () => ipcRenderer.invoke('sync:openBackups'),
};
contextBridge.exposeInMainWorld('sync', api);
