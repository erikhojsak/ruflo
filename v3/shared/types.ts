/**
 * Shared Types - Stub declarations for V3 core types
 *
 * These types are used across the V3 codebase. They will be fully
 * implemented as part of the V3 core architecture buildout.
 */

// =============================================================================
// Agent Types
// =============================================================================

export type AgentId = string;
export type AgentRole = string;
export type AgentDomain = 'security' | 'core' | 'integration' | 'quality' | 'performance' | 'deployment';
export type AgentStatus = 'idle' | 'busy' | 'error' | 'terminated';

export interface AgentDefinition {
  id: AgentId;
  role: AgentRole;
  domain: AgentDomain;
  capabilities: AgentCapability[];
  [key: string]: unknown;
}

export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  currentTask?: TaskId;
  metrics?: AgentMetrics;
  [key: string]: unknown;
}

export interface AgentCapability {
  name: string;
  version: string;
  [key: string]: unknown;
}

export interface AgentMetrics {
  tasksCompleted: number;
  tasksFailed: number;
  averageTaskDuration: number;
  [key: string]: unknown;
}

// =============================================================================
// Task Types
// =============================================================================

export type TaskId = string;
export type TaskType = string;
export type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'blocked';
export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

export interface TaskDefinition {
  id: TaskId;
  type: TaskType;
  title: string;
  description: string;
  priority: TaskPriority;
  [key: string]: unknown;
}

export interface TaskMetadata {
  createdAt: Date;
  updatedAt: Date;
  assignedTo?: AgentId;
  [key: string]: unknown;
}

export interface TaskResult {
  taskId: TaskId;
  success: boolean;
  output?: unknown;
  metrics?: TaskResultMetrics;
  [key: string]: unknown;
}

export interface TaskResultMetrics {
  duration: number;
  tokensUsed: number;
  [key: string]: unknown;
}

// =============================================================================
// Phase Types
// =============================================================================

export type PhaseId = string;

export interface PhaseDefinition {
  id: PhaseId;
  name: string;
  [key: string]: unknown;
}

export interface MilestoneDefinition {
  id: string;
  name: string;
  criteria: MilestoneCriteria[];
  status: MilestoneStatus;
  [key: string]: unknown;
}

export type MilestoneStatus = 'pending' | 'in-progress' | 'completed';

export interface MilestoneCriteria {
  description: string;
  met: boolean;
  [key: string]: unknown;
}

// =============================================================================
// Swarm Types
// =============================================================================

export type TopologyType = 'hierarchical-mesh' | 'mesh' | 'hierarchical' | 'centralized';
export type LoadBalancingStrategy = 'round-robin' | 'least-loaded' | 'capability-match' | 'domain-affinity';

export interface SwarmConfig {
  topology: TopologyType;
  maxAgents: number;
  [key: string]: unknown;
}

export interface SwarmState {
  agents: Map<AgentId, AgentState>;
  topology: TopologyType;
  [key: string]: unknown;
}

export interface SwarmMetrics {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  [key: string]: unknown;
}

// =============================================================================
// Event Types
// =============================================================================

export type EventType = string;

export interface SwarmEvent {
  type: EventType;
  timestamp: Date;
  data: unknown;
  [key: string]: unknown;
}

export type EventHandler = (event: SwarmEvent) => void | Promise<void>;

// =============================================================================
// Message Types
// =============================================================================

export type MessageType = string;

export interface SwarmMessage {
  type: MessageType;
  from: AgentId;
  to: AgentId;
  payload: unknown;
  [key: string]: unknown;
}

export type MessageHandler = (message: SwarmMessage) => void | Promise<void>;

// =============================================================================
// Performance Types
// =============================================================================

export interface PerformanceTargets {
  flashAttentionSpeedup: string;
  agentDbSearchImprovement: string;
  memoryReduction: string;
  codeReduction: string;
  startupTime: string;
  [key: string]: unknown;
}

export const V3_PERFORMANCE_TARGETS: PerformanceTargets = {
  flashAttentionSpeedup: '2.49x-7.47x',
  agentDbSearchImprovement: '150x-12,500x',
  memoryReduction: '50-75%',
  codeReduction: '<5,000 lines',
  startupTime: '<500ms',
};

// =============================================================================
// Utility Types
// =============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type AsyncCallback<T = void> = (...args: any[]) => Promise<T>;

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}
