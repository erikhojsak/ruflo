/**
 * Event Interface - System event type constants
 */

export const SystemEventTypes = {
  AGENT_SPAWNED: 'agent:spawned',
  AGENT_TERMINATED: 'agent:terminated',
  AGENT_STATUS_CHANGED: 'agent:statusChanged',
  AGENT_ERROR: 'agent:error',
  TASK_CREATED: 'task:created',
  TASK_ASSIGNED: 'task:assigned',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  SWARM_INITIALIZED: 'swarm:initialized',
  SWARM_SHUTDOWN: 'swarm:shutdown',
  MEMORY_STORED: 'memory:stored',
  MEMORY_RETRIEVED: 'memory:retrieved',
} as const;

export type SystemEventType = (typeof SystemEventTypes)[keyof typeof SystemEventTypes];
