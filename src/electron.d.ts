import type { DashboardState } from "./types";

declare global {
  interface Window {
    focusAgent?: {
      getDashboard(): Promise<DashboardState>;
      createPlan(input: string): Promise<void>;
      setMonitoringPaused(paused: boolean): Promise<void>;
    };
  }
}

export {};
