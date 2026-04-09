/**
 * agent-monitor.ts — Core state machine for Claude Code session monitoring
 *
 * Watches Claude Code hook events, classifies agent state, manages the
 * priority queue, and handles auto-approve decisions.
 *
 * Detection: hooks-first (immediate, rich JSON), tab-title polling as fallback.
 * Auto-approve: targeted `input text` to specific terminal via AppleScript.
 */

import { watch, type FSWatcher } from "fs";
import { readFile, readdir, unlink } from "fs/promises";
import { join } from "path";
import { type TerminalBridge, type TerminalTab } from "./ghostty-bridge.js";

// ── Types ──

export type AgentState =
  | "running"
  | "waiting-input"
  | "waiting-approval"
  | "done"
  | "stale"
  | "unknown";

export interface AgentInfo {
  sessionId: string;
  name: string; // derived from cwd (last path segment)
  cwd: string;
  state: AgentState;
  terminalId?: string;
  lastHookTime: number;
  stateChangedAt: number;
  message?: string; // what the agent is asking/requesting
  toolName?: string; // tool requesting permission
  toolInput?: Record<string, unknown>;
  autoApproveCount: number;
  detectionMethod: "hook" | "polling";
}

export interface AutoApproveConfig {
  enabled: boolean;
  safeTools: string[]; // tool names to auto-approve (Read, Glob, Grep, etc.)
  safeBashPatterns: string[]; // exact-match bash commands
  bashDenyChars: string[]; // shell metacharacters that always deny
  perAgent: Record<string, { autoApprove: boolean }>;
}

export interface MonitorConfig {
  hookDir: string; // where hook scripts write state files
  pollIntervalMs: number;
  staleTimeoutMs: number;
  autoApprove: AutoApproveConfig;
  priorityWeights: Record<string, number>;
  defaultPriority: number;
  destructivePriority: number;
}

export const DEFAULT_CONFIG: MonitorConfig = {
  hookDir: "/tmp/cc-state",
  pollIntervalMs: 2000,
  staleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  autoApprove: {
    enabled: true,
    safeTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"],
    safeBashPatterns: [
      "git status",
      "git diff",
      "git log",
      "git branch",
      "ls",
      "pwd",
      "which",
      "cat",
      "head",
      "tail",
      "wc",
    ],
    bashDenyChars: [";", "&&", "||", "|", "`", "$("],
    perAgent: {},
  },
  priorityWeights: {},
  defaultPriority: 5,
  destructivePriority: 10,
};

// ── Tab title emoji parsing (fallback detection) ──

const EMOJI_STATE_MAP: Record<string, AgentState> = {
  "⏳": "running",
  "⠐": "running", // Braille dot - observed in real Ghostty sessions
  "⠒": "running",
  "⠇": "running",
  "✳": "waiting-input",
  "🔔": "waiting-input",
  "⏸": "done",
};

export function classifyFromTabTitle(title: string): AgentState {
  for (const [emoji, state] of Object.entries(EMOJI_STATE_MAP)) {
    if (title.includes(emoji)) return state;
  }
  return "unknown";
}

// ── Auto-approve logic ──

export function shouldAutoApprove(
  agent: AgentInfo,
  config: AutoApproveConfig
): boolean {
  if (!config.enabled) return false;

  // Per-agent override
  const agentConfig = config.perAgent[agent.name];
  if (agentConfig && !agentConfig.autoApprove) return false;

  // Check tool name
  if (agent.toolName && config.safeTools.includes(agent.toolName)) {
    return true;
  }

  // For Bash, check exact command match
  if (agent.toolName === "Bash" && agent.toolInput) {
    const command = (agent.toolInput.command as string)?.trim();
    if (!command) return false;

    // Deny if contains shell metacharacters
    for (const char of config.bashDenyChars) {
      if (command.includes(char)) return false;
    }

    // Exact match against safe patterns
    return config.safeBashPatterns.includes(command);
  }

  return false;
}

// ── Priority queue ──

export function getAgentPriority(
  agent: AgentInfo,
  config: MonitorConfig
): number {
  // Destructive operations get highest priority
  if (agent.state === "waiting-approval") {
    return config.destructivePriority;
  }

  // Per-agent weight
  const weight = config.priorityWeights[agent.name];
  if (weight !== undefined) return weight;

  return config.defaultPriority;
}

