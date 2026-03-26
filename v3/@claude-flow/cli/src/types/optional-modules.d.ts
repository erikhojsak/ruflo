/**
 * Ambient type declarations for optional runtime-imported modules.
 *
 * These modules are dynamically imported at runtime and may or may not
 * be installed. They are NOT bundled — users install them as needed.
 * Declaring them here prevents TS2307 in strict pnpm CI builds where
 * hoisted node_modules are not available.
 */

declare module 'pg' {
  const pg: any;
  export default pg;
  export const Pool: any;
  export const Client: any;
}

declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: any[]): Database;
    exec(sql: string, params?: any[]): any[];
    each(sql: string, params: any[], callback: (row: any) => void, done: () => void): Database;
    prepare(sql: string): any;
    close(): void;
    getRowsModified(): number;
    export(): Uint8Array;
  }
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  export type { Database };
  export default function initSqlJs(config?: any): Promise<SqlJsStatic>;
}

declare module 'agentic-flow' {
  export const reasoningbank: any;
}

declare module 'agentic-flow/reasoningbank' {
  export const VERSION: string;
  export const PAPER_URL: string;
  export class ReflexionMemory { constructor(...args: any[]); }
  export class SkillLibrary { constructor(...args: any[]); }
  export class CausalMemoryGraph { constructor(...args: any[]); }
  export class HybridReasoningBank { constructor(...args: any[]); }
  export class AdvancedMemorySystem { constructor(...args: any[]); }
  export class EmbeddingService { constructor(...args: any[]); }
  export class NightlyLearner { constructor(...args: any[]); }
  export function initialize(...args: any[]): Promise<any>;
  export function retrieveMemories(query: string, opts?: any): Promise<any[]>;
  export function formatMemoriesForPrompt(memories: any[]): string;
  export function judgeTrajectory(...args: any[]): any;
  export function distillMemories(...args: any[]): any;
  export function consolidate(...args: any[]): any;
  export function shouldConsolidate(...args: any[]): boolean;
  export function computeEmbedding(text: string): Promise<number[]>;
  export function cosineSimilarity(a: number[], b: number[]): number;
  export function clearEmbeddingCache(): void;
  export function containsPII(text: string): boolean;
  export function scrubPII(text: string): string;
  export function scrubMemory(text: string): string;
  export function mmrSelection(items: any[], query: any, opts?: any): any[];
  export function runTask(...args: any[]): Promise<any>;
  export function loadConfig(): any;
  export const db: any;
  export function CausalRecall(...args: any[]): any;
  export function mattsParallel(...args: any[]): any;
  export function mattsSequential(...args: any[]): any;
}

declare module 'agentic-flow/router' {
  export class ModelRouter { constructor(...args: any[]); route(prompt: string, opts?: any): Promise<any>; getStats(): any; }
  export class AnthropicProvider { constructor(...args: any[]); }
  export class GeminiProvider { constructor(...args: any[]); }
  export class OpenRouterProvider { constructor(...args: any[]); }
  export class ONNXLocalProvider { constructor(...args: any[]); }
  export const CLAUDE_MODELS: any;
  export function getModelName(id: string): string;
  export function listModels(): any[];
  export function mapModelId(id: string): string;
}

declare module 'agentic-flow/orchestration' {
  export function createOrchestrator(...args: any[]): any;
  export function createOrchestrationClient(...args: any[]): any;
  export function seedMemory(...args: any[]): Promise<any>;
  export function searchMemory(...args: any[]): Promise<any>;
  export function harvestMemory(...args: any[]): Promise<any>;
  export function recordLearning(...args: any[]): Promise<any>;
  export function getRunStatus(id: string): Promise<any>;
  export function getRunArtifacts(id: string): Promise<any>;
  export function cancelRun(id: string): Promise<any>;
}

declare module 'agentic-flow/agent-booster' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/intelligence/agent-booster-enhanced' {
  export class EnhancedAgentBooster { constructor(...args: any[]); }
  export function getEnhancedBooster(...args: any[]): any;
  export function enhancedApply(opts: { code: string; edit: string; language?: string }): Promise<{ confidence: number; output: string }>;
  export function benchmark(...args: any[]): Promise<any>;
}

declare module 'agentic-flow/sdk' {
  const sdk: any;
  export default sdk;
}

declare module 'agentic-flow/security' {
  const security: any;
  export default security;
}

declare module 'agentic-flow/transport/quic' {
  const quic: any;
  export default quic;
}

declare module 'ruvector' {
  const ruvector: any;
  export default ruvector;
  export const VectorDB: any;
  export const VectorDb: any;
  export function isWasm(): boolean;

