/**
 * Agent Registry - Stub for V3 agent registration and discovery
 */

import type { AgentId, AgentState, AgentDefinition } from '../shared/types';

export interface HealthStatus {
  healthy: boolean;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

export interface IAgentRegistry {
  register(definition: AgentDefinition): void;
  unregister(agentId: AgentId): void;
  get(agentId: AgentId): AgentState | undefined;
  list(): AgentState[];
  getHealth(agentId: AgentId): HealthStatus | undefined;
}

export class AgentRegistry implements IAgentRegistry {
  private agents = new Map<AgentId, AgentState>();
  private health = new Map<AgentId, HealthStatus>();

  register(definition: AgentDefinition): void {
    this.agents.set(definition.id, { id: definition.id, status: 'idle' });
    this.health.set(definition.id, { healthy: true, lastCheck: new Date() });
  }

  unregister(agentId: AgentId): void {
    this.agents.delete(agentId);
    this.health.delete(agentId);
  }

  get(agentId: AgentId): AgentState | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentState[] {
    return Array.from(this.agents.values());
  }

  getHealth(agentId: AgentId): HealthStatus | undefined {
    return this.health.get(agentId);
  }
}

export function createAgentRegistry(): IAgentRegistry {
  return new AgentRegistry();
}
