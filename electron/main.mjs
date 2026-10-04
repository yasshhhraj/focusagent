import { app, BrowserWindow, ipcMain, Notification, powerMonitor, session } from "electron";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dbus from "dbus-next";
import { contextHash, reasonAboutActivity } from "./reasoning.mjs";
import { isOwnActivity, markSessionRelated } from "./activity-targeting.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const isDevelopment = !app.isPackaged;
const OLLAMA_URL = "http://127.0.0.1:11434";
const REASONING_THRESHOLD_MINUTES = 5;
const DRIFT_THRESHOLD_MINUTES = 10;
const INTERVENTION_COOLDOWN_MINUTES = 3;
const REASONING_COOLDOWN_MINUTES = 5;
let database;
let mainWindow;
let interventionTimer;
let reasoningInFlight = false;
let modelCache = { checkedAt: 0, name: null };
const ownProcessIds = new Set([process.pid]);

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
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      application TEXT NOT NULL,
      pid INTEGER,
      window_title TEXT,
      source TEXT NOT NULL DEFAULT 'kwin'
    );
    CREATE TABLE IF NOT EXISTS activity_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      classification TEXT NOT NULL DEFAULT 'unknown',
      task_id INTEGER REFERENCES tasks(id),
      corrected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS task_app_links (
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      application TEXT NOT NULL,
      classification TEXT NOT NULL DEFAULT 'related',
      PRIMARY KEY (task_id, application)
    );
    CREATE TABLE IF NOT EXISTS break_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER REFERENCES activity_sessions(id),
      task_id INTEGER REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      level INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      response TEXT,
      responded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS activity_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES activity_sessions(id),
      task_id INTEGER REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT,
      context_hash TEXT NOT NULL,
      classification TEXT NOT NULL,
      trajectory TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      recommend_intervention INTEGER NOT NULL,
      message TEXT,
      reason TEXT,
      latency_ms INTEGER,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_analysis_session_idx ON activity_analysis(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS activity_analysis_context_idx ON activity_analysis(context_hash, created_at DESC);
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all();
  if (!taskColumns.some((column) => column.name === "completed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
  }
  db.prepare(`
    DELETE FROM task_app_links
    WHERE lower(application) IN ('focus-agent', 'focus agent', 'dev.yashraj.focusagent')
  `).run();
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

function deletePreference(key) {
  database.prepare("DELETE FROM preferences WHERE key = ?").run(key);
}

function monitoringState(now = new Date()) {
  if (getPreference("monitoring_paused") === "true") return { paused: true, mode: "indefinite", until: null };
  const until = getPreference("monitoring_paused_until");
  if (until && new Date(until) > now) return { paused: true, mode: "timed", until };
  if (until) deletePreference("monitoring_paused_until");
  return { paused: false, mode: null, until: null };
}

function pauseMonitoring(minutes = null) {
  if (minutes === null) {
    setPreference("monitoring_paused", "true");
    deletePreference("monitoring_paused_until");
    return;
  }
  const duration = Math.min(240, Math.max(15, Number(minutes) || 15));
  setPreference("monitoring_paused", "false");
  setPreference("monitoring_paused_until", new Date(Date.now() + duration * 60_000).toISOString());
}

function resumeMonitoring() {
  setPreference("monitoring_paused", "false");
  deletePreference("monitoring_paused_until");
}

function activeTask() {
  return database.prepare(`
    SELECT id, title, priority, estimated_minutes AS estimatedMinutes, status
    FROM tasks WHERE status = 'active' ORDER BY id LIMIT 1
  `).get() ?? null;
}

function listTasks() {
  return database.prepare(`
    SELECT id, title, priority, estimated_minutes AS estimatedMinutes, status
    FROM tasks ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, id
  `).all();
}

function latestSession() {
  return database.prepare("SELECT * FROM activity_sessions ORDER BY id DESC LIMIT 1").get() ?? null;
}

function activeBreak(now = new Date()) {
  const breakUntil = getPreference("break_until");
  return breakUntil && new Date(breakUntil) > now;
}

function minutesBetween(startedAt, endedAt = new Date().toISOString()) {
  return Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000));
}

