/**
 * V3 Extended Types - Detailed type definitions for agent, task, swarm, memory, MCP
 */

import type { TaskPriority } from '../shared/types';

// =============================================================================
// Agent Extended Types
// =============================================================================

export interface AgentProfile {
  id: string;
  role: string;
  capabilities: string[];
  permissions: AgentPermissions;
  [key: string]: unknown;
}

export interface AgentPermissions {
  canSpawn: boolean;
  canTerminate: boolean;
  canAccessMemory: boolean;
  canExecuteCommands: boolean;
  [key: string]: unknown;
}

export interface AgentSpawnOptions {
  role: string;
  name?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface AgentSpawnResult {
  agentId: string;
  success: boolean;
  error?: string;
}

export interface AgentTerminationOptions {
  agentId: string;
  force?: boolean;
  reason?: string;
}

export interface AgentTerminationResult {
  agentId: string;
  success: boolean;
  error?: string;
}

export interface AgentHealthCheckResult {
  agentId: string;
  healthy: boolean;
  latency: number;
  [key: string]: unknown;
}

export interface AgentBatchResult {
  results: Array<{ agentId: string; success: boolean; error?: string }>;
  totalSuccess: number;
  totalFailed: number;
}

export interface AgentEventPayloads {
  spawned: { agentId: string };
  terminated: { agentId: string; reason?: string };
  error: { agentId: string; error: unknown };
  [key: string]: unknown;
}

// =============================================================================
// Task Extended Types
// =============================================================================

export interface TaskInput {
  type: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  [key: string]: unknown;
}

export interface TaskMetadata {
  createdAt: Date;
  updatedAt: Date;
  assignedTo?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface TaskExecutionContext {
  taskId: string;
  agentId: string;
  startedAt: Date;
  [key: string]: unknown;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  duration: number;
  [key: string]: unknown;
}

export interface TaskArtifact {
  id: string;
  taskId: string;
  type: string;
  path?: string;
  content?: unknown;
}

export interface TaskQueueConfig {
  maxSize: number;
  prioritySort: boolean;
  [key: string]: unknown;
}

export interface TaskAssignmentConfig {
  strategy: 'round-robin' | 'least-loaded' | 'capability-match';
  [key: string]: unknown;
}

export interface TaskRetryPolicy {
  maxRetries: number;
  backoffMs: number;
  [key: string]: unknown;
}

export interface TaskFilter {
  status?: string;
  priority?: TaskPriority;
  assignedTo?: string;
  [key: string]: unknown;
}

export interface TaskSortOptions {
  field: string;
  direction: 'asc' | 'desc';
}

export interface TaskQueryOptions {
  filter?: TaskFilter;
  sort?: TaskSortOptions;
  limit?: number;
  offset?: number;
}

export interface TaskEventPayloads {
  created: { taskId: string };
  completed: { taskId: string };
  failed: { taskId: string; error: unknown };
  [key: string]: unknown;
}

// =============================================================================
// Swarm Extended Types
// =============================================================================

export interface SwarmInitOptions {
  topology?: string;
  maxAgents?: number;
  [key: string]: unknown;
}

export interface SwarmInitResult {
  success: boolean;
  agentCount: number;
  topology: string;
}

export interface SwarmScaleOptions {
  targetAgents: number;
  strategy?: string;
}

export interface SwarmScaleResult {
  previousCount: number;
  newCount: number;
  success: boolean;
}

export interface SwarmMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: unknown;
  timestamp: Date;
}

export interface ConsensusRequest {
  proposalId: string;
  type: string;
  data: unknown;
}

export interface ConsensusResponse {
  proposalId: string;
  accepted: boolean;
  votes: number;
}

export interface DistributedLock {
  id: string;
  holder: string;
  resource: string;
  expiresAt: Date;
}

export interface LockAcquisitionResult {
  acquired: boolean;
  lock?: DistributedLock;
}

export interface DeadlockDetectionResult {
  hasDeadlock: boolean;
  cycle?: string[];
}

export interface SwarmMetrics {
  agents: number;
  tasks: number;
  messagesSent: number;
  uptime: number;
  [key: string]: unknown;
}

export interface SwarmEventPayloads {
  initialized: { topology: string };
  agentJoined: { agentId: string };
  agentLeft: { agentId: string };
  [key: string]: unknown;
}

// =============================================================================
// Memory Extended Types
// =============================================================================

export interface MemoryBackendConfig {
  type: 'sqlite' | 'postgres' | 'hybrid';
  path?: string;
  connectionString?: string;
  [key: string]: unknown;
}

export interface MemoryStoreOptions {
  namespace?: string;
  ttl?: number;
  tags?: string[];
}

export interface MemoryRetrieveOptions {
  namespace?: string;
}

export interface MemoryListOptions {
  namespace?: string;
  limit?: number;
  offset?: number;
}

export interface MemorySearchOptions {
  query: string;
  namespace?: string;
  k?: number;
  threshold?: number;
}

export interface MemoryBatchOperation {
  type: 'store' | 'retrieve' | 'delete';
  key: string;
  value?: unknown;
  namespace?: string;
}

export interface MemoryBatchResult {
  results: Array<{ key: string; success: boolean; error?: string }>;
  totalSuccess: number;
  totalFailed: number;
}

export interface MemoryStats {
  totalEntries: number;
  totalNamespaces: number;
  storageSize: number;
  [key: string]: unknown;
}

export interface MemoryBankStats {
  banks: number;
  totalEntries: number;
  [key: string]: unknown;
}

export interface LearnedPattern {
  id: string;
  pattern: string;
  confidence: number;
  usageCount: number;
  [key: string]: unknown;
}

export interface PatternSearchResult {
  pattern: LearnedPattern;
  score: number;
}

export interface MemoryEventPayloads {
  stored: { key: string; namespace?: string };
  retrieved: { key: string };
  deleted: { key: string };
  [key: string]: unknown;
}

export interface CacheConfig {
  maxSize: number;
  ttl: number;
  [key: string]: unknown;
}

export interface VectorIndexConfig {
  type: 'hnsw' | 'flat';
  dimensions: number;
  metric: 'cosine' | 'euclidean';
  [key: string]: unknown;
}

export interface FlashAttentionConfig {
  enabled: boolean;
  headDim: number;
  numHeads: number;
  [key: string]: unknown;
}

// =============================================================================
// MCP Extended Types
// =============================================================================

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: MCPToolHandler;
}

