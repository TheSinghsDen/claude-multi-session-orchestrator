/**
 * main.ts — Frontend for Claude Command Center
 *
 * Polls Ghostty tabs and hook events via Tauri commands.
 * Manages agent state, renders the overlay, handles auto-approve.
 */

import { invoke } from "@tauri-apps/api/core";

// ── Types ──

interface TerminalTab {
  tab_index: number;
  tab_name: string;
  terminal_id: string;
  working_directory: string;
}

interface HookEvent {
  session_id: string;
  event_type: string;
  tool_name?: string;
  payload?: Record<string, unknown>;
  timestamp: string;
  cwd?: string;
}

type AgentState =
  | "running"
  | "waiting-input"
  | "waiting-approval"
  | "done"
  | "stale"
  | "unknown";

interface AgentInfo {
  sessionId: string;
  name: string;
  cwd: string;
  state: AgentState;
  terminalId?: string;
  lastEventTime: number;
  stateChangedAt: number;
  message?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  autoApproveCount: number;
  detectionMethod: "hook" | "polling";
}

// ── Config ──

const SAFE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill"];
const SAFE_BASH = [
  "git status", "git diff", "git log", "git branch",
  "ls", "pwd", "which", "wc",
];
const BASH_DENY_CHARS = [";", "&&", "||", "|", "`", "$("];
const POLL_INTERVAL = 2000;
const STALE_TIMEOUT = 5 * 60 * 1000;

// ── State ──

const agents = new Map<string, AgentInfo>();
let ghosttyAvailable = false;
let hooksActive = false;

// ── DOM ──

const agentListEl = document.getElementById("agent-list")!;
const queueSectionEl = document.getElementById("queue-section")!;
const queueListEl = document.getElementById("queue-list")!;
const emptyStateEl = document.getElementById("empty-state")!;
const statRunning = document.getElementById("stat-running")!;
const statWaiting = document.getElementById("stat-waiting")!;
const statDone = document.getElementById("stat-done")!;

// ── Agent name from cwd ──

function agentNameFromCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const agentsIdx = parts.indexOf("agents");
  if (agentsIdx >= 0 && agentsIdx + 1 < parts.length) return parts[agentsIdx + 1];
  return parts[parts.length - 1] || "unknown";
}

// ── Tab title emoji → state ──

// Claude Code uses Braille spinner characters while working, ✳ when idle
// Full Braille spinner cycle: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ plus ⠐⠂
const EMOJI_STATES: [string, AgentState][] = [
  // Braille spinner = running (Claude is working)
  ["⠋", "running"], ["⠙", "running"], ["⠹", "running"], ["⠸", "running"],
  ["⠼", "running"], ["⠴", "running"], ["⠦", "running"], ["⠧", "running"],
  ["⠇", "running"], ["⠏", "running"], ["⠐", "running"], ["⠂", "running"],
  ["⠒", "running"],
  // Hourglass
  ["⏳", "running"],
  // Idle (Claude finished, waiting at prompt — not actively asking a question)
  ["✳", "done"],
  ["🔔", "waiting-input"],
  // Done
  ["⏸", "done"],
];

function classifyFromTitle(title: string): AgentState {
  for (const [emoji, state] of EMOJI_STATES) {
    if (title.includes(emoji)) return state;
  }
  return "unknown";
}

/** Extract a readable name from the tab title by stripping emoji prefix */
function nameFromTabTitle(title: string): string {
  // Strip leading emoji/Braille characters and whitespace
  let name = title.replace(/^[\s⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠒⏳✳🔔⏸]+/, "").trim();
  // If what's left is just "Claude Code", use the cwd-based name
  if (!name || name === "Claude Code") return "";
  // Truncate long names
  if (name.length > 40) name = name.slice(0, 37) + "...";
  return name;
}

// ── Auto-approve logic ──

function shouldAutoApprove(agent: AgentInfo): boolean {
  if (agent.toolName && SAFE_TOOLS.includes(agent.toolName)) return true;

  if (agent.toolName === "Bash" && agent.toolInput?.command) {
    const cmd = (agent.toolInput.command as string).trim();
    for (const c of BASH_DENY_CHARS) {
      if (cmd.includes(c)) return false;
    }
    return SAFE_BASH.includes(cmd);
  }

  return false;
}