function inferClassification(application, taskId, durationMinutes) {
  if (!taskId) return { classification: "unknown", confidence: 0.3 };
  const link = database.prepare("SELECT classification FROM task_app_links WHERE task_id = ? AND application = ?").get(taskId, application);
  if (link) return { classification: link.classification, confidence: 0.96 };

  const workApps = ["code", "codium", "konsole", "terminal", "github", "git", "electron"];
  if (workApps.some((name) => application.toLowerCase().includes(name))) {
    return { classification: "related", confidence: 0.62 };
  }
  if (durationMinutes >= DRIFT_THRESHOLD_MINUTES) return { classification: "possible_drift", confidence: 0.72 };
  return { classification: "unknown", confidence: 0.38 };
}

function recordWindow(application, pid, title) {
  if (isOwnActivity(application, pid, ownProcessIds)) return;
  if (monitoringState().paused) return;
  const now = new Date().toISOString();
  const safeTitle = getPreference("capture_titles") === "true" ? title : null;
  database.prepare(`
    INSERT INTO activity_events (observed_at, application, pid, window_title)
    VALUES (?, ?, ?, ?)
  `).run(now, application, Number(pid) || 0, safeTitle);
  if (activeBreak(new Date(now))) return;
  setPreference("activity_needs_resume", "false");

  const current = latestSession();
  if (current && current.application === application && minutesBetween(current.ended_at, now) <= 1) {
    database.prepare("UPDATE activity_sessions SET ended_at = ? WHERE id = ?").run(now, current.id);
    return;
  }

  if (current) database.prepare("UPDATE activity_sessions SET ended_at = ? WHERE id = ?").run(now, current.id);
  const task = activeTask();
  const inference = inferClassification(application, task?.id, 0);
  database.prepare(`
    INSERT INTO activity_sessions (application, started_at, ended_at, classification, task_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(application, now, now, inference.classification, task?.id ?? null);
  database.prepare("UPDATE interventions SET status = 'expired' WHERE status = 'pending'").run();
}

async function ollamaModels() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.models) ? payload.models : [];
  } catch {
    return [];
  }
}

async function gemmaModel() {
  if (Date.now() - modelCache.checkedAt < 30_000) return modelCache.name;
  const models = await ollamaModels();
  modelCache = { checkedAt: Date.now(), name: models.find((model) => /gemma/i.test(model.name))?.name ?? null };
  return modelCache.name;
}

const planSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          estimatedMinutes: { type: "integer", minimum: 10, maximum: 480 },
        },
        required: ["title", "priority", "estimatedMinutes"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
};

function validatePlan(payload) {
  if (!payload || !Array.isArray(payload.tasks) || payload.tasks.length === 0) throw new Error("Gemma returned no tasks");
  return payload.tasks.slice(0, 3).map((task) => ({
    title: String(task.title ?? "").trim().slice(0, 160),
    priority: ["high", "medium", "low"].includes(task.priority) ? task.priority : "medium",
    estimatedMinutes: Math.min(480, Math.max(10, Number(task.estimatedMinutes) || 60)),
  })).filter((task) => task.title);
}

async function parsePlan(input) {
  const model = await gemmaModel();
  if (model) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: planSchema,
          prompt: `Turn Raj's plan into at most three concrete tasks. Preserve his meaning and do not invent work. Plan: ${input}`,
          options: { temperature: 0, num_predict: 256 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) {
        const result = await response.json();
        return { tasks: validatePlan(JSON.parse(result.response)), source: model };
      }
    } catch (error) {
      console.warn("Gemma plan parsing failed; using deterministic fallback", error);
    }
  }

  const tasks = String(input).split(/[,;]|\band\b/iu).map((title) => title.trim()).filter(Boolean).slice(0, 3)
    .map((title) => ({ title, priority: "high", estimatedMinutes: 60 }));
  return { tasks: tasks.length ? tasks : [{ title: String(input).trim(), priority: "high", estimatedMinutes: 60 }], source: "deterministic" };
}

