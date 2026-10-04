const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusAgent", {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  createPlan: (input) => ipcRenderer.invoke("plan:create", input),
  setMonitoringPaused: (paused) => ipcRenderer.invoke("monitoring:set-paused", paused),
});