export function sortQueue(agents: AgentInfo[], config: MonitorConfig): AgentInfo[] {
  const waiting = agents.filter(
    (a) => a.state === "waiting-input" || a.state === "waiting-approval"
  );

  return waiting.sort((a, b) => {
    const priorityDiff = getAgentPriority(b, config) - getAgentPriority(a, config);
    if (priorityDiff !== 0) return priorityDiff;
    // FIFO: longest-waiting first
    return a.stateChangedAt - b.stateChangedAt;
  });
}

// ── Agent name extraction ──

export function agentNameFromCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  // If cwd contains /agents/<name>/, use that
  const agentsIdx = parts.indexOf("agents");
  if (agentsIdx >= 0 && agentsIdx + 1 < parts.length) {
    return parts[agentsIdx + 1];
  }
  // Otherwise use last directory name
  return parts[parts.length - 1] || "unknown";
}

// ── Hook event processing ──

export interface HookEvent {
  session_id: string;
  event_type: string;
  tool_name?: string;
  payload?: Record<string, unknown>;
  timestamp: string;
  cwd?: string;
}

export function processHookEvent(
  event: HookEvent,
  agents: Map<string, AgentInfo>
): AgentInfo {
  const existing = agents.get(event.session_id);
  const now = Date.now();

  const agent: AgentInfo = existing || {
    sessionId: event.session_id,
    name: agentNameFromCwd(event.cwd || ""),
    cwd: event.cwd || "",
    state: "unknown",
    lastHookTime: now,
    stateChangedAt: now,
    autoApproveCount: 0,
    detectionMethod: "hook",
  };

  agent.lastHookTime = now;
  agent.detectionMethod = "hook";

  const prevState = agent.state;

  switch (event.event_type) {
    case "SessionStart":
      agent.state = "running";
      agent.cwd = event.cwd || agent.cwd;
      agent.name = agentNameFromCwd(agent.cwd);
      break;

    case "PermissionRequest":
      agent.state = "waiting-approval";
      agent.toolName = event.tool_name;
      agent.toolInput = event.payload as Record<string, unknown>;
      agent.message = `Needs permission to use ${event.tool_name || "unknown tool"}`;
      break;

    case "PostToolUse":
      agent.state = "running";
      agent.message = undefined;
      agent.toolName = undefined;
      agent.toolInput = undefined;
      break;

    case "Stop":
      agent.state = "done";
      agent.message = undefined;
      break;

    case "UserPromptSubmit":
      agent.state = "running";
      break;
  }

  if (agent.state !== prevState) {
    agent.stateChangedAt = now;
  }

  agents.set(event.session_id, agent);
  return agent;
}

// ── Stale detection ──

export function detectStaleAgents(
  agents: Map<string, AgentInfo>,
  timeoutMs: number
): void {
  const now = Date.now();
  for (const agent of agents.values()) {
    if (
      agent.state === "running" &&
      now - agent.lastHookTime > timeoutMs
    ) {
      agent.state = "stale";
      agent.stateChangedAt = now;
      agent.message = "No activity for 5+ minutes";
    }
  }
}

// ── Session-to-tab matching ──

export function matchSessionToTab(
  agent: AgentInfo,
  tabs: TerminalTab[]
): TerminalTab | undefined {
  // Primary: match on working directory
  const matches = tabs.filter((t) => t.workingDirectory === agent.cwd);

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;

  // Ambiguous: multiple tabs with same cwd
  // Try tab title for session hints
  const titleMatch = matches.find(
    (t) =>
      t.tabName.toLowerCase().includes(agent.name.toLowerCase()) ||
      t.tabName.includes(agent.sessionId.slice(0, 8))
  );
  if (titleMatch) return titleMatch;

  // Fallback: return first match (best guess)
  return matches[0];
}

// ── Monitor class ──

export type MonitorEventType =
  | "agent-updated"
  | "queue-changed"
  | "auto-approved"
  | "error";

export type MonitorListener = (
  type: MonitorEventType,
  data: unknown
) => void;

export class AgentMonitor {
  private agents = new Map<string, AgentInfo>();
  private config: MonitorConfig;
  private bridge: TerminalBridge;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: MonitorListener[] = [];

  constructor(bridge: TerminalBridge, config: Partial<MonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bridge = bridge;
  }

  on(listener: MonitorListener): void {
    this.listeners.push(listener);
  }

  private emit(type: MonitorEventType, data: unknown): void {
    for (const listener of this.listeners) {
      listener(type, data);
    }
  }

  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  getQueue(): AgentInfo[] {
    return sortQueue(this.getAgents(), this.config);
  }