async function createPlan(input) {
  const cleanInput = String(input).trim().slice(0, 2_000);
  if (!cleanInput) throw new Error("A plan is required");
  const parsed = await parsePlan(cleanInput);
  const insert = database.prepare(`
    INSERT INTO tasks (title, priority, estimated_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const hasActive = Boolean(activeTask());
  database.exec("BEGIN");
  try {
    parsed.tasks.forEach((task, index) => insert.run(task.title, task.priority, task.estimatedMinutes, !hasActive && index === 0 ? "active" : "planned", new Date().toISOString()));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (!hasActive) associateCurrentSession(activeTask());
  return { source: parsed.source };
}

function sessionTotals() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = database.prepare("SELECT id, started_at, ended_at, classification FROM activity_sessions WHERE started_at >= ?").all(today.toISOString());
  const totals = { focusedMinutes: 0, relatedMinutes: 0, breakMinutes: 0 };
  const latestId = latestSession()?.id;
  const latestIsLive = getPreference("activity_needs_resume") !== "true";
  for (const row of rows) {
    const minutes = minutesBetween(row.started_at, row.id === latestId && latestIsLive ? undefined : row.ended_at);
    if (row.classification === "focus") totals.focusedMinutes += minutes;
    if (row.classification === "related") totals.relatedMinutes += minutes;
    if (row.classification === "break") totals.breakMinutes += minutes;
  }
  const breaks = database.prepare("SELECT started_at, ended_at FROM break_sessions WHERE started_at >= ?").all(today.toISOString());
  for (const row of breaks) {
    const effectiveEnd = new Date(row.ended_at) > new Date() ? undefined : row.ended_at;
    totals.breakMinutes += minutesBetween(row.started_at, effectiveEnd);
  }
  return totals;
}

function latestAnalysis(sessionId) {
  if (!sessionId) return null;
  return database.prepare(`
    SELECT id, created_at AS createdAt, source, model, context_hash AS contextHash,
      classification, trajectory, confidence, recommend_intervention AS recommendIntervention,
      message, reason, latency_ms AS latencyMs, status
    FROM activity_analysis WHERE session_id = ? ORDER BY id DESC LIMIT 1
  `).get(sessionId) ?? null;
}

function buildReasoningContext(task, current, durationMinutes) {
  const recentSessions = database.prepare(`
    SELECT application, started_at, ended_at, classification
    FROM activity_sessions ORDER BY id DESC LIMIT 8
  `).all().reverse().map((row) => ({
    application: row.application,
    durationMinutes: minutesBetween(row.started_at, row.ended_at),
    classification: row.classification,
  }));
  const corrections = database.prepare(`
    SELECT application, classification FROM activity_sessions
    WHERE task_id = ? AND corrected = 1 ORDER BY id DESC LIMIT 5
  `).all(task.id);
  const learnedLink = database.prepare(`
    SELECT classification FROM task_app_links WHERE task_id = ? AND application = ?
  `).get(task.id, current.application)?.classification ?? null;
  return {
    task: { title: task.title, priority: task.priority, estimatedMinutes: task.estimatedMinutes },
    current: {
      application: current.application,
      durationMinutes,
      durationBucketMinutes: Math.floor(durationMinutes / 5) * 5,
    },
    recentSessions,
    corrections,
    learnedRelationship: learnedLink,
  };
}

function saveAnalysis({ current, task, hash, source, model = null, reasoning, status }) {
  const result = database.prepare(`
    INSERT INTO activity_analysis (
      session_id, task_id, created_at, source, model, context_hash, classification,
      trajectory, confidence, recommend_intervention, message, reason, latency_ms, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    current.id, task.id, new Date().toISOString(), source, model, hash,
    reasoning.classification, reasoning.trajectory, reasoning.confidence,
    reasoning.recommendIntervention ? 1 : 0, reasoning.message, reasoning.reason,
    reasoning.latencyMs ?? null, status,
  );
  return { id: Number(result.lastInsertRowid), ...reasoning, source, model, status };
}

function deterministicAnalysis(current, task, durationMinutes, hash, status, reason) {
  const inference = inferClassification(current.application, task.id, durationMinutes);
  return saveAnalysis({
    current, task, hash, source: "deterministic", status,
    reasoning: {
      classification: inference.classification,
      trajectory: "unknown",
      confidence: Math.round(inference.confidence * 100),
      recommendIntervention: inference.classification === "possible_drift",
      message: interventionMessage(1, task, current, durationMinutes),
      reason,
      latencyMs: 0,
    },
  });
}

async function analyzeAmbiguousActivity(task, current, durationMinutes) {
  const context = buildReasoningContext(task, current, durationMinutes);
  const hash = contextHash({ ...context, current: { ...context.current, durationMinutes: context.current.durationBucketMinutes } });
  const previous = latestAnalysis(current.id);
  if (previous && minutesBetween(previous.createdAt) < REASONING_COOLDOWN_MINUTES) return previous;

  const model = await gemmaModel();
  if (!model) return deterministicAnalysis(current, task, durationMinutes, hash, "unavailable", "Gemma is unavailable; local rules remain active.");

  try {
    const reasoning = await reasonAboutActivity({ baseUrl: OLLAMA_URL, model, context });
    const liveTask = activeTask();
    const liveSession = latestSession();
    if (Number(liveTask?.id) !== Number(task.id) || Number(liveSession?.id) !== Number(current.id) || liveSession.application !== current.application) {
      return null;
    }
    const accepted = saveAnalysis({ current, task, hash, source: "gemma", model, reasoning, status: "valid" });
    const storedClassification = reasoning.classification === "distraction" ? "possible_drift" : reasoning.classification;
    database.prepare("UPDATE activity_sessions SET classification = ? WHERE id = ? AND corrected = 0")
      .run(storedClassification, current.id);
    return accepted;
  } catch (error) {
    console.warn("Gemma activity reasoning failed; using deterministic fallback", error);
    return deterministicAnalysis(current, task, durationMinutes, hash, "error", "Gemma reasoning failed validation or timed out; local rules remain active.");
  }
}

function interventionMessage(level, task, session, durationMinutes) {
  const messages = [
    `You have been in ${session.application} for ${durationMinutes} minutes. Still working on ${task.title}?`,
    `${task.title} is still your active priority. Is ${session.application} helping you move it forward?`,
    `Focus check: ${durationMinutes} minutes in ${session.application} without a confirmed task connection.`,
    `Your current activity still appears separate from ${task.title}. Choose what you want Focus Agent to do.`,
    `Let's reset the trajectory. ${task.title} is active, while ${session.application} has held your attention for ${durationMinutes} minutes.`,
  ];
  return messages[Math.min(5, Math.max(1, level)) - 1];
}

function interventionPayload(row, task, current, analysis = latestAnalysis(current.id)) {
  const durationMinutes = minutesBetween(current.started_at);
  return {
    id: Number(row.id),
    sessionId: Number(current.id),
    level: Number(row.level),
    createdAt: row.created_at,
    taskId: Number(task.id),
    taskTitle: task.title,
    application: current.application,
    durationMinutes,
    message: analysis?.source === "gemma" && analysis.message
      ? analysis.message
      : interventionMessage(Number(row.level), task, current, durationMinutes),
    reasoningSource: analysis?.source ?? "deterministic",
    reasoningModel: analysis?.model ?? null,
    reasoningReason: analysis?.source === "gemma" ? analysis.reason : null,
    stats: sessionTotals(),
  };
}

function activeIntervention() {
  const row = database.prepare("SELECT * FROM interventions WHERE status = 'pending' ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  const task = activeTask();
  const current = latestSession();
  if (!task || !current || Number(row.session_id) !== Number(current.id)) return null;
  return interventionPayload(row, task, current);
}

function presentIntervention(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("intervention:show", payload);

  if (Notification.isSupported() && payload.level <= 3) {
    const notification = new Notification({
      title: payload.level === 1 ? "A quiet focus check" : "Focus Agent needs your input",
      body: payload.message,
      silent: payload.level < 3,
    });
    notification.on("click", () => {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("intervention:show", payload);
    });
    notification.show();
  }

  if (payload.level >= 4) {
    mainWindow.show();
    if (payload.level >= 5 && !mainWindow.isMaximized()) mainWindow.maximize();
    mainWindow.focus();
  }
}

async function evaluateInterventions() {
  if (reasoningInFlight) return;
  if (monitoringState().paused || activeBreak() || powerMonitor.getSystemIdleTime() > 300) return;
  const task = activeTask();
  const current = latestSession();
  if (!task || !current || current.corrected) return;
  const durationMinutes = minutesBetween(current.started_at);
  const deterministic = inferClassification(current.application, task.id, durationMinutes);
  if (deterministic.classification === "related" || durationMinutes < REASONING_THRESHOLD_MINUTES) return;

  reasoningInFlight = true;
  let analysis;
  try {
    analysis = await analyzeAmbiguousActivity(task, current, durationMinutes);
  } finally {
    reasoningInFlight = false;
  }
  if (!analysis) return;
  const liveTask = activeTask();
  const liveSession = latestSession();
  if (Number(liveTask?.id) !== Number(task.id) || Number(liveSession?.id) !== Number(current.id)) return;
  if (durationMinutes < DRIFT_THRESHOLD_MINUTES) return;
  const gemmaApprovesIntervention = analysis.source === "gemma"
    && analysis.status === "valid"
    && analysis.classification === "distraction"
    && Number(analysis.confidence) >= 80
    && Boolean(analysis.recommendIntervention);
  const deterministicFallback = analysis.source === "deterministic";
  if (!gemmaApprovesIntervention && !deterministicFallback) return;

  const latest = database.prepare("SELECT * FROM interventions WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(current.id);
  if (latest && minutesBetween(latest.responded_at ?? latest.created_at) < INTERVENTION_COOLDOWN_MINUTES) return;
  if (latest?.status === "pending") {
    database.prepare("UPDATE interventions SET status = 'ignored', responded_at = ? WHERE id = ?")
      .run(new Date().toISOString(), latest.id);
  }

  const ignored = database.prepare("SELECT COUNT(*) AS count FROM interventions WHERE session_id = ? AND status = 'ignored'").get(current.id)?.count ?? 0;
  const level = Math.min(5, Number(ignored) + 1);
  const createdAt = new Date().toISOString();
  const result = database.prepare(`
    INSERT INTO interventions (session_id, task_id, created_at, level, reason)
    VALUES (?, ?, ?, ?, 'possible_drift')
  `).run(current.id, task.id, createdAt, level);
  const row = { id: Number(result.lastInsertRowid), level, created_at: createdAt };
  presentIntervention(interventionPayload(row, task, current, analysis));
}

function resolveIntervention(id, response) {
  const sessionId = database.prepare("SELECT session_id FROM interventions WHERE id = ?").get(id)?.session_id;
  database.prepare(`
    UPDATE interventions SET status = 'responded', response = ?, responded_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(response, new Date().toISOString(), id);
  if (sessionId) database.prepare("UPDATE interventions SET status = 'resolved' WHERE session_id = ? AND status = 'ignored'").run(sessionId);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("intervention:clear", Number(id));
}

function respondToIntervention(id, action, value) {
  const safeAction = ["resume", "still_related", "break", "switch_task", "pause", "not_now"].includes(action) ? action : "not_now";
  if (safeAction === "still_related") {
    const target = database.prepare("SELECT session_id AS sessionId, task_id AS taskId FROM interventions WHERE id = ?").get(id);
    if (target) markSessionRelated(database, Number(target.sessionId), Number(target.taskId));
  }
  if (safeAction === "break") startBreak(Number(value) || 15);
  if (safeAction === "switch_task") activateTask(Number(value));
  if (safeAction === "pause") pauseMonitoring(value === null ? null : Number(value));
  if (safeAction === "not_now") {
    database.prepare("UPDATE interventions SET status = 'ignored', response = 'not_now', responded_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("intervention:clear", Number(id));
    return;
  }
  resolveIntervention(Number(id), safeAction);
}

async function dashboard() {
  const task = activeTask();
  const now = new Date();
  const onBreak = activeBreak(now);
  const waitingToResume = getPreference("activity_needs_resume") === "true";
  const current = waitingToResume ? null : latestSession();
  const breakStarted = getPreference("break_started");
  const durationMinutes = onBreak && breakStarted ? minutesBetween(breakStarted) : current ? minutesBetween(current.started_at) : 0;
  const inferred = current ? inferClassification(current.application, task?.id, durationMinutes) : { classification: "unknown", confidence: 0 };
  const analysis = current ? latestAnalysis(current.id) : null;
  const acceptedAnalysis = analysis?.status === "valid" && analysis.source === "gemma" ? analysis : null;
  const classification = powerMonitor.getSystemIdleTime() > 300 || onBreak
    ? "break"
    : current?.corrected
      ? current.classification
      : acceptedAnalysis?.classification ?? inferred.classification;
  const confidence = current?.corrected ? 1 : acceptedAnalysis ? Number(acceptedAnalysis.confidence) / 100 : inferred.confidence;
  const monitoring = monitoringState(now);
  const model = await gemmaModel();
  const lastReasoning = database.prepare(`
    SELECT source, model, latency_ms AS latencyMs, status, created_at AS createdAt
    FROM activity_analysis ORDER BY id DESC LIMIT 1
  `).get() ?? null;
  return {
    tasks: listTasks(),
    activity: {
      application: onBreak ? "Intentional break" : current?.application ?? "Waiting for KWin activity",
      since: onBreak && breakStarted ? breakStarted : current?.started_at ?? now.toISOString(),
      durationMinutes,
      classification,
      confidence,
      activeTaskId: task?.id ?? null,
      sessionId: current?.id ? Number(current.id) : null,
      reasoningSource: current?.corrected ? "user" : acceptedAnalysis?.source ?? "deterministic",
      trajectory: acceptedAnalysis?.trajectory ?? "unknown",
    },
    ...sessionTotals(),
    monitoringPaused: monitoring.paused,
    monitoringPauseMode: monitoring.mode,
    monitoringPauseUntil: monitoring.until,
    modelAvailable: Boolean(model),
    modelName: model,
    planSource: getPreference("last_plan_source") ?? "none",
    lastReasoning,
  };
}

function completeTask(taskId) {
  const wasActive = database.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)?.status === "active";
  database.prepare("UPDATE tasks SET status = 'completed', completed_at = ? WHERE id = ?").run(new Date().toISOString(), taskId);
  if (wasActive) {
    database.prepare("UPDATE tasks SET status = 'active' WHERE id = (SELECT id FROM tasks WHERE status = 'planned' ORDER BY id LIMIT 1)").run();
    associateCurrentSession(activeTask());
  }
}

function activateTask(taskId) {
  database.exec("UPDATE tasks SET status = 'planned' WHERE status = 'active'");
  database.prepare("UPDATE tasks SET status = 'active' WHERE id = ? AND status != 'completed'").run(taskId);
  associateCurrentSession(activeTask());
}

function associateCurrentSession(task) {
  const current = latestSession();
  if (!task || !current) return;
  const inference = inferClassification(current.application, task.id, minutesBetween(current.started_at));
  database.prepare("UPDATE activity_sessions SET task_id = ?, classification = ?, corrected = 0 WHERE id = ?")
    .run(task.id, inference.classification, current.id);
}

function startBreak(minutes = 15) {
  if (activeBreak()) return;
  const duration = Math.min(120, Math.max(5, Number(minutes) || 15));
  const now = new Date();
  const until = new Date(now.getTime() + duration * 60_000);
  setPreference("break_until", until.toISOString());
  setPreference("break_started", now.toISOString());
  setPreference("activity_needs_resume", "true");
  const current = latestSession();
  if (current) database.prepare("UPDATE activity_sessions SET ended_at = ? WHERE id = ?").run(now.toISOString(), current.id);
  database.prepare("INSERT INTO break_sessions (started_at, ended_at) VALUES (?, ?)").run(now.toISOString(), until.toISOString());
}

function startActivityBridge() {
  const { Interface } = dbus.interface;
  class ActivityInterface extends Interface {
    reportWindow(application, pid, title) { recordWindow(application, pid, title); }
  }
  ActivityInterface.configureMembers({ methods: { reportWindow: { name: "ReportWindow", inSignature: "sss", outSignature: "" } } });
  const bus = dbus.sessionBus();
  bus.on("error", (error) => console.error("D-Bus activity bridge error:", error));
  bus.export("/Activity", new ActivityInterface("dev.yashraj.FocusAgent.Activity"));
  void bus.requestName("dev.yashraj.FocusAgent");
}

function createWindow() {
  const window = new BrowserWindow({
    title: "Focus Agent", width: 1240, height: 820, minWidth: 900, minHeight: 650, backgroundColor: "#10201c",
    frame: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(currentDir, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow = window;
  const rememberRendererPid = () => {
    const rendererPid = window.webContents.getOSProcessId();
    if (rendererPid > 0) ownProcessIds.add(rendererPid);
  };
  rememberRendererPid();
  window.webContents.on("did-finish-load", rememberRendererPid);
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.on("did-finish-load", () => {
    const intervention = activeIntervention();
    if (intervention) window.webContents.send("intervention:show", intervention);
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
  ipcMain.handle("plan:create", async (_event, input) => {
    const result = await createPlan(input);
    setPreference("last_plan_source", result.source);
    return result;
  });
  ipcMain.handle("monitoring:set-paused", (_event, paused) => paused ? pauseMonitoring(null) : resumeMonitoring());
  ipcMain.handle("monitoring:pause-for", (_event, minutes) => pauseMonitoring(minutes === null ? null : Number(minutes)));
  ipcMain.handle("monitoring:resume", resumeMonitoring);
  ipcMain.handle("task:complete", (_event, taskId) => completeTask(Number(taskId)));
  ipcMain.handle("task:activate", (_event, taskId) => activateTask(Number(taskId)));
  ipcMain.handle("activity:mark-related", (_event, sessionId, taskId) => markSessionRelated(database, Number(sessionId), Number(taskId)));
  ipcMain.handle("break:start", (_event, minutes) => startBreak(minutes));
  ipcMain.handle("intervention:get-active", activeIntervention);
  ipcMain.handle("intervention:respond", (_event, id, action, value) => respondToIntervention(Number(id), action, value));
  ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:toggle-maximize", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return false;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
    return target.isMaximized();
  });
  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  createWindow();
  interventionTimer = setInterval(() => void evaluateInterventions().catch((error) => console.error("Intervention evaluation failed", error)), 30_000);
  setTimeout(() => void evaluateInterventions().catch((error) => console.error("Intervention evaluation failed", error)), 5_000);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { if (interventionTimer) clearInterval(interventionTimer); });
