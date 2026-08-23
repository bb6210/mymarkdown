import { contextBridge, ipcRenderer } from 'electron';
import type { MarkdownApi, UpdateEvent } from '../shared/api';

const api: MarkdownApi = {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readDir: (dir) => ipcRenderer.invoke('fs:readDir', dir),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  saveImage: (payload) => ipcRenderer.invoke('fs:saveImage', payload),
  readImageDataUrl: (filePath) => ipcRenderer.invoke('fs:readImageDataUrl', filePath),
  readVideoDataUrl: (filePath) => ipcRenderer.invoke('fs:readVideoDataUrl', filePath),
  readVideoFile: (filePath, maxBytes) => ipcRenderer.invoke('fs:readVideoFile', filePath, maxBytes),
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  readImageFile: (filePath) => ipcRenderer.invoke('fs:readImageFile', filePath),
  createFile: (dir, name) => ipcRenderer.invoke('fs:createFile', dir, name),
  createDir: (dir, name) => ipcRenderer.invoke('fs:createDir', dir, name),
  copyEntry: (srcPath, destDir) => ipcRenderer.invoke('fs:copyEntry', srcPath, destDir),
  renameFile: (oldPath, newName) => ipcRenderer.invoke('fs:renameFile', oldPath, newName),
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
  exportMarkdown: (defaultName, content) => ipcRenderer.invoke('export:markdown', { defaultName, content }),
  exportHtml: (defaultName, html, options) =>
    ipcRenderer.invoke('export:html', { defaultName, html, baseDir: options?.baseDir ?? null }),
  exportPdf: (defaultName, html) => ipcRenderer.invoke('export:pdf', { defaultName, html }),
  exportTheme: (payload) => ipcRenderer.invoke('theme:export', payload),
  importTheme: () => ipcRenderer.invoke('theme:import'),
  copyImageToClipboard: (filePath) => ipcRenderer.invoke('clipboard:copyImage', filePath),
  openImageExternally: (filePath) => ipcRenderer.invoke('shell:openImage', filePath),
  writeImageFile: (filePath, data) => ipcRenderer.invoke('fs:writeImageFile', filePath, data),
  communityLogin: (auth) => ipcRenderer.invoke('community:login', auth),
  saveCommunityAuth: (auth) => ipcRenderer.invoke('community:saveAuth', auth),
  loadCommunityAuth: () => ipcRenderer.invoke('community:loadAuth'),
  clearCommunityAuth: () => ipcRenderer.invoke('community:clearAuth'),
  publishToCommunity: (auth, payload) => ipcRenderer.invoke('community:publish', auth, payload),
  openCommunityBrowser: (url) => ipcRenderer.invoke('community:openBrowser', url),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  quitAndInstall: () => ipcRenderer.invoke('update:install'),
  onUpdate: (callback) => {
    ipcRenderer.on('update', (_event, event: UpdateEvent) => callback(event));
  },
  onMenu: (callback) => {
    ipcRenderer.on('menu', (_event, action: string) => callback(action));
  },
  onOpenFile: (callback) => {
    ipcRenderer.on('open-file', (_event, path: string) => callback(path));
  },
};

contextBridge.exposeInMainWorld('api', api);
