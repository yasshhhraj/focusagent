import { FormEvent, useEffect, useMemo, useState } from "react";
import type { DashboardState, FocusTask, InterventionState } from "./types";

const pauseOptions = [
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "4 hours", value: 240 },
  { label: "Until I resume", value: null },
];

const fallbackState: DashboardState = {
  tasks: [
    { id: 1, title: "Ship the Focus Agent prototype", priority: "high", estimatedMinutes: 180, status: "active" },
    { id: 2, title: "Record the demo", priority: "high", estimatedMinutes: 45, status: "planned" },
    { id: 3, title: "Publish the DEV write-up", priority: "high", estimatedMinutes: 90, status: "planned" },
  ],
  activity: {
    application: "Visual Studio Code",
    since: new Date().toISOString(),
    durationMinutes: 24,
    classification: "focus",
    confidence: 0.91,
    activeTaskId: 1,
    sessionId: 1,
    reasoningSource: "deterministic",
    trajectory: "implementation",
  },
  focusedMinutes: 74,
  relatedMinutes: 18,
  breakMinutes: 12,
  monitoringPaused: false,
  monitoringPauseMode: null,
  monitoringPauseUntil: null,
  modelAvailable: false,
  modelName: null,
  planSource: "preview",
  lastReasoning: null,
};

const hasDesktopRuntime = () => Boolean(window.focusAgent);

