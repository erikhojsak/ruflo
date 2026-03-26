/**
 * Core Interfaces - Stub declarations for V3 core architecture
 */

// =============================================================================
// Task Interfaces
// =============================================================================

export interface ITask {
  id: string;
  type: string;
  status: string;
  [key: string]: unknown;
}

export interface ITaskCreate {
  type: string;
  title: string;
  description?: string;
  [key: string]: unknown;
}

export interface ITaskResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  [key: string]: unknown;
}

export interface ITaskManager {
  create(task: ITaskCreate): Promise<ITask>;
  get(taskId: string): Promise<ITask | undefined>;
  complete(taskId: string, result: ITaskResult): Promise<void>;
}

export interface ITaskQueue {
  enqueue(task: ITask): void;
  dequeue(): ITask | undefined;
  size(): number;
}

export interface TaskManagerMetrics {
  total: number;
  completed: number;
  failed: number;
  [key: string]: unknown;
}

// =============================================================================
// Agent Interfaces
// =============================================================================

export interface IAgent {
  id: string;
  role: string;
  status: string;
  [key: string]: unknown;
}

export interface IAgentConfig {
  role: string;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface IAgentSession {
  agentId: string;
  startedAt: Date;
  [key: string]: unknown;
}

export interface IAgentPool {
  acquire(): Promise<IAgent>;
  release(agent: IAgent): void;
  size(): number;
}

export interface IAgentLifecycleManager {
  spawn(config: IAgentConfig): Promise<IAgent>;
  terminate(agentId: string): Promise<void>;
}

export interface IAgentRegistry {
  register(agent: IAgent): void;
  unregister(agentId: string): void;
  get(agentId: string): IAgent | undefined;
  list(): IAgent[];
}

export interface IAgentCapability {
  name: string;
  version: string;
  [key: string]: unknown;
}

// =============================================================================
// Event Interfaces
// =============================================================================

export interface IEvent {
  id: string;
  type: string;
  timestamp: Date;
  data: unknown;
}

export interface IEventCreate {
  type: string;
  data: unknown;
}

export interface IEventBus {
  emit(event: IEvent): void;
  on(type: string, handler: IEventHandler): void;
  off(type: string, handler: IEventHandler): void;
}

export type IEventHandler = (event: IEvent) => void | Promise<void>;

export interface IEventSubscription {
  unsubscribe(): void;
}

export interface IEventFilter {
  type?: string;
  after?: Date;
  before?: Date;
}

export interface IEventStore {
  append(event: IEvent): void;
  getEvents(filter?: IEventFilter): IEvent[];
}

export interface IEventCoordinator {
  coordinate(events: IEvent[]): Promise<void>;
}

// =============================================================================
// Memory Interfaces
// =============================================================================

export interface IMemoryEntry {
  id: string;
  key: string;
  value: unknown;
  namespace?: string;
  [key: string]: unknown;
}

export interface IMemoryEntryCreate {
  key: string;
  value: unknown;
  namespace?: string;
  [key: string]: unknown;
}

export interface IMemoryBackend {
  store(entry: IMemoryEntryCreate): Promise<IMemoryEntry>;
  retrieve(key: string, namespace?: string): Promise<IMemoryEntry | undefined>;
  search(query: string, options?: IVectorSearchParams): Promise<IVectorSearchResult[]>;
  delete(key: string, namespace?: string): Promise<boolean>;
}

export interface IVectorMemoryBackend extends IMemoryBackend {
  vectorSearch(params: IVectorSearchParams): Promise<IVectorSearchResult[]>;
}

export interface IMemoryBank {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface IMemoryManager {
  getBackend(): IMemoryBackend;
  getBank(name: string): IMemoryBank;
}

export interface IPatternStorage {
  store(pattern: unknown): Promise<string>;
  search(query: string): Promise<unknown[]>;
}

export interface IVectorSearchParams {
  query: string;
  k?: number;
  threshold?: number;
  namespace?: string;
  [key: string]: unknown;
}

export interface IVectorSearchResult {
  id: string;
  score: number;
  entry: IMemoryEntry;
  [key: string]: unknown;
}

// =============================================================================
// Coordinator Interfaces
// =============================================================================

export interface ISwarmConfig {
  topology: string;
  maxAgents: number;
  [key: string]: unknown;
}

export interface ISwarmState {
  initialized: boolean;
  agentCount: number;
  [key: string]: unknown;
}

export interface ICoordinator {
  initialize(config?: ISwarmConfig): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ICoordinationManager {
  getCoordinator(): ICoordinator;
}

export interface IHealthMonitor {
  check(): Promise<IHealthStatus>;
}

export interface IMetricsCollector {
  collect(): IOrchestratorMetrics;
}

export interface IHealthStatus {
  healthy: boolean;
  components: IComponentHealth[];
}

export interface IComponentHealth {
  name: string;
  healthy: boolean;
  message?: string;
}

export interface IOrchestratorMetrics {
  agents: number;
  tasks: number;
  uptime: number;
  [key: string]: unknown;
}
