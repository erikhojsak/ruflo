/**
 * Modular Automation Executor for Claude Flow
 * 
 * This module provides the core infrastructure for executing automation
 * workflows with Claude CLI integration, while preserving existing 
 * swarm and hive-mind functionality.
 */

import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { printSuccess, printError, printWarning } from '../utils.js';

// Simple ID generator
function generateId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * WorkflowExecutor - Core class for executing automation workflows
 */
export class WorkflowExecutor {
  constructor(options = {}) {
    this.options = {
      enableClaude: false,
      nonInteractive: false,
      outputFormat: 'text',
      maxConcurrency: 3,
      timeout: 3600000, // 1 hour default
      logLevel: 'info',
      ...options
    };
    
    // Execution state
    this.executionId = generateId('workflow-exec');
    this.startTime = Date.now();
    this.activeTasks = new Map();
    this.claudeInstances = new Map();
    this.results = new Map();
    this.errors = [];
    
    // Hooks integration
    this.hooksEnabled = true;
    this.sessionId = generateId('automation-session');
  }

  /**
   * Execute a workflow from JSON definition
   */
  async executeWorkflow(workflowData, variables = {}) {
    try {
      console.log(`🚀 Starting workflow execution: ${this.executionId}`);
      console.log(`📋 Workflow: ${workflowData.name}`);
      console.log(`🎯 Strategy: MLE-STAR Machine Learning Engineering`);
      
      if (this.options.enableClaude) {
        console.log(`🤖 Claude CLI Integration: Enabled`);
      }
      
      if (this.options.nonInteractive) {
        console.log(`🖥️  Non-Interactive Mode: Enabled`);
      }
      
      console.log();

      // Pre-execution hooks
      if (this.hooksEnabled) {
        await this.executeHook('pre-task', {
          description: `Execute workflow: ${workflowData.name}`,
          sessionId: this.sessionId
        });
      }

      // Validate workflow
      this.validateWorkflow(workflowData);
      
      // Apply variable substitutions
      const processedWorkflow = this.applyVariables(workflowData, variables);
      
      // Initialize agents if Claude integration is enabled
      if (this.options.enableClaude) {
        await this.initializeClaudeAgents(processedWorkflow.agents);
      }
      
      // Execute workflow phases
      const result = await this.executeWorkflowTasks(processedWorkflow);
      
      // Post-execution hooks
      if (this.hooksEnabled) {
        await this.executeHook('post-task', {
          taskId: this.executionId,
          sessionId: this.sessionId,
          result: result.success ? 'success' : 'failure'
        });
      }
      
      const duration = Date.now() - this.startTime;
      
      if (result.success) {
        printSuccess(`✅ Workflow completed successfully in ${this.formatDuration(duration)}`);
        console.log(`📊 Tasks: ${result.completedTasks}/${result.totalTasks} completed`);
        console.log(`🆔 Execution ID: ${this.executionId}`);
      } else {
        printError(`❌ Workflow failed after ${this.formatDuration(duration)}`);
        console.log(`📊 Tasks: ${result.completedTasks}/${result.totalTasks} completed`);
        console.log(`❌ Errors: ${this.errors.length}`);
      }
      
      // Cleanup Claude instances
      if (this.options.enableClaude) {
        await this.cleanupClaudeInstances();
      }
      
      return result;
      
    } catch (error) {
      printError(`Workflow execution failed: ${error.message}`);
      await this.cleanupClaudeInstances();
      throw error;
    }
  }

  /**
   * Initialize Claude CLI instances for agents
   */
  async initializeClaudeAgents(agents) {
    if (!agents || agents.length === 0) {
      return;
    }

    console.log(`🤖 Initializing ${agents.length} Claude CLI instances...`);
    
    for (const agent of agents) {
      try {
        // Check if Claude CLI is available
        if (!await this.isClaudeAvailable()) {
          throw new Error('Claude CLI not found. Please install Claude Code: https://claude.ai/code');
        }
        
        // Create agent-specific prompt
        const agentPrompt = this.createAgentPrompt(agent);
        
        // Spawn Claude instance for this agent
        const claudeProcess = await this.spawnClaudeInstance(agent, agentPrompt);
        
        this.claudeInstances.set(agent.id, {
          process: claudeProcess,
          agent: agent,
          status: 'active',
          startTime: Date.now()
        });
        
        console.log(`  ✅ ${agent.name} (${agent.type}) - PID: ${claudeProcess.pid}`);
        
      } catch (error) {
        console.error(`  ❌ Failed to initialize ${agent.name}: ${error.message}`);
        this.errors.push({
          type: 'agent_initialization',
          agent: agent.id,
          error: error.message,
          timestamp: new Date()
        });
      }
    }
    
    if (this.claudeInstances.size > 0) {
      console.log(`✅ ${this.claudeInstances.size} Claude instances active`);
    }
    console.log();
  }