export type MCPToolHandler = (params: Record<string, unknown>) => Promise<MCPToolResult>;

export interface MCPToolResult {
  content: MCPContent[];
  isError?: boolean;
}

export interface MCPContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface MCPServerConfig {
  transport: 'stdio' | 'sse' | 'http';
  port?: number;
  host?: string;
  [key: string]: unknown;
}

export interface MCPTransportConfig {
  type: 'stdio' | 'sse' | 'http';
  options?: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface MCPCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  [key: string]: unknown;
}

export interface MCPRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPResponse {
  result?: unknown;
  error?: MCPError;
}

export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPEventPayloads {
  toolCalled: { tool: string; params: Record<string, unknown> };
  resourceAccessed: { uri: string };
  [key: string]: unknown;
}

export type MCPServerStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

// =============================================================================
// Utility Functions
// =============================================================================

export function priorityToNumber(priority: TaskPriority): number {
  const map: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  return map[priority] ?? 2;
}

export function numberToPriority(num: number): TaskPriority {
  const map: TaskPriority[] = ['critical', 'high', 'normal', 'low'];
  return map[num] ?? 'normal';
}

export const TopologyPresets = {
  small: { topology: 'hierarchical', maxAgents: 4 },
  medium: { topology: 'hierarchical', maxAgents: 8 },
  large: { topology: 'hierarchical-mesh', maxAgents: 15 },
} as const;