  // ONNX Embedder (ruvector >= 0.2.15, bundled MiniLM-L6-v2)
  export function initOnnxEmbedder(): Promise<void>;
  export function isOnnxAvailable(): boolean;
  export function getOptimizedOnnxEmbedder(): OptimizedOnnxEmbedder | null;

  export interface OptimizedOnnxEmbedder {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    isReady(): boolean;
    getDimension(): number;
    similarity(a: number[], b: number[]): number;
  }

  // AdaptiveEmbedder (ruvector >= 0.2.16, LoRA B=0 fix — identity when untrained)
  export class AdaptiveEmbedder {
    constructor(options?: { useEpisodic?: boolean });
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
    isReady(): boolean;
    getDimension(): number;
    similarity(a: number[], b: number[]): number;
    adapt(quality: number): void;
  }
}

declare module '@ruvector/core' {
  const core: any;
  export default core;
}

declare module '@ruvector/rvagent-wasm' {
  /** Initialize the WASM module (browser — uses fetch for .wasm file). */
  export default function init(): Promise<void>;

  /** Initialize the WASM module synchronously (Node.js — pass bytes from fs). */
  export function initSync(bytes: BufferSource): void;

  /** Browser/Node sandboxed AI agent with virtual filesystem. */
  export class WasmAgent {
    constructor(config_json: string);
    prompt(input: string): Promise<string>;
    set_model_provider(callback: Function): void;
    reset(): void;
    free(): void;
    get_state(): unknown;
    get_todos(): unknown[];
    get_tools(): string[];
    execute_tool(tool_json: string): Promise<{ success: boolean; output: string }>;
    model(): string;
    name(): string | undefined;
    turn_count(): number;
    file_count(): number;
    is_stopped(): boolean;
  }

  /** JavaScript model provider callback wrapper. */
  export class JsModelProvider {
    constructor(callback: Function);
  }

  /** JSON-RPC 2.0 MCP server in WASM. */
  export class WasmMcpServer {
    constructor(agent: WasmAgent);
    handle_request(json_rpc: string): Promise<string>;
    free(): void;
  }

  /** Pre-built agent template gallery (6 templates). */
  export class WasmGallery {
    constructor();
    list(): Array<{
      id: string; name: string; description: string;
      category: string; tags: string[]; version: string;
      author: string; builtin: boolean;
    }>;
    get(id: string): unknown | undefined;
    search(query: string): Array<{
      id: string; name: string; description: string;
      category: string; tags: string[]; relevance: number;
    }>;
    count(): number;
    getCategories(): Record<string, number>;
    listByCategory(category: string): unknown[];
    addCustom(json: string): boolean;
    removeCustom(id: string): boolean;
    exportCustom(): string;
    importCustom(json: string): boolean;
    configure(json: string): boolean;
    getConfig(): unknown;
    setActive(id: string): boolean;
    getActive(): unknown | undefined;
    loadRvf(data: Uint8Array): boolean;
    free(): void;
  }

  /** RVF binary container builder. */
  export class WasmRvfBuilder {
    constructor();
    addPrompt(json: string): void;
    addPrompts(json: string): void;
    addTool(json: string): void;
    addTools(json: string): void;
    addSkill(json: string): void;
    addSkills(json: string): void;
    addCapabilities(json: string): void;
    addMcpTools(json: string): void;
    setOrchestrator(json: string): void;
    build(): Uint8Array;
    free(): void;
  }
}

declare module '@ruvector/ruvllm-wasm' {
  export default function init(): Promise<void>;

  /** Initialize WASM synchronously (Node.js). Must use object form: initSync({ module: bytes }) */
  export function initSync(opts: { module: BufferSource }): void;