// ── Process hook events ──

function processHookEvent(event: HookEvent): void {
  const now = Date.now();
  const existing = agents.get(event.session_id);

  const agent: AgentInfo = existing || {
    sessionId: event.session_id,
    name: agentNameFromCwd(event.cwd || ""),
    cwd: event.cwd || "",
    state: "unknown",
    lastEventTime: now,
    stateChangedAt: now,
    autoApproveCount: 0,
    detectionMethod: "hook",
  };

  agent.lastEventTime = now;
  agent.detectionMethod = "hook";
  if (event.cwd) {
    agent.cwd = event.cwd;
    agent.name = agentNameFromCwd(event.cwd);
  }

  const prevState = agent.state;

  switch (event.event_type) {
    case "SessionStart":
      agent.state = "running";
      break;
    case "PermissionRequest":
      agent.state = "waiting-approval";
      agent.toolName = event.tool_name;
      agent.toolInput = event.payload as Record<string, unknown>;
      agent.message = `Needs permission: ${event.tool_name || "unknown"}`;
      if (agent.toolInput?.command) {
        agent.message += ` → ${(agent.toolInput.command as string).slice(0, 60)}`;
      }
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
  hooksActive = true;
}

// ── Process tab polling (fallback) ──

function processTabPoll(tabs: TerminalTab[]): void {
  const now = Date.now();
  const seenTerminals = new Set<string>();

  for (const tab of tabs) {
    seenTerminals.add(tab.terminal_id);

    // If already tracked via hooks, just update terminal ID
    const hookAgent = Array.from(agents.values()).find(
      (a) => a.detectionMethod === "hook" && a.cwd === tab.working_directory
    );
    if (hookAgent) {
      hookAgent.terminalId = tab.terminal_id;
      continue;
    }

    const state = classifyFromTitle(tab.tab_name);
    if (state === "unknown") continue; // Only show tabs we can classify via emoji

    const pollId = `poll-${tab.terminal_id}`;
    const existing = agents.get(pollId);
    const prevState = existing?.state;

    const titleName = nameFromTabTitle(tab.tab_name);
    const agent: AgentInfo = existing || {
      sessionId: pollId,
      name: titleName || agentNameFromCwd(tab.working_directory),
      cwd: tab.working_directory,
      state,
      terminalId: tab.terminal_id,
      lastEventTime: now,
      stateChangedAt: now,
      autoApproveCount: 0,
      detectionMethod: "polling",
    };

    // Update name from tab title (it can change as Claude works)
    if (titleName) agent.name = titleName;
    agent.state = state === "unknown" ? agent.state : state;
    agent.terminalId = tab.terminal_id;
    agent.lastEventTime = now;

    if (agent.state !== prevState) {
      agent.stateChangedAt = now;
    }

    agents.set(pollId, agent);
  }

  // Remove agents whose tabs are gone
  for (const [id, agent] of agents) {
    if (agent.terminalId && !seenTerminals.has(agent.terminalId)) {
      agents.delete(id);
    }
  }
}

// ── Match hook agents to terminal tabs ──

function matchAgentsToTabs(tabs: TerminalTab[]): void {
  for (const agent of agents.values()) {
    if (agent.detectionMethod === "hook" && !agent.terminalId) {
      const match = tabs.find((t) => t.working_directory === agent.cwd);
      if (match) agent.terminalId = match.terminal_id;
    }
  }
}

// ── Stale detection ──

function detectStale(): void {
  const now = Date.now();
  for (const agent of agents.values()) {
    if (agent.state === "running" && now - agent.lastEventTime > STALE_TIMEOUT) {
      agent.state = "stale";
      agent.stateChangedAt = now;
      agent.message = "No activity for 5+ minutes";
    }
  }
}

// ── Auto-approve + focus switching ──

async function handleAutoApprove(agent: AgentInfo): Promise<void> {
  if (agent.state !== "waiting-approval") return;
  if (!shouldAutoApprove(agent)) return;
  if (!agent.terminalId) return;

  try {
    await invoke("send_input", { terminal_id: agent.terminalId, text: "y\n" });
    agent.autoApproveCount++;
    agent.state = "running";
    agent.stateChangedAt = Date.now();
    agent.message = undefined;
    agent.toolName = undefined;
    agent.toolInput = undefined;
  } catch (e) {
    console.error("Auto-approve failed:", e);
  }
}

async function focusNextWaiting(): Promise<void> {
  const queue = getQueue();
  if (queue.length === 0) return;

  const next = queue[0];
  if (!next.terminalId) return;

  try {
    await invoke("focus_tab", { terminal_id: next.terminalId });
    await invoke("play_sound", {
      sound_type: next.state === "waiting-approval" ? "needs-approval" : "needs-input",
    });
  } catch (e) {
    console.error("Focus failed:", e);
  }
}

// ── Queue ──

function getQueue(): AgentInfo[] {
  return Array.from(agents.values())
    .filter((a) => a.state === "waiting-input" || a.state === "waiting-approval")
    .sort((a, b) => {
      // Destructive approval first
      if (a.state === "waiting-approval" && b.state !== "waiting-approval") return -1;
      if (b.state === "waiting-approval" && a.state !== "waiting-approval") return 1;
      // Then FIFO
      return a.stateChangedAt - b.stateChangedAt;
    });
}

// ── Rendering ──

function dotClass(state: AgentState): string {
  switch (state) {
    case "running": return "dot-green";
    case "waiting-input": return "dot-yellow";
    case "waiting-approval": return "dot-red";
    case "stale": return "dot-orange";
    case "done": return "dot-gray";
    default: return "dot-gray";
  }
}

function stateLabel(agent: AgentInfo): string {
  switch (agent.state) {
    case "running": return "Running";
    case "waiting-input": return "Waiting for input";
    case "waiting-approval": return "Needs approval";
    case "stale": return "Stale — no activity 5m+";
    case "done": return "Done";
    default: return "Unknown";
  }
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function escHtml(t: string): string {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

function badge(agent: AgentInfo): string {
  if (agent.state === "waiting-approval")
    return '<div class="badge badge-destructive">DESTRUCTIVE</div>';
  if (agent.autoApproveCount > 0)
    return `<div class="badge badge-auto">${agent.autoApproveCount} auto</div>`;
  if (agent.state === "stale")
    return '<div class="badge badge-stale">?</div>';
  if (agent.detectionMethod === "hook")
    return '<div class="badge badge-hook">hook</div>';
  return "";
}

function renderAgent(agent: AgentInfo): string {
  const classes = ["agent-row"];
  if (agent.state === "waiting-input") classes.push("waiting");
  if (agent.state === "waiting-approval") classes.push("destructive");
  if (agent.state === "stale") classes.push("stale");

  const preview = agent.message
    ? `<div class="agent-preview">${escHtml(agent.message)}</div>`
    : "";

  return `
    <div class="${classes.join(" ")}" data-terminal="${agent.terminalId || ""}" onclick="window._focusAgent('${agent.terminalId || ""}')">
      <div class="agent-dot"><span class="dot ${dotClass(agent.state)}"></span></div>
      <div class="agent-info">
        <div class="agent-name">${escHtml(agent.name)}</div>
        <div class="agent-status">${stateLabel(agent)}</div>
        ${preview}
      </div>
      <div class="agent-meta">
        <div class="agent-time">${agent.state === "done" ? "—" : timeAgo(agent.stateChangedAt)}</div>
        ${badge(agent)}
      </div>
    </div>`;
}

function renderQueue(queue: AgentInfo[]): string {
  return queue
    .map(
      (a, i) => `
    <div class="queue-item" onclick="window._focusAgent('${a.terminalId || ""}')">
      <span class="queue-num">${i + 1}</span>
      <span class="dot ${dotClass(a.state)}"></span>
      <span>${escHtml(a.name)} — ${escHtml(a.message || "waiting")}</span>
    </div>`
    )
    .join("");
}

function render(): void {
  const all = Array.from(agents.values());
  const queue = getQueue();

  if (queue.length > 0) {
    queueSectionEl.classList.remove("hidden");
    queueListEl.innerHTML = renderQueue(queue);
  } else {
    queueSectionEl.classList.add("hidden");
  }

  if (all.length > 0) {
    emptyStateEl.classList.add("hidden");
    agentListEl.style.display = "";
    // Sort: waiting-approval first, then waiting-input, then running, then done, then stale
    const sorted = all.sort((a, b) => {
      const order: Record<AgentState, number> = {
        "waiting-approval": 0,
        "waiting-input": 1,
        "running": 2,
        "unknown": 3,
        "stale": 4,
        "done": 5,
      };
      return (order[a.state] ?? 3) - (order[b.state] ?? 3);
    });
    agentListEl.innerHTML = sorted.map(renderAgent).join("");
  } else {
    emptyStateEl.classList.remove("hidden");
    emptyStateEl.querySelector(".empty-title")!.textContent = ghosttyAvailable
      ? "No Claude Code sessions detected"
      : "Ghostty not found";
    emptyStateEl.querySelector(".empty-desc")!.textContent = ghosttyAvailable
      ? "Open Claude Code in Ghostty and start a session."
      : "Open Ghostty and start a Claude Code session. Checking every 2 seconds...";
    agentListEl.style.display = "none";
  }

  const running = all.filter((a) => a.state === "running").length;
  const waiting = all.filter(
    (a) => a.state === "waiting-input" || a.state === "waiting-approval"
  ).length;
  const done = all.filter((a) => a.state === "done").length;

  statRunning.innerHTML = `<span class="dot dot-green"></span> ${running} running`;
  statWaiting.innerHTML = `<span class="dot dot-yellow"></span> ${waiting} waiting`;
  statDone.innerHTML = `<span class="dot dot-gray"></span> ${done} done`;
}

// ── Click handler for agent focus ──

(window as any)._focusAgent = async (terminalId: string) => {
  if (!terminalId) return;
  try {
    await invoke("focus_tab", { terminal_id: terminalId });
  } catch (e) {
    console.error("Focus failed:", e);
  }
};

// ── Main loop ──

let previousWaitingCount = 0;

async function tick(): Promise<void> {
  try {
    // 1. Check Ghostty
    ghosttyAvailable = (await invoke("check_ghostty_running")) as boolean;

    if (!ghosttyAvailable) {
      agents.clear();
      render();
      return;
    }

    // 2. Read hook events (immediate, rich)
    const events = (await invoke("read_hook_events")) as HookEvent[];
    for (const event of events) {
      processHookEvent(event);
    }

    // 3. Poll tabs (fallback + terminal ID matching)
    const tabs = (await invoke("list_ghostty_tabs")) as TerminalTab[];
    processTabPoll(tabs);
    matchAgentsToTabs(tabs);

    // 4. Stale detection
    detectStale();

    // 5. Auto-approve safe operations
    for (const agent of agents.values()) {
      if (agent.state === "waiting-approval") {
        await handleAutoApprove(agent);
      }
    }

    // 6. Auto-focus if new waiting agents appeared
    const currentWaiting = getQueue().length;
    if (currentWaiting > previousWaitingCount && currentWaiting > 0) {
      await focusNextWaiting();
    }
    previousWaitingCount = currentWaiting;

    // 7. Render
    render();
  } catch (e) {
    console.error("Tick error:", e);
    render();
  }
}

// ── Start ──

// ── Debug overlay (visible in the sidebar) ──

const debugEl = document.createElement("div");
debugEl.style.cssText = "position:fixed;bottom:40px;left:0;right:0;padding:4px 8px;font-size:9px;color:#fab387;background:rgba(0,0,0,0.8);z-index:999;max-height:80px;overflow:auto;white-space:pre-wrap;";
document.body.appendChild(debugEl);

function debugLog(msg: string): void {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  debugEl.textContent = line + "\n" + (debugEl.textContent || "").split("\n").slice(0, 5).join("\n");
}

async function init(): Promise<void> {
  debugLog("init: starting...");
  try {
    await invoke("ensure_hook_dir");
    debugLog("init: hook dir ready");
  } catch (e) {
    debugLog(`init: ensure_hook_dir FAILED: ${e}`);
  }

  // Test: can we call any Tauri command?
  try {
    const running = await invoke("check_ghostty_running");
    debugLog(`init: ghostty running = ${running}`);
  } catch (e) {
    debugLog(`init: check_ghostty FAILED: ${e}`);
  }

  try {
    const tabs = await invoke("list_ghostty_tabs");
    debugLog(`init: found ${(tabs as any[]).length} tabs`);
  } catch (e) {
    debugLog(`init: list_tabs FAILED: ${e}`);
  }

  render();
  setInterval(tick, POLL_INTERVAL);
  tick();
}

init();
