export type TaskStatus = "planned" | "active" | "completed";

export interface FocusTask {
  id: number;
  title: string;
  priority: "high" | "medium" | "low";
  estimatedMinutes: number;
  status: TaskStatus;
}

export interface ActivityState {
  application: string;
  since: string;
  durationMinutes: number;
  classification: "focus" | "related" | "neutral" | "distraction" | "break" | "possible_drift" | "unknown";
  confidence: number;
  activeTaskId: number | null;
  sessionId: number | null;
  reasoningSource: "user" | "gemma" | "deterministic";
  trajectory: string;
}

export interface DashboardState {
  tasks: FocusTask[];
  activity: ActivityState;
  focusedMinutes: number;
  relatedMinutes: number;
  breakMinutes: number;
  monitoringPaused: boolean;
  monitoringPauseMode: "timed" | "indefinite" | null;
  monitoringPauseUntil: string | null;
  modelAvailable: boolean;
  modelName: string | null;
  planSource: string;
  lastReasoning: {
    source: string;
    model: string | null;
    latencyMs: number | null;
    status: string;
    createdAt: string;
  } | null;
}

export interface InterventionState {
  id: number;
  sessionId: number;
  level: number;
  createdAt: string;
  taskId: number;
  taskTitle: string;
  application: string;
  durationMinutes: number;
  message: string;
  reasoningSource: string;
  reasoningModel: string | null;
  reasoningReason: string | null;
  stats: Pick<DashboardState, "focusedMinutes" | "relatedMinutes" | "breakMinutes">;
}
