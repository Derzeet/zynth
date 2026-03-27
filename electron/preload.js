const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // token lives in main.js — renderer only passes chatId
  tgSend:  ({ chatId, text }) => ipcRenderer.invoke('tg-send',  { chatId, text }),
  tgGetMe: ()                 => ipcRenderer.invoke('tg-getme'),
  // cloud sync
  syncData:    ({ chatId, trades, expenses, settings }) =>
    ipcRenderer.invoke('sync-data', { chatId, trades, expenses, settings }),
  restoreData: ({ chatId }) => ipcRenderer.invoke('restore-data', { chatId }),
});