  async start(): Promise<void> {
    // Watch hook directory for new events
    try {
      this.watcher = watch(this.config.hookDir, async (_, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        await this.processHookFile(join(this.config.hookDir, filename));
      });
    } catch {
      // Hook dir doesn't exist or can't watch — fall back to polling only
    }

    // Poll tab titles as fallback
    this.pollTimer = setInterval(
      () => this.pollTabTitles(),
      this.config.pollIntervalMs
    );

    // Check for stale agents
    this.staleTimer = setInterval(
      () => {
        detectStaleAgents(this.agents, this.config.staleTimeoutMs);
        this.emit("agent-updated", null);
      },
      30000 // check every 30s
    );

    // Initial poll
    await this.pollTabTitles();
  }

  stop(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
  }

  private async processHookFile(filepath: string): Promise<void> {
    try {
      const content = await readFile(filepath, "utf-8");
      const event: HookEvent = JSON.parse(content);
      const agent = processHookEvent(event, this.agents);

      // Try to match to a terminal tab
      const tabs = await this.bridge.listTabs();
      const tab = matchSessionToTab(agent, tabs);
      if (tab) {
        agent.terminalId = tab.terminalId;
      }

      // Auto-approve check
      if (
        agent.state === "waiting-approval" &&
        shouldAutoApprove(agent, this.config.autoApprove)
      ) {
        await this.autoApprove(agent);
      }

      this.emit("agent-updated", agent);
      this.emit("queue-changed", this.getQueue());

      // Clean up processed file
      await unlink(filepath).catch(() => {});
    } catch {
      // Malformed file or read error — skip
    }
  }

  private async autoApprove(agent: AgentInfo): Promise<void> {
    if (!agent.terminalId) return;

    try {
      await this.bridge.sendInput(agent.terminalId, "y\n");
      agent.autoApproveCount++;
      agent.state = "running";
      agent.stateChangedAt = Date.now();
      agent.message = undefined;
      this.emit("auto-approved", {
        agent: agent.name,
        tool: agent.toolName,
        command: agent.toolInput?.command,
      });
    } catch {
      this.emit("error", {
        message: `Auto-approve failed for ${agent.name}`,
        agent: agent.name,
      });
    }
  }

  private async pollTabTitles(): Promise<void> {
    try {
      const tabs = await this.bridge.listTabs();

      for (const tab of tabs) {
        // Check if this tab is already tracked by hooks
        const existingByTerminal = Array.from(this.agents.values()).find(
          (a) => a.terminalId === tab.terminalId
        );
        if (existingByTerminal) {
          // Already tracked via hooks — don't override with coarser polling data
          continue;
        }

        // Check if we can match by cwd
        const existingByCwd = Array.from(this.agents.values()).find(
          (a) => a.cwd === tab.workingDirectory && a.detectionMethod === "hook"
        );
        if (existingByCwd) {
          existingByCwd.terminalId = tab.terminalId;
          continue;
        }

        // New tab detected via polling — classify from title
        const state = classifyFromTabTitle(tab.tabName);
        if (state === "unknown") continue; // Not a Claude Code tab

        const pollId = `poll-${tab.terminalId}`;
        const existing = this.agents.get(pollId);
        const prevState = existing?.state;

        const agent: AgentInfo = existing || {
          sessionId: pollId,
          name: agentNameFromCwd(tab.workingDirectory),
          cwd: tab.workingDirectory,
          state,
          terminalId: tab.terminalId,
          lastHookTime: Date.now(),
          stateChangedAt: Date.now(),
          autoApproveCount: 0,
          detectionMethod: "polling",
        };

        agent.state = state;
        agent.terminalId = tab.terminalId;
        agent.lastHookTime = Date.now();

        if (state !== prevState) {
          agent.stateChangedAt = Date.now();
        }

        this.agents.set(pollId, agent);
      }

      // Remove agents whose tabs no longer exist
      for (const [id, agent] of this.agents) {
        if (agent.terminalId) {
          const tabExists = tabs.some(
            (t) => t.terminalId === agent.terminalId
          );
          if (!tabExists) {
            this.agents.delete(id);
          }
        }
      }

      this.emit("agent-updated", null);
    } catch {
      // Ghostty not running or AppleScript error — emit error state
      this.emit("error", { message: "Ghostty not found" });
    }
  }
}
