import { FormEvent, useEffect, useMemo, useState } from "react";
import type { DashboardState, FocusTask } from "./types";

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
  },
  focusedMinutes: 74,
  relatedMinutes: 18,
  breakMinutes: 12,
  monitoringPaused: false,
  modelAvailable: false,
};

const hasDesktopRuntime = () => Boolean(window.focusAgent);

function App() {
  const [state, setState] = useState<DashboardState>(fallbackState);
  const [plan, setPlan] = useState("");
  const [notice, setNotice] = useState("Monitoring stays on this device");

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
    if (!hasDesktopRuntime()) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
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
        await window.focusAgent!.createPlan(plan);
        setNotice("Plan structured locally");
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

  const toggleMonitoring = async () => {
    const paused = !state.monitoringPaused;
    if (hasDesktopRuntime()) await window.focusAgent!.setMonitoringPaused(paused);
    setState((current) => ({ ...current, monitoringPaused: paused }));
    setNotice(paused ? "Monitoring paused" : "Monitoring resumed");
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <div><strong>Focus Agent</strong><small>for Raj · private by design</small></div>
        </div>
        <button className={`monitor ${state.monitoringPaused ? "paused" : ""}`} onClick={toggleMonitoring}>
          <span className="pulse" /> {state.monitoringPaused ? "Resume monitoring" : "Monitoring locally"}
        </button>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Current intention</p>
          <h1>{activeTask?.title ?? "Choose what matters now"}</h1>
          <p className="hero-copy">Your activity is evidence, not a verdict. Focus Agent asks before it assumes.</p>
        </div>
        <div className={`orb ${state.activity.classification}`}><span>{state.activity.durationMinutes}m</span><small>in flow</small></div>
      </section>

      <section className="grid">
        <article className="card activity-card">
          <div className="card-head"><span>Live trajectory</span><span className="confidence">{Math.round(state.activity.confidence * 100)}% confidence</span></div>
          <h2>{state.activity.application}</h2>
          <div className="trajectory"><span className="trajectory-dot" /><strong>{state.activity.classification.replace("_", " ")}</strong><span>associated with your active priority</span></div>
          <div className="actions"><button>Still related</button><button>Take a break</button><button className="ghost">Switch task</button></div>
        </article>

        <article className="card stats-card">
          <div className="card-head"><span>Today, honestly</span><span>local time</span></div>
          <div className="stats">
            <div><strong>{state.focusedMinutes}</strong><small>focused min</small></div>
            <div><strong>{state.relatedMinutes}</strong><small>related min</small></div>
            <div><strong>{state.breakMinutes}</strong><small>break min</small></div>
          </div>
          <p>No invented progress percentage. Raj confirms completion; the agent only presents evidence.</p>
        </article>

        <article className="card task-card">
          <div className="card-head"><span>Today’s priorities</span><span>{state.tasks.filter((task) => task.status === "completed").length}/{state.tasks.length} complete</span></div>
          <ul>
            {state.tasks.map((task) => <li key={task.id} className={task.status}><button aria-label={`Mark ${task.title} complete`}>{task.status === "completed" ? "✓" : task.status === "active" ? "→" : ""}</button><div><strong>{task.title}</strong><small>{task.priority} · {task.estimatedMinutes} min estimate</small></div></li>)}
          </ul>
        </article>

        <article className="card plan-card">
          <p className="eyebrow">Plan with Gemma</p>
          <h2>What needs to happen today?</h2>
          <form onSubmit={submitPlan}>
            <textarea value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Finish the collector, record a demo, and draft the DEV post…" />
            <button type="submit" className="primary">Structure my plan <span>⌘↵</span></button>
          </form>
          <div className="privacy-line"><span>●</span> {state.modelAvailable ? "Gemma is ready locally" : "Gemma adapter ready · start Ollama to connect"}</div>
        </article>
      </section>

      <footer><span>{notice}</span><span>Open-weight AI · SQLite · KDE Wayland</span></footer>
    </main>
  );
}

export default App;