  export class RuvLLMWasm {
    constructor();
    initialize(): void;
    initializeWithConfig(config: KvCacheConfigWasm): void;
    isInitialized: boolean;
    getPoolStats(): string;
    reset(): void;
    // NOTE: version() is NOT on RuvLLMWasm — use standalone getVersion()
  }
  export class ChatMessageWasm {
    static system(content: string): ChatMessageWasm;
    static user(content: string): ChatMessageWasm;
    static assistant(content: string): ChatMessageWasm;
    role: string;
    content: string;
  }
  export class ChatTemplateWasm {
    static llama3(): ChatTemplateWasm;
    static mistral(): ChatTemplateWasm;
    static chatml(): ChatTemplateWasm;
    static phi(): ChatTemplateWasm;
    static gemma(): ChatTemplateWasm;
    static custom(template: string): ChatTemplateWasm;
    static detectFromModelId(model_id: string): ChatTemplateWasm;
    format(messages: ChatMessageWasm[]): string;
    name: string;
  }
  export class GenerateConfig {
    constructor();
    maxTokens: number;
    temperature: number;
    topP: number;
    topK: number;
    repetitionPenalty: number;
    addStopSequence(seq: string): void;
    clearStopSequences(): void;
    toJson(): string;
    static fromJson(json: string): GenerateConfig;
  }
  export class HnswRouterWasm {
    constructor(dimensions: number, max_patterns: number);
    /** Requires 3 args: (embedding, name, metadata_json). Panics at ~12+ patterns in v2.0.1. */
    addPattern(embedding: Float32Array, name: string, metadata: string): boolean;
    route(query: Float32Array, k: number): any[];
    setEfSearch(ef: number): void;
    clear(): void;
    toJson(): string;
    static fromJson(json: string): HnswRouterWasm;
    dimensions: number;
  }
  /** Configuration for SonaInstantWasm. Required since v2.0.1 (replaces raw number). */
  export class SonaConfigWasm {
    constructor();
    hiddenDim: number;
    learningRate: number;
    emaDecay: number;
    ewcLambda: number;
    microLoraRank: number;
    patternCapacity: number;
    toJson(): string;
  }
  export class SonaInstantWasm {
    /** v2.0.1: requires SonaConfigWasm, not raw number */
    constructor(config: SonaConfigWasm);
    instantAdapt(quality: number): void;
    recordPattern(embedding: number[], success: boolean): void;
    suggestAction(context: string): string | undefined;
    stats(): any;
    toJson(): string;
    static fromJson(json: string): SonaInstantWasm;
    reset(): void;
  }
  export class KvCacheConfigWasm {
    constructor();
    tailLength: number;
    maxTokens: number;
    numKvHeads: number;
    headDim: number;
  }
  export class KvCacheWasm {
    constructor(config: KvCacheConfigWasm);
    static withDefaults(): KvCacheWasm;
    append(keys: Float32Array, values: Float32Array): void;
    stats(): any;
    clear(): void;
    tokenCount: number;
  }
  /** Configuration for MicroLoraWasm. */
  export class MicroLoraConfigWasm {
    constructor();
    inputDim: number;
    outputDim: number;
    rank: number;
    alpha: number;
  }
  /** Feedback for MicroLoraWasm.adapt(). */
  export class AdaptFeedbackWasm {
    constructor();
    quality: number;
    learningRate: number;
    success: boolean;
  }
  export class MicroLoraWasm {
    constructor(config: MicroLoraConfigWasm);
    /** Transform input through LoRA adapter */
    apply(input: Float32Array): Float32Array;
    /** Adapt weights — v2.0.2: takes (input, feedback), v2.0.1: takes (feedback) */
    adapt(input: Float32Array, feedback: AdaptFeedbackWasm): void;
    adapt(feedback: AdaptFeedbackWasm): void;
    applyUpdates(gradients: Float32Array): void;
    stats(): any;
    reset(): void;
    toJson(): string;
    getConfig(): MicroLoraConfigWasm;
    pendingUpdates(): number;
  }
  export class InferenceArenaWasm {
    constructor(capacity: number);
    static forModel(hidden_dim: number, vocab_size: number, batch_size: number): InferenceArenaWasm;
    reset(): void;
    used: number;
    capacity: number;
    remaining: number;
  }
  export class BufferPoolWasm {
    constructor();
    static withCapacity(max: number): BufferPoolWasm;
    prewarmAll(count: number): void;
    statsJson(): string;
    hitRate: number;
    clear(): void;
  }
  export function getVersion(): string;
  export function isReady(): boolean;
  export function detectChatTemplate(model_id: string): ChatTemplateWasm;
}

declare module '@xenova/transformers' {
  const transformers: any;
  export default transformers;
  export const pipeline: any;
  export const env: any;
}

