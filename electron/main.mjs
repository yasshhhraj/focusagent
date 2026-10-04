import { app, BrowserWindow, ipcMain, powerMonitor, session } from "electron";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dbus from "dbus-next";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const isDevelopment = !app.isPackaged;
let database;

function initialiseDatabase() {
  const db = new DatabaseSync(path.join(app.getPath("userData"), "focus-agent.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      estimated_minutes INTEGER NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'planned',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      application TEXT NOT NULL,
      pid INTEGER,
      window_title TEXT,
      source TEXT NOT NULL DEFAULT 'kwin'
    );
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function getPreference(key) {
  return database.prepare("SELECT value FROM preferences WHERE key = ?").get(key)?.value;
}

function setPreference(key, value) {
  database.prepare(`
    INSERT INTO preferences (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

async function modelAvailable() {
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const payload = await response.json();
    return Array.isArray(payload.models) && payload.models.some((model) => /gemma/i.test(model.name));
  } catch {
    return false;
  }
}

function listTasks() {
  return database.prepare(`
    SELECT id, title, priority, estimated_minutes AS estimatedMinutes, status
    FROM tasks ORDER BY id DESC
  `).all();
}

function latestActivity() {
  return database.prepare(`
    SELECT application, observed_at AS since
    FROM activity_events ORDER BY id DESC LIMIT 1
  `).get() ?? { application: "Waiting for KWin activity", since: new Date().toISOString() };
}

async function dashboard() {
  const activity = latestActivity();
  return {
    tasks: listTasks(),
    activity: {
      ...activity,
      durationMinutes: 0,
      classification: powerMonitor.getSystemIdleTime() > 300 ? "break" : "unknown",
      confidence: 0,
      activeTaskId: null,
    },
    focusedMinutes: 0,
    relatedMinutes: 0,
    breakMinutes: 0,
    monitoringPaused: getPreference("monitoring_paused") === "true",
    modelAvailable: await modelAvailable(),
  };
}

function createPlan(input) {
  const insert = database.prepare(`
    INSERT INTO tasks (title, priority, estimated_minutes, status, created_at)
    VALUES (?, 'high', 60, 'planned', ?)
  `);
  const titles = String(input).split(/[,;]/).map((title) => title.trim()).filter(Boolean);
  database.exec("BEGIN");
  try {
    for (const title of titles) insert.run(title, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function startActivityBridge() {
  const { Interface } = dbus.interface;

  class ActivityInterface extends Interface {
    reportWindow(application, pid, title) {
      if (getPreference("monitoring_paused") === "true") return;
      const safeTitle = getPreference("capture_titles") === "true" ? title : null;
      database.prepare(`
        INSERT INTO activity_events (observed_at, application, pid, window_title)
        VALUES (?, ?, ?, ?)
      `).run(new Date().toISOString(), application, pid, safeTitle);
    }
  }

  ActivityInterface.configureMembers({
    methods: {
      reportWindow: { name: "ReportWindow", inSignature: "sss", outSignature: "" },
    },
  });

  const bus = dbus.sessionBus();
  bus.on("error", (error) => console.error("D-Bus activity bridge error:", error));
  bus.export("/Activity", new ActivityInterface("dev.yashraj.FocusAgent.Activity"));
  void bus.requestName("dev.yashraj.FocusAgent");
}

function createWindow() {
  const window = new BrowserWindow({
    title: "Focus Agent",
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#10201c",
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = isDevelopment ? url.startsWith("http://localhost:1420") : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  if (isDevelopment) void window.loadURL("http://localhost:1420");
  else void window.loadFile(path.join(currentDir, "../dist/index.html"));
}

app.whenReady().then(() => {
  database = initialiseDatabase();
  startActivityBridge();

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  ipcMain.handle("dashboard:get", dashboard);
  ipcMain.handle("plan:create", (_event, input) => createPlan(input));
  ipcMain.handle("monitoring:set-paused", (_event, paused) => setPreference("monitoring_paused", Boolean(paused)));

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
