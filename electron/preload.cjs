const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusAgent", {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  createPlan: (input) => ipcRenderer.invoke("plan:create", input),
  setMonitoringPaused: (paused) => ipcRenderer.invoke("monitoring:set-paused", paused),
  pauseMonitoring: (minutes) => ipcRenderer.invoke("monitoring:pause-for", minutes),
  resumeMonitoring: () => ipcRenderer.invoke("monitoring:resume"),
  completeTask: (taskId) => ipcRenderer.invoke("task:complete", taskId),
  activateTask: (taskId) => ipcRenderer.invoke("task:activate", taskId),
  markCurrentRelated: (sessionId, taskId) => ipcRenderer.invoke("activity:mark-related", sessionId, taskId),
  startBreak: (minutes) => ipcRenderer.invoke("break:start", minutes),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getActiveIntervention: () => ipcRenderer.invoke("intervention:get-active"),
  respondToIntervention: (id, action, value) => ipcRenderer.invoke("intervention:respond", id, action, value),
  onIntervention: (callback) => {
    const show = (_event, intervention) => callback(intervention);
    const clear = () => callback(null);
    ipcRenderer.on("intervention:show", show);
    ipcRenderer.on("intervention:clear", clear);
    return () => {
      ipcRenderer.removeListener("intervention:show", show);
      ipcRenderer.removeListener("intervention:clear", clear);
    };
  },
});
