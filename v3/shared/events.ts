/**
 * Shared Events - Stub declarations for V3 event system
 */

import type { SwarmEvent, EventHandler, AgentId, TaskId } from './types';

// =============================================================================
// Event Bus Interface
// =============================================================================

export interface IEventBus {
  emit(event: SwarmEvent): void;
  on(type: string, handler: EventHandler): void;
  off(type: string, handler: EventHandler): void;
  once(type: string, handler: EventHandler): void;
}

export interface IEventStore {
  append(event: SwarmEvent): void;
  getEvents(filter?: EventFilter): SwarmEvent[];
  getSnapshot(): EventStoreSnapshot;
}

export interface EventFilter {
  type?: string;
  after?: Date;
  before?: Date;
  [key: string]: unknown;
}

export interface EventStoreSnapshot {
  events: SwarmEvent[];
  version: number;
  timestamp: Date;
}

// =============================================================================
// Event Bus Implementation
// =============================================================================

export class EventBus implements IEventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  emit(event: SwarmEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }

  on(type: string, handler: EventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: string, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  once(type: string, handler: EventHandler): void {
    const wrappedHandler: EventHandler = (event) => {
      this.off(type, wrappedHandler);
      return handler(event);
    };
    this.on(type, wrappedHandler);
  }
}

export class InMemoryEventStore implements IEventStore {
  private events: SwarmEvent[] = [];
  private version = 0;

  append(event: SwarmEvent): void {
    this.events.push(event);
    this.version++;
  }

  getEvents(filter?: EventFilter): SwarmEvent[] {
    if (!filter) return [...this.events];
    return this.events.filter(e => {
      if (filter.type && e.type !== filter.type) return false;
      if (filter.after && e.timestamp < filter.after) return false;
      if (filter.before && e.timestamp > filter.before) return false;
      return true;
    });
  }

  getSnapshot(): EventStoreSnapshot {
    return { events: [...this.events], version: this.version, timestamp: new Date() };
  }
}

// =============================================================================
// Event Factory Functions
// =============================================================================

export function createEvent(type: string, data: unknown): SwarmEvent {
  return { type, timestamp: new Date(), data };
}

export function agentSpawnedEvent(agentId: AgentId, data?: unknown): SwarmEvent {
  return createEvent('agent:spawned', { agentId, ...data as object });
}

export function agentStatusChangedEvent(agentId: AgentId, status: string): SwarmEvent {
  return createEvent('agent:statusChanged', { agentId, status });
}

export function agentTaskAssignedEvent(agentId: AgentId, taskId: TaskId): SwarmEvent {
  return createEvent('agent:taskAssigned', { agentId, taskId });
}

export function agentTaskCompletedEvent(agentId: AgentId, taskId: TaskId): SwarmEvent {
  return createEvent('agent:taskCompleted', { agentId, taskId });
}

export function agentErrorEvent(agentId: AgentId, error: unknown): SwarmEvent {
  return createEvent('agent:error', { agentId, error });
}

export function taskCreatedEvent(taskId: TaskId): SwarmEvent {
  return createEvent('task:created', { taskId });
}

export function taskQueuedEvent(taskId: TaskId): SwarmEvent {
  return createEvent('task:queued', { taskId });
}

export function taskAssignedEvent(taskId: TaskId, agentId: AgentId): SwarmEvent {
  return createEvent('task:assigned', { taskId, agentId });
}

export function taskStartedEvent(taskId: TaskId): SwarmEvent {
  return createEvent('task:started', { taskId });
}

export function taskCompletedEvent(taskId: TaskId): SwarmEvent {
  return createEvent('task:completed', { taskId });
}

export function taskFailedEvent(taskId: TaskId, error: unknown): SwarmEvent {
  return createEvent('task:failed', { taskId, error });
}

export function taskBlockedEvent(taskId: TaskId, reason: string): SwarmEvent {
  return createEvent('task:blocked', { taskId, reason });
}

export function swarmInitializedEvent(data?: unknown): SwarmEvent {
  return createEvent('swarm:initialized', data);
}

export function swarmPhaseChangedEvent(phaseId: string): SwarmEvent {
  return createEvent('swarm:phaseChanged', { phaseId });
}

export function swarmMilestoneReachedEvent(milestoneId: string): SwarmEvent {
  return createEvent('swarm:milestoneReached', { milestoneId });
}

export function swarmErrorEvent(error: unknown): SwarmEvent {
  return createEvent('swarm:error', { error });
}
