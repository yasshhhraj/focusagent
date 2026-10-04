export function isOwnActivity(application, pid, ownProcessIds) {
  const numericPid = Number(pid);
  if (Number.isInteger(numericPid) && numericPid > 0 && ownProcessIds.has(numericPid)) return true;
  const normalized = String(application ?? "").trim().toLowerCase();
  return normalized === "focus-agent"
    || normalized === "focus agent"
    || normalized === "dev.yashraj.focusagent";
}

export function markSessionRelated(database, sessionId, taskId) {
  const target = database.prepare("SELECT id, application FROM activity_sessions WHERE id = ?").get(Number(sessionId));
  const task = database.prepare("SELECT id FROM tasks WHERE id = ? AND status != 'completed'").get(Number(taskId));
  if (!target || !task) return { updated: false };
  database.prepare("UPDATE activity_sessions SET classification = 'related', task_id = ?, corrected = 1 WHERE id = ?")
    .run(task.id, target.id);
  database.prepare(`
    INSERT INTO task_app_links (task_id, application, classification) VALUES (?, ?, 'related')
    ON CONFLICT(task_id, application) DO UPDATE SET classification = 'related'
  `).run(task.id, target.application);
  return { updated: true, sessionId: Number(target.id), application: target.application };
}
