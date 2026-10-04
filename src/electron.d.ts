import type { DashboardState, InterventionState } from "./types";

declare global {
  interface Window {
    focusAgent?: {
      getDashboard(): Promise<DashboardState>;
      createPlan(input: string): Promise<{ source: string }>;
      setMonitoringPaused(paused: boolean): Promise<void>;
      pauseMonitoring(minutes: number | null): Promise<void>;
      resumeMonitoring(): Promise<void>;
      completeTask(taskId: number): Promise<void>;
      activateTask(taskId: number): Promise<void>;
      markCurrentRelated(sessionId: number, taskId: number): Promise<{ updated: boolean; sessionId?: number; application?: string }>;
      startBreak(minutes: number): Promise<void>;
      minimizeWindow(): Promise<void>;
      toggleMaximizeWindow(): Promise<boolean>;
      closeWindow(): Promise<void>;
      getActiveIntervention(): Promise<InterventionState | null>;
      respondToIntervention(id: number, action: string, value?: number | null): Promise<void>;
      onIntervention(callback: (intervention: InterventionState | null) => void): () => void;
    };
  }
}

export {};
