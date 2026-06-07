import type { AgentStageEvent } from "../../shared/agent-contracts";

export type TriangleStage = AgentStageEvent["stage"];

export interface TriangleStepInput {
  stage: TriangleStage;
  title: string;
  detail: string;
}

export class TriangleTrace {
  private readonly events: AgentStageEvent[] = [];

  record(input: TriangleStepInput): void {
    this.events.push({
      ...input,
      timestamp: new Date().toISOString()
    });
  }

  snapshot(): AgentStageEvent[] {
    return [...this.events];
  }
}