declare module '@noble/ed25519' {
  export function getPublicKey(privateKey: Uint8Array): Promise<Uint8Array>;
  export function getPublicKeyAsync(privateKey: Uint8Array): Promise<Uint8Array>;
  export function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  export function signAsync(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
  export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  export function verifyAsync(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
  export const etc: any;
  export const utils: any;
}

declare module 'better-sqlite3' {
  namespace Database {
    interface Database {
      prepare(sql: string): any;
      exec(sql: string): any;
      pragma(pragma: string, options?: any): any;
      close(): void;
      [key: string]: any;
    }
    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: Function;
      [key: string]: any;
    }
  }
  function Database(filename: string, options?: Database.Options): Database.Database;
  export = Database;
}

declare module '@ruvector/learning-wasm' {
  const mod: any;
  export default mod;
  export const LearningEngine: any;
  export const PatternMatcher: any;
  export class WasmMicroLoRA { constructor(...args: any[]); [key: string]: any; }
  export class WasmScopedLoRA { constructor(...args: any[]); [key: string]: any; }
  export class WasmTrajectoryBuffer { constructor(...args: any[]); [key: string]: any; }
  export function initSync(bytes: BufferSource): void;
}

declare module '@ruvector/attention-wasm' {
  const mod: any;
  export default mod;
}

declare module '@ruvector/exotic-wasm' {
  const mod: any;
  export default mod;
}

declare module '@ruvector/gnn-wasm' {
  const mod: any;
  export default mod;
}

declare module '@ruvector/hyperbolic-hnsw-wasm' {
  const mod: any;
  export default mod;
}

declare module '@ruvector/micro-hnsw-wasm' {
  const mod: any;
  export default mod;
}

declare module '@ruvector/cognitum-gate-kernel' {
  const mod: any;
  export default mod;
}

declare module '@claude-flow/aidefence' {
  export const AIDefence: any;
  export const ThreatDetector: any;
  export const InputSanitizer: any;
  export function createDefence(config?: any): any;
  export function createAIDefence(config?: any): any;
  export function scanInput(input: string): any;
  export function isSafe(input: string): boolean;
}

declare module '@claude-flow/shared' {
  export interface ClaudeFlowConfig {
    [key: string]: any;
  }
  export interface SystemConfig {
    [key: string]: any;
  }
  export const defaultConfig: any;
  export function loadConfig(options?: any): any;
  export function mergeConfig(...configs: any[]): any;
  export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
}

declare module '@claude-flow/mcp' {
  export const MCPServer: any;
  export const MCPClient: any;
  export function createMCPServer(config?: any, ...args: any[]): any;
}

declare module '@claude-flow/memory' {
  export const AgentDB: any;
  export const MemoryBackend: any;
  export const ControllerRegistry: any;
  export function createMemoryBackend(config?: any): any;
}

declare module '@claude-flow/swarm' {
  export const SwarmCoordinator: any;
  export const AgentPool: any;
  export function createSwarm(config?: any): any;
}

declare module '@claude-flow/hooks' {
  export class HookRegistry { register(...args: any[]): any; unregister(...args: any[]): any; [key: string]: any; }
  export const HookExecutor: any;
  export function createHookRegistry(config?: any): any;
  export type HookEvent = string;
  export const HookEvent: Record<string, string>;
  export type HookHandler = (...args: any[]) => any;
  export interface HookContext { [key: string]: any; }
  export interface HookResult { success: boolean; [key: string]: any; }
  export interface HookRegistrationOptions { [key: string]: any; }
  export enum HookPriority { Low = 0, Normal = 1, High = 2, Critical = 3 }
}

declare module '@claude-flow/embeddings' {
  export const EmbeddingService: any;
  export const VectorCache: any;
  export function createEmbeddingService(config?: any): any;
  export function embed(text: string): Promise<number[]>;
  export function downloadEmbeddingModel(model: string, options?: any, ...args: any[]): Promise<any>;
  export function listEmbeddingModels(): any[];
  export function chunkText(text: string, options?: any): any;
  export function euclideanToPoincare(vec: number[], options?: any): number[];
  export function hyperbolicDistance(a: number[], b: number[], options?: any): number;
  export function hyperbolicCentroid(vectors: number[][], options?: any): number[];
}

declare module '@claude-flow/guidance/compiler' {
  export const GuidanceCompiler: any;
  export function compile(source: string): any;
}

declare module '@claude-flow/guidance/retriever' {
  export const GuidanceRetriever: any;
  export const ShardRetriever: any;
  export const HashEmbeddingProvider: any;
  export function retrieve(query: string): any;
}

declare module '@claude-flow/guidance/gates' {
  export const GuidanceGates: any;
  export const EnforcementGates: any;
  export function evaluate(gate: string): any;
}

declare module '@claude-flow/guidance/analyzer' {
  export const GuidanceAnalyzer: any;
  export function analyze(input: any, ...args: any[]): any;
  export function formatReport(input: any, ...args: any[]): any;
  export function optimizeForSize(input: any, options?: any): any;
  export function formatBenchmark(input: any): any;
  export function abBenchmark(tasks: any, options?: any): any;
  export function getDefaultABTasks(): any[];
}

declare module '@claude-flow/deployment' {
  export const DeploymentManager: any;
  export const ReleaseManager: any;
  export const Publisher: any;
  export const Validator: any;
  export function createDeployment(config?: any): any;
  export function prepareRelease(config?: any): any;
  export function publishToNpm(config?: any): any;
  export function validate(config?: any): any;
}

declare module '@ruvnet/bmssp' {
  const mod: any;
  export default mod;
}

declare module 'prime-radiant-advanced-wasm' {
  const mod: any;
  export default mod;
}

declare module 'tsup' {
  export function defineConfig(config: any): any;
}

declare module 'agentic-flow/core' {
  export const AgenticFlow: any;
  export default AgenticFlow;
}
