'use strict';

// Secure preload bridge.
// - Exposes ONLY an explicit, minimal API to the renderer.
// - No Node.js primitives (fs, process, child_process) are ever exposed.
// - The renderer can never reach this module's internals.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netx', {
  app: {
    getVersion: () => ipcRenderer.invoke('app:get-version'),
    close: () => ipcRenderer.invoke('app:close'),
    setWindowSize: (width, height) => ipcRenderer.invoke('app:set-window-size', { width, height }),
    openAccountWindow: (session) => ipcRenderer.invoke('app:open-account-window', session),
    getAccountSession: () => ipcRenderer.invoke('app:get-account-session'),
    openBankWindow: (session) => ipcRenderer.invoke('app:open-bank-window', session),
    getBankSession: () => ipcRenderer.invoke('app:get-bank-session'),
    notifyBanksChanged: () => ipcRenderer.invoke('app:notify-banks-changed'),
    onBanksChanged: (callback) => {
      const subscription = () => callback();
      ipcRenderer.on('app:on-banks-changed', subscription);
      return () => {
        ipcRenderer.removeListener('app:on-banks-changed', subscription);
      };
    },
    openTicketWindow: (session) => ipcRenderer.invoke('app:open-ticket-window', session),
    getTicketSession: () => ipcRenderer.invoke('app:get-ticket-session'),
    onTicketSessionUpdated: (callback) => {
      const subscription = (_event, session) => callback(session);
      ipcRenderer.on('app:ticket-session-updated', subscription);
      return () => {
        ipcRenderer.removeListener('app:ticket-session-updated', subscription);
      };
    },
    openOpenTicketsWindow: (session) => ipcRenderer.invoke('app:open-open-tickets-window', session),
    getOpenTicketsSession: () => ipcRenderer.invoke('app:get-open-tickets-session'),
    openTicketWebSelectWindow: (ticketData) => ipcRenderer.invoke('app:open-ticket-web-select-window', ticketData),
    getSelectedTicket: () => ipcRenderer.invoke('app:get-selected-ticket'),
    onSelectedTicketUpdated: (callback) => {
      const subscription = (_event, data) => callback(data);
      ipcRenderer.on('app:selected-ticket-updated', subscription);
      return () => {
        ipcRenderer.removeListener('app:selected-ticket-updated', subscription);
      };
    },
    openSearchTrainWindow: (params) => ipcRenderer.invoke('app:open-search-train-window', params),
    getSearchParams: () => ipcRenderer.invoke('app:get-search-params'),
    selectTrain: (train) => ipcRenderer.invoke('app:select-train', train),

    onTrainSelected: (callback) => {
      const subscription = (_event, train) => callback(train);
      ipcRenderer.on('app:on-train-selected', subscription);
      return () => {
        ipcRenderer.removeListener('app:on-train-selected', subscription);
      };
    },
    getWindowCount: () => ipcRenderer.invoke('app:get-window-count'),
    closeCurrentWindow: () => ipcRenderer.invoke('app:close-current-window'),
    openBookingHistoryWindow: (session) => ipcRenderer.invoke('app:open-booking-history-window', session),
    getBookingHistorySession: () => ipcRenderer.invoke('app:get-booking-history-session'),
    openProxySettingWindow: (session) => ipcRenderer.invoke('app:open-proxy-setting-window', session),
    getProxySettingSession: () => ipcRenderer.invoke('app:get-proxy-setting-session'),
    openCookieDeleteWindow: (session) => ipcRenderer.invoke('app:open-cookie-delete-window', session),
    getCookieDeleteSession: () => ipcRenderer.invoke('app:get-cookie-delete-session'),
    openVersionCheckWindow: (session) => ipcRenderer.invoke('app:open-version-check-window', session),
    getVersionCheckSession: () => ipcRenderer.invoke('app:get-version-check-session'),
    onVersionCheckSessionUpdated: (callback) => {
      const subscription = (_event, session) => callback(session);
      ipcRenderer.on('app:version-check-session-updated', subscription);
      return () => {
        ipcRenderer.removeListener('app:version-check-session-updated', subscription);
      };
    },
    clearCookies: () => ipcRenderer.invoke('app:clear-cookies'),
    checkSoftwareVersion: () => ipcRenderer.invoke('app:check-software-version'),
    openBackupRestoreWindow: (session) => ipcRenderer.invoke('app:open-backup-restore-window', session),
    getBackupRestoreSession: () => ipcRenderer.invoke('app:get-backup-restore-session'),
    browseBackupFile: () => ipcRenderer.invoke('app:browse-backup-file'),
    browseSaveBackupPath: (defaultName) => ipcRenderer.invoke('app:browse-save-backup-path', defaultName),
    saveBackupFile: (opts) => ipcRenderer.invoke('app:save-backup-file', opts),
    openBrowserCheckWindow: (session) => ipcRenderer.invoke('app:open-browser-check-window', session),
    getBrowserCheckSession: () => ipcRenderer.invoke('app:get-browser-check-session'),
    checkBrowserIPBlock: (browserKey) => ipcRenderer.invoke('app:check-browser-ip-block', browserKey),
    launchBrowserExecutable: (browserKey) => ipcRenderer.invoke('app:launch-browser-executable', browserKey),
    getApkToken: () => ipcRenderer.invoke('app:get-apk-token'),
  },
});