function App() {
  const [state, setState] = useState<DashboardState>(fallbackState);
  const [plan, setPlan] = useState("");
  const [notice, setNotice] = useState("Monitoring stays on this device");
  const [activeTab, setActiveTab] = useState<"dashboard" | "about">("dashboard");
  const [maximized, setMaximized] = useState(false);
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [intervention, setIntervention] = useState<InterventionState | null>(null);
  const [interventionPauseOpen, setInterventionPauseOpen] = useState(false);

  const refresh = async () => {
    if (!hasDesktopRuntime()) return;
    try {
      setState(await window.focusAgent!.getDashboard());
    } catch {
      setNotice("Runtime unavailable — showing local preview data");
    }
  };

  useEffect(() => {
    void refresh();
    if (!hasDesktopRuntime()) {
      const previewLevel = Number(new URLSearchParams(window.location.search).get("intervention"));
      if (window.location.hostname === "localhost" && previewLevel >= 1 && previewLevel <= 5) {
        const task = fallbackState.tasks[0];
        setIntervention({
          id: 0, sessionId: 1, level: previewLevel, createdAt: new Date().toISOString(), taskId: task.id, taskTitle: task.title,
          application: "YouTube", durationMinutes: 24,
          message: previewLevel === 1
            ? `You have been in YouTube for 24 minutes. Still working on ${task.title}?`
            : `Let's reset the trajectory. ${task.title} is active, while YouTube has held your attention for 24 minutes.`,
          reasoningSource: "gemma", reasoningModel: "gemma3:1b", reasoningReason: "The sustained app sequence does not match the active implementation task.",
          stats: { focusedMinutes: fallbackState.focusedMinutes, relatedMinutes: fallbackState.relatedMinutes, breakMinutes: fallbackState.breakMinutes },
        });
      }
      return;
    }
    void window.focusAgent!.getActiveIntervention().then(setIntervention);
    const unsubscribe = window.focusAgent!.onIntervention(setIntervention);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearInterval(timer); unsubscribe(); };
  }, []);

  const activeTask = useMemo(
    () => state.tasks.find((task) => task.id === state.activity.activeTaskId) ?? state.tasks.find((task) => task.status === "active"),
    [state],
  );

  const submitPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!plan.trim()) return;
    if (hasDesktopRuntime()) {
      try {
        const result = await window.focusAgent!.createPlan(plan);
        setNotice(result.source === "deterministic" ? "Plan saved with the offline rules" : `Plan structured locally by ${result.source}`);
        setPlan("");
        await refresh();
        return;
      } catch {
        setNotice("Gemma is offline; saved with the deterministic parser");
      }
    }
    const task: FocusTask = {
      id: Date.now(),
      title: plan.trim(),
      priority: "high",
      estimatedMinutes: 60,
      status: "planned",
    };
    setState((current) => ({ ...current, tasks: [...current.tasks, task] }));
    setPlan("");
  };

  const pauseMonitoring = async (minutes: number | null) => {
    if (hasDesktopRuntime()) await window.focusAgent!.pauseMonitoring(minutes);
    setState((current) => ({ ...current, monitoringPaused: true, monitoringPauseMode: minutes === null ? "indefinite" : "timed", monitoringPauseUntil: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString() }));
    setPauseMenuOpen(false);
    setNotice(minutes === null ? "Monitoring paused until you resume" : `Monitoring paused for ${pauseOptions.find((option) => option.value === minutes)?.label}`);
  };

  const resumeMonitoring = async () => {
    if (hasDesktopRuntime()) await window.focusAgent!.resumeMonitoring();
    setState((current) => ({ ...current, monitoringPaused: false, monitoringPauseMode: null, monitoringPauseUntil: null }));
    setPauseMenuOpen(false);
    setNotice("Monitoring resumed");
  };

  const completeTask = async (taskId: number) => {
    if (hasDesktopRuntime()) {
      await window.focusAgent!.completeTask(taskId);
      await refresh();
    } else {
      setState((current) => ({
        ...current,
        tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" } : task),
      }));
    }
    setNotice("Progress confirmed by Raj");
  };

  const activateTask = async (taskId: number) => {
    if (hasDesktopRuntime()) {
      await window.focusAgent!.activateTask(taskId);
      await refresh();
    } else {
      setState((current) => ({
        ...current,
        tasks: current.tasks.map((task) => task.status === "completed" ? task : { ...task, status: task.id === taskId ? "active" : "planned" }),
        activity: { ...current.activity, activeTaskId: taskId },
      }));
    }
    setNotice("Active priority changed");
  };

  const markRelated = async () => {
    if (hasDesktopRuntime()) {
      const sessionId = state.activity.sessionId;
      const taskId = activeTask?.id;
      if (!sessionId || !taskId) {
        setNotice("No external activity session is available to correct");
        return;
      }
      const result = await window.focusAgent!.markCurrentRelated(sessionId, taskId);
      if (!result.updated) {
        setNotice("That activity session is no longer available");
        return;
      }
      await refresh();
    } else {
      setState((current) => ({ ...current, activity: { ...current.activity, classification: "related", confidence: 1 } }));
    }
    setNotice("Correction learned for this task and app");
  };

  const takeBreak = async () => {
    if (hasDesktopRuntime()) {
      await window.focusAgent!.startBreak(15);
      await refresh();
    } else {
      setState((current) => ({ ...current, activity: { ...current.activity, classification: "break", confidence: 1 } }));
    }
    setNotice("15-minute break started — no nudges until it ends");
  };

  const switchTask = async () => {
    const next = state.tasks.find((task) => task.status === "planned");
    if (next) await activateTask(next.id);
    else setNotice("Add another priority before switching");
  };

  const minimizeWindow = () => {
    if (hasDesktopRuntime()) void window.focusAgent!.minimizeWindow();
  };

  const toggleMaximizeWindow = async () => {
    if (!hasDesktopRuntime()) return;
    setMaximized(await window.focusAgent!.toggleMaximizeWindow());
  };

  const closeWindow = () => {
    if (hasDesktopRuntime()) void window.focusAgent!.closeWindow();
  };

  const answerIntervention = async (action: string, value?: number | null) => {
    if (!intervention) return;
    if (hasDesktopRuntime()) await window.focusAgent!.respondToIntervention(intervention.id, action, value);
    if (action === "pause") await refresh();
    setIntervention(null);
    setInterventionPauseOpen(false);
    const messages: Record<string, string> = {
      resume: "Priority restored — the escalation counter has reset",
      still_related: "Correction learned for this task and app",
      break: "15-minute break started",
      switch_task: "Active priority changed",
      pause: value === null ? "Monitoring paused until you resume" : `Monitoring paused for ${value} minutes`,
      not_now: "Dismissed — another check may arrive if drift continues",
    };
    setNotice(messages[action] ?? "Intervention resolved");
    await refresh();
  };

  const nextPlannedTask = state.tasks.find((task) => task.status === "planned");
  const pauseDescription = state.monitoringPauseMode === "indefinite"
    ? "Paused until resumed"
    : state.monitoringPauseUntil
      ? `Paused until ${new Date(state.monitoringPauseUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Monitoring paused";

  return (
    <main className="app-frame">
      <header className="titlebar">
        <button className="logo-button" aria-label="Focus Agent dashboard" onClick={() => setActiveTab("dashboard")}><span className="brand-mark" aria-hidden="true">F</span></button>
        <nav className="tabs" aria-label="Primary navigation">
          <button className={activeTab === "dashboard" ? "active" : ""} onClick={() => setActiveTab("dashboard")}>Dashboard</button>
          <button className={activeTab === "about" ? "active" : ""} onClick={() => setActiveTab("about")}>About</button>
        </nav>
        <div className="drag-space" />
        <div className="window-controls">
          <button aria-label="Minimize window" title="Minimize" onClick={minimizeWindow}><span className="minimize-icon" /></button>
          <button aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => void toggleMaximizeWindow()}><span className={maximized ? "restore-icon" : "maximize-icon"} /></button>
          <button className="close-control" aria-label="Close window" title="Close" onClick={closeWindow}><span className="close-icon" /></button>
        </div>
      </header>

      {activeTab === "dashboard" ? (
        <div className="shell dashboard-page">
          <div className="dashboard-tools">
            <div className="pause-control">
              <button className={`monitor ${state.monitoringPaused ? "paused" : ""}`} onClick={() => state.monitoringPaused ? void resumeMonitoring() : setPauseMenuOpen((open) => !open)}>
                <span className="pulse" /> {state.monitoringPaused ? pauseDescription : "Monitoring locally"}
              </button>
              {pauseMenuOpen && <div className="pause-menu"><span>Pause tracking for</span>{pauseOptions.map((option) => <button key={option.label} onClick={() => void pauseMonitoring(option.value)}>{option.label}</button>)}</div>}
            </div>
          </div>

          <section className="hero">
            <div><p className="eyebrow">Current intention</p><h1>{activeTask?.title ?? "Choose what matters now"}</h1></div>
            <div className={`orb ${state.activity.classification}`}><span>{state.activity.durationMinutes}m</span><small>in flow</small></div>
          </section>

          <section className="grid">
            <article className="card activity-card">
              <div className="card-head"><span>Live trajectory</span><span className="confidence">{Math.round(state.activity.confidence * 100)}% confidence</span></div>
              <h2>{state.activity.application}</h2>
              <div className="trajectory"><span className="trajectory-dot" /><strong>{state.activity.classification.replace("_", " ")}</strong><span>associated with your active priority</span></div>
              <div className="reasoning-source">{state.activity.reasoningSource === "gemma" ? "Gemma · local" : state.activity.reasoningSource === "user" ? "User corrected" : "Local rules"}</div>
              <div className="actions"><button onClick={markRelated}>Still related</button><button onClick={takeBreak}>Take a break</button><button className="ghost" onClick={switchTask}>Switch task</button></div>
            </article>

            <article className="card stats-card compact-stats">
              <div className="card-head"><span>Today</span><span>local time</span></div>
              <div className="stats">
                <div><strong>{state.focusedMinutes}</strong><small>focused min</small></div>
                <div><strong>{state.relatedMinutes}</strong><small>related min</small></div>
                <div><strong>{state.breakMinutes}</strong><small>break min</small></div>
              </div>
            </article>

            <article className="card task-card">
              <div className="card-head"><span>Today’s priorities</span><span>{state.tasks.filter((task) => task.status === "completed").length}/{state.tasks.length} complete</span></div>
              <ul>{state.tasks.map((task) => <li key={task.id} className={task.status}><button onClick={() => void completeTask(task.id)} aria-label={`Mark ${task.title} complete`}>{task.status === "completed" ? "✓" : task.status === "active" ? "→" : ""}</button><button className="task-copy" disabled={task.status === "completed"} onClick={() => void activateTask(task.id)}><strong>{task.title}</strong><small>{task.priority} · {task.estimatedMinutes} min estimate</small></button></li>)}</ul>
            </article>

            <article className="card plan-card">
              <p className="eyebrow">Plan with Gemma</p><h2>What needs to happen today?</h2>
              <form onSubmit={submitPlan}><textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Finish the collector, record a demo, and draft the DEV post…" /><button type="submit" className="primary">Structure my plan <span>⌘↵</span></button></form>
            </article>
          </section>
          <div className="status-line" role="status">{notice}</div>
        </div>
      ) : (
        <div className="shell about-page">
          <section className="about-hero"><span className="about-logo brand-mark" aria-hidden="true">F</span><p className="eyebrow">Focus Agent</p><h1>Built for Raj.<br />Private by design.</h1><p>Your activity is evidence, not a verdict. Focus Agent asks before it assumes.</p></section>
          <section className="about-grid">
            <article className="card"><p className="eyebrow">Why it exists</p><h2>Attention needs context.</h2><p>Raj is a talented developer who can lose sight of the day’s priorities when a new idea or distraction appears. This agent keeps the plan visible and offers a gentle correction without pretending to know more than it does.</p></article>
            <article className="card"><p className="eyebrow">Privacy</p><h2>Local means local.</h2><p>Window titles are discarded by default. Activity, tasks, corrections, and break history stay in an on-device SQLite database. No behavioral profile is uploaded to a remote model.</p></article>
            <article className="card"><p className="eyebrow">How it works</p><h2>Evidence, then confirmation.</h2><p>KWin reports application changes over D-Bus. Focus Agent compares that evidence with the active priority, while Raj remains the authority on whether work is relevant or complete.</p></article>
            <article className="card runtime-card"><p className="eyebrow">Runtime</p><h2>{state.modelAvailable ? "Gemma is ready." : "Gemma is offline."}</h2><ul><li><span>Model</span><strong>{state.modelName ?? "Deterministic fallback"}</strong></li><li><span>Storage</span><strong>SQLite · on device</strong></li><li><span>Desktop</span><strong>Electron · KDE Wayland</strong></li><li><span>Last plan</span><strong>{state.planSource}</strong></li><li><span>Last activity reasoning</span><strong>{state.lastReasoning ? `${state.lastReasoning.source}${state.lastReasoning.latencyMs ? ` · ${state.lastReasoning.latencyMs}ms` : ""}` : "Not run yet"}</strong></li></ul></article>
          </section>
          <div className="about-footer"><span>Open-weight AI at the core</span><span>Built for Hacktoberfest Weekend Challenge</span></div>
        </div>
      )}
      {intervention && (
        <section className={`intervention intervention-level-${intervention.level}`} role="alertdialog" aria-modal={intervention.level >= 3} aria-labelledby="intervention-title">
          <div className="intervention-card">
            <button className="intervention-dismiss" aria-label="Dismiss for now" onClick={() => void answerIntervention("not_now")}>×</button>
            <p className="eyebrow">Focus check · level {intervention.level}</p>
            <h2 id="intervention-title">{intervention.level >= 5 ? "Your attention needs a reset." : "Still on the same path?"}</h2>
            <p className="intervention-message">{intervention.message}</p>
            {intervention.reasoningSource === "gemma" && <div className="intervention-reasoning"><span>Reasoned locally by {intervention.reasoningModel ?? "Gemma"}</span>{intervention.reasoningReason && <details><summary>Why?</summary><p>{intervention.reasoningReason}</p></details>}</div>}
            {intervention.level >= 4 && <div className="intervention-context"><div><span>Active priority</span><strong>{intervention.taskTitle}</strong></div><div><span>Current application</span><strong>{intervention.application}</strong></div><div><span>Current session</span><strong>{intervention.durationMinutes} min</strong></div></div>}
            {intervention.level >= 5 && <div className="intervention-stats"><div><strong>{intervention.stats.focusedMinutes}</strong><span>focused min</span></div><div><strong>{intervention.stats.relatedMinutes}</strong><span>related min</span></div><div><strong>{intervention.stats.breakMinutes}</strong><span>break min</span></div></div>}
            <div className="intervention-actions">
              <button className="primary-action" onClick={() => void answerIntervention("resume")}>Back to priority</button>
              <button onClick={() => void answerIntervention("still_related")}>Still related</button>
              {intervention.level >= 2 && <button onClick={() => void answerIntervention("break", 15)}>Take 15m break</button>}
              {intervention.level >= 3 && <button disabled={!nextPlannedTask} onClick={() => nextPlannedTask && void answerIntervention("switch_task", nextPlannedTask.id)}>Switch task</button>}
              {intervention.level >= 2 && <button onClick={() => setInterventionPauseOpen((open) => !open)}>Pause tracker</button>}
            </div>
            {interventionPauseOpen && <div className="intervention-pause-options">{pauseOptions.map((option) => <button key={option.label} onClick={() => void answerIntervention("pause", option.value)}>{option.label}</button>)}</div>}
          </div>
        </section>
      )}
    </main>
  );
}

export default App;
