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
  classification: "focus" | "related" | "break" | "possible_drift" | "unknown";
  confidence: number;
  activeTaskId: number | null;
}

export interface DashboardState {
  tasks: FocusTask[];
  activity: ActivityState;
  focusedMinutes: number;
  relatedMinutes: number;
  breakMinutes: number;
  monitoringPaused: boolean;
  modelAvailable: boolean;
}
