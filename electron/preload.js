const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // token lives in main.js — renderer only passes chatId
  tgSend:  ({ chatId, text }) => ipcRenderer.invoke('tg-send',  { chatId, text }),
  tgGetMe: ()                 => ipcRenderer.invoke('tg-getme'),
  // cloud sync
  syncData:    ({ chatId, trades, expenses, payouts, hindsight, settings }) =>
    ipcRenderer.invoke('sync-data', { chatId, trades, expenses, payouts, hindsight, settings }),
  restoreData: ({ chatId }) => ipcRenderer.invoke('restore-data', { chatId }),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen-change', (_e, val) => cb(val)),
});