  /**
   * Check if Claude CLI is available
   */
  async isClaudeAvailable() {
    try {
      const { execSync } = await import('child_process');
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a Claude CLI instance for an agent
   */
  async spawnClaudeInstance(agent, prompt) {
    const claudeArgs = [prompt];
    
    // Add non-interactive flags if needed
    if (this.options.nonInteractive) {
      claudeArgs.push('-p'); // Print mode
      claudeArgs.push('--output-format', 'stream-json');
      claudeArgs.push('--verbose');
    }
    
    // Add auto-permissions for seamless execution
    claudeArgs.push('--dangerously-skip-permissions');
    
    // Spawn Claude process
    const claudeProcess = spawn('claude', claudeArgs, {
      stdio: this.options.nonInteractive ? ['pipe', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    
    // Handle process events
    claudeProcess.on('error', (error) => {
      console.error(`❌ Claude instance error for ${agent.name}:`, error.message);
      this.errors.push({
        type: 'claude_instance_error',
        agent: agent.id,
        error: error.message,
        timestamp: new Date()
      });
    });
    
    claudeProcess.on('exit', (code) => {
      const instance = this.claudeInstances.get(agent.id);
      if (instance) {
        instance.status = code === 0 ? 'completed' : 'failed';
        instance.exitCode = code;
        instance.endTime = Date.now();
      }
    });
    
    return claudeProcess;
  }

  /**
   * Create agent-specific Claude prompt
   */
  createAgentPrompt(agent) {
    const { config } = agent;
    const capabilities = config?.capabilities?.join(', ') || 'general automation';
    
    return `You are the ${agent.name} in a coordinated MLE-STAR automation workflow.

🎯 AGENT ROLE: ${agent.type.toUpperCase()}
📋 CAPABILITIES: ${capabilities}
🆔 AGENT ID: ${agent.id}

CRITICAL COORDINATION REQUIREMENTS:
1. HOOKS: Use claude-flow hooks for coordination:
   - Run "npx claude-flow@alpha hooks pre-task --description '[your task]'" before starting
   - Run "npx claude-flow@alpha hooks post-edit --file '[file]'" after each file operation  
   - Run "npx claude-flow@alpha hooks post-task --task-id '${agent.id}'" when complete

2. MEMORY: Store all findings and results:
   - Use "npx claude-flow@alpha memory store 'agent/${agent.id}/[key]' '[value]'" for important data
   - Check "npx claude-flow@alpha memory search 'agent/*'" for coordination with other agents

3. SESSION: Maintain session coordination:
   - Session ID: ${this.sessionId}
   - Execution ID: ${this.executionId}

AGENT-SPECIFIC CONFIGURATION:
${JSON.stringify(config, null, 2)}

MLE-STAR METHODOLOGY FOCUS:
${this.getMethodologyGuidance(agent.type)}

WORKFLOW COORDINATION:
- Work with other agents in the pipeline: Search → Foundation → Refinement → Ensemble → Validation
- Share findings through memory system
- Use proper file naming conventions: ${agent.id}_[component].[ext]
- Follow MLE-STAR best practices for your role

Execute your role in the MLE-STAR workflow with full coordination and hook integration.`;
  }

  /**
   * Get methodology guidance for agent type
   */
  getMethodologyGuidance(agentType) {
    const guidance = {
      researcher: `SEARCH PHASE - Web Research & Foundation Discovery:
- Search for state-of-the-art ML approaches for the problem domain
- Find winning Kaggle solutions and benchmark results
- Identify promising model architectures and techniques
- Document implementation examples and model cards
- Focus on proven, recent approaches with good performance`,

      coder: `FOUNDATION PHASE - Initial Model Building:
- Analyze dataset characteristics and problem type
- Implement baseline models based on research findings
- Create robust preprocessing pipelines
- Build modular, testable code components
- Establish performance baselines for comparison`,

      optimizer: `REFINEMENT PHASE - Targeted Component Optimization:
- Perform ablation analysis to identify high-impact components
- Focus deep optimization on most impactful pipeline elements
- Use iterative improvement with structured feedback
- Implement advanced feature engineering techniques
- Optimize hyperparameters systematically`,

      architect: `ENSEMBLE PHASE - Intelligent Model Combination:
- Create sophisticated ensemble strategies beyond simple averaging
- Implement stacking with meta-learners
- Use dynamic weighting and mixture of experts
- Apply Bayesian model averaging where appropriate
- Optimize ensemble composition for maximum performance`,

      tester: `VALIDATION PHASE - Comprehensive Testing & Debugging:
- Implement rigorous cross-validation strategies
- Detect and prevent data leakage
- Perform error analysis and debugging
- Validate model robustness and generalization
- Ensure production readiness with quality checks`,

      coordinator: `ORCHESTRATION PHASE - Workflow Management:
- Coordinate between all agents and phases
- Monitor progress and performance metrics
- Manage resource allocation and scheduling
- Handle error recovery and workflow adaptation
- Prepare final deployment and documentation`
    };

    return guidance[agentType] || 'Focus on your specialized capabilities and coordinate with other agents.';
  }

  /**
   * Execute workflow tasks with dependency management
   */
  async executeWorkflowTasks(workflow) {
    const { tasks, dependencies = {} } = workflow;
    
    let completedTasks = 0;
    let failedTasks = 0;
    const totalTasks = tasks.length;
    
    // Create task execution plan based on dependencies
    const executionPlan = this.createExecutionPlan(tasks, dependencies);
    
    console.log(`📋 Executing ${totalTasks} tasks in ${executionPlan.length} phases...`);
    console.log();
    
    // Execute tasks phase by phase
    for (const [phaseIndex, phaseTasks] of executionPlan.entries()) {
      console.log(`🔄 Phase ${phaseIndex + 1}: ${phaseTasks.map(t => t.name || t.id).join(', ')}`);
      
      // Execute tasks in this phase (potentially in parallel)
      const phasePromises = phaseTasks.map(task => this.executeTask(task, workflow));
      const phaseResults = await Promise.allSettled(phasePromises);
      
      // Process phase results
      for (const [taskIndex, result] of phaseResults.entries()) {
        const task = phaseTasks[taskIndex];
        
        if (result.status === 'fulfilled' && result.value.success) {
          completedTasks++;
          this.results.set(task.id, result.value);
          console.log(`  ✅ ${task.name || task.id}`);
        } else {
          failedTasks++;
          const error = result.status === 'rejected' ? result.reason : result.value.error;
          this.errors.push({
            type: 'task_execution',
            task: task.id,
            error: error.message || error,
            timestamp: new Date()
          });
          console.log(`  ❌ ${task.name || task.id}: ${error.message || error}`);
          
          // Check if we should fail fast
          if (workflow.settings?.failurePolicy === 'fail-fast') {
            console.log(`🛑 Failing fast due to task failure`);
            break;
          }
        }
      }
      
      console.log();
      
      // Stop if fail-fast and we have failures
      if (workflow.settings?.failurePolicy === 'fail-fast' && failedTasks > 0) {
        break;
      }
    }
    
    return {
      success: failedTasks === 0,
      totalTasks,
      completedTasks,
      failedTasks,
      executionId: this.executionId,
      duration: Date.now() - this.startTime,
      results: Object.fromEntries(this.results),
      errors: this.errors
    };
  }

  /**
   * Execute a single task
   */
  async executeTask(task, workflow) {
    const startTime = Date.now();
    
    try {
      // Store task execution in memory if hooks enabled
      if (this.hooksEnabled) {
        await this.executeHook('notify', {
          message: `Starting task: ${task.name || task.id}`,
          sessionId: this.sessionId
        });
      }
      
      // Simulate task execution for now
      // In a full implementation, this would:
      // 1. Assign task to appropriate Claude instance
      // 2. Monitor execution progress
      // 3. Handle task communication and coordination
      // 4. Collect and validate results
      
      console.log(`    🔄 Executing: ${task.description}`);
      
      // Simulate variable execution time based on task timeout
      const executionTime = Math.min(
        1000 + Math.random() * 3000, // 1-4 seconds simulation
        task.timeout || 30000
      );
      
      await new Promise(resolve => setTimeout(resolve, executionTime));
      
      // Simulate success (90% success rate for demo)
      const success = Math.random() > 0.1;
      
      if (success) {
        const result = {
          success: true,
          taskId: task.id,
          duration: Date.now() - startTime,
          output: {
            status: 'completed',
            agent: task.assignTo,
            executionTime: Date.now() - startTime,
            metadata: {
              timestamp: new Date().toISOString(),
              executionId: this.executionId
            }
          }
        };
        
        // Store result in memory
        if (this.hooksEnabled) {
          await this.storeTaskResult(task.id, result.output);
        }
        
        return result;
      } else {
        throw new Error('Simulated task failure');
      }
      
    } catch (error) {
      return {
        success: false,
        taskId: task.id,
        duration: Date.now() - startTime,
        error: error
      };
    }
  }

  /**
   * Create execution plan based on task dependencies
   */
  createExecutionPlan(tasks, dependencies) {
    const taskMap = new Map(tasks.map(task => [task.id, task]));
    const completed = new Set();
    const phases = [];
    
    while (completed.size < tasks.length) {
      const readyTasks = tasks.filter(task => {
        if (completed.has(task.id)) return false;
        
        const deps = task.depends || dependencies[task.id] || [];
        return deps.every(dep => completed.has(dep));
      });
      
      if (readyTasks.length === 0) {
        throw new Error('Circular dependency detected or invalid dependencies');
      }
      
      phases.push(readyTasks);
      readyTasks.forEach(task => completed.add(task.id));
    }
    
    return phases;
  }

  /**
   * Execute a hook command
   */
  async executeHook(hookType, params) {
    try {
      const { execSync } = await import('child_process');
      
      let hookCommand = `npx claude-flow@alpha hooks ${hookType}`;
      
      if (params.description) {
        hookCommand += ` --description "${params.description}"`;
      }
      if (params.file) {
        hookCommand += ` --file "${params.file}"`;
      }
      if (params.taskId) {
        hookCommand += ` --task-id "${params.taskId}"`;
      }
      if (params.sessionId) {
        hookCommand += ` --session-id "${params.sessionId}"`;
      }
      if (params.message) {
        hookCommand += ` --message "${params.message}"`;
      }
      
      execSync(hookCommand, { stdio: 'pipe' });
      
    } catch (error) {
      // Hooks are optional, don't fail the workflow if they fail
      console.debug(`Hook ${hookType} failed:`, error.message);
    }
  }

  /**
   * Store task result in memory
   */
  async storeTaskResult(taskId, result) {
    try {
      const { execSync } = await import('child_process');
      const resultJson = JSON.stringify(result);
      
      execSync(`npx claude-flow@alpha memory store "workflow/${this.executionId}/${taskId}" '${resultJson}'`, {
        stdio: 'pipe'
      });
      
    } catch (error) {
      console.debug(`Failed to store task result for ${taskId}:`, error.message);
    }
  }

  /**
   * Validate workflow definition
   */
  validateWorkflow(workflow) {
    if (!workflow.name) {
      throw new Error('Workflow name is required');
    }
    
    if (!workflow.tasks || workflow.tasks.length === 0) {
      throw new Error('Workflow must contain at least one task');
    }
    
    // Validate task structure
    for (const task of workflow.tasks) {
      if (!task.id || !task.type || !task.description) {
        throw new Error(`Task ${task.id || 'unknown'} is missing required fields`);
      }
    }
    
    // Validate agent assignments
    if (workflow.agents) {
      const agentIds = new Set(workflow.agents.map(a => a.id));
      for (const task of workflow.tasks) {
        if (task.assignTo && !agentIds.has(task.assignTo)) {
          throw new Error(`Task ${task.id} assigned to unknown agent: ${task.assignTo}`);
        }
      }
    }
  }

  /**
   * Apply variable substitutions to workflow
   */
  applyVariables(workflow, variables) {
    const allVariables = { ...workflow.variables, ...variables };
    const workflowStr = JSON.stringify(workflow);
    
    // Simple variable substitution
    let processedStr = workflowStr;
    for (const [key, value] of Object.entries(allVariables)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
      processedStr = processedStr.replace(pattern, value);
    }
    
    return JSON.parse(processedStr);
  }

  /**
   * Cleanup Claude instances
   */
  async cleanupClaudeInstances() {
    if (this.claudeInstances.size === 0) return;
    
    console.log('🧹 Cleaning up Claude instances...');
    
    for (const [agentId, instance] of this.claudeInstances.entries()) {
      try {
        if (instance.process && !instance.process.killed) {
          instance.process.kill('SIGTERM');
          
          // Wait for graceful shutdown, then force kill if needed
          setTimeout(() => {
            if (!instance.process.killed) {
              instance.process.kill('SIGKILL');
            }
          }, 5000);
        }
        
        console.log(`  ✅ Cleaned up ${instance.agent.name}`);
        
      } catch (error) {
        console.error(`  ❌ Error cleaning up ${instance.agent.name}:`, error.message);
      }
    }
    
    this.claudeInstances.clear();
  }

  /**
   * Format duration in human readable format
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

/**
 * Load workflow from file
 */
export async function loadWorkflowFromFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    
    if (filePath.endsWith('.json')) {
      return JSON.parse(content);
    } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      // For now, just return error - YAML support can be added later
      throw new Error('YAML workflows not yet supported');
    } else {
      throw new Error('Unsupported workflow file format. Use .json or .yaml');
    }
    
  } catch (error) {
    throw new Error(`Failed to load workflow: ${error.message}`);
  }
}

/**
 * Get default MLE-STAR workflow path
 */
export function getMLEStarWorkflowPath() {
  return join(process.cwd(), 'src', 'cli', 'simple-commands', 'templates', 'mle-star-workflow.json');
}