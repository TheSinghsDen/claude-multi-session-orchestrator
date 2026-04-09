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

// ── Tab title → state + name ──

const BRAILLE_CHARS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠒";
const EMOJI_STATES: [string, AgentState][] = [
  ...BRAILLE_CHARS.split("").map((c): [string, AgentState] => [c, "running"]),
  ["⏳", "running"],
  ["✳", "done"],
  ["🔔", "waiting-input"],
  ["⏸", "done"],
];

function classifyFromTitle(title: string): AgentState {
  for (const [emoji, state] of EMOJI_STATES) {
    if (title.includes(emoji)) return state;
  }
  return "unknown";
}

const STRIP_RE = new RegExp(`^[\\s${BRAILLE_CHARS}⏳✳🔔⏸]+`);

function nameFromTabTitle(title: string): string {
  let name = title.replace(STRIP_RE, "").trim();
  if (!name || name === "Claude Code") return "";
  if (name.length > 40) name = name.slice(0, 37) + "...";
  return name;
}

// ── Auto-approve ──

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
}

// ── Process tab polling ──

function processTabPoll(tabs: TerminalTab[]): void {
  const now = Date.now();
  const seenTerminals = new Set<string>();

  for (const tab of tabs) {
    seenTerminals.add(tab.terminal_id);

    const hookAgent = Array.from(agents.values()).find(
      (a) => a.detectionMethod === "hook" && a.cwd === tab.working_directory
    );
    if (hookAgent) {
      hookAgent.terminalId = tab.terminal_id;
      // Also update name from tab title if hook agent has a generic name
      const titleName = nameFromTabTitle(tab.tab_name);
      if (titleName && (hookAgent.name === agentNameFromCwd(hookAgent.cwd))) {
        hookAgent.name = titleName;
      }
      continue;
    }

    const state = classifyFromTitle(tab.tab_name);
    if (state === "unknown") continue;

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

    if (titleName) agent.name = titleName;
    agent.state = state === "unknown" ? agent.state : state;
    agent.terminalId = tab.terminal_id;
    agent.lastEventTime = now;

    if (agent.state !== prevState) {
      agent.stateChangedAt = now;
    }

    agents.set(pollId, agent);
  }

  for (const [id, agent] of agents) {
    if (agent.terminalId && !seenTerminals.has(agent.terminalId)) {
      agents.delete(id);
    }
  }
}

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
    await invoke("send_input", { terminalId: agent.terminalId, text: "y\n" });
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

async function focusAgent(terminalId: string): Promise<void> {
  if (!terminalId) return;
  try {
    const result = await invoke("focus_tab", { terminalId: terminalId });
    console.log("focus_tab result:", result);
  } catch (e: any) {
    console.error("focus_tab FAILED:", e);
    // Show error visually so we can see it
    const errEl = document.createElement("div");
    errEl.style.cssText = "position:fixed;top:0;left:0;right:0;padding:8px;background:#f38ba8;color:#000;font-size:11px;z-index:999;";
    errEl.textContent = `focus_tab error: ${e?.message || e}`;
    document.body.appendChild(errEl);
    setTimeout(() => errEl.remove(), 5000);
  }
}

async function focusNextWaiting(): Promise<void> {
  const queue = getQueue();
  if (queue.length === 0) return;

  const next = queue[0];
  if (!next.terminalId) return;

  await focusAgent(next.terminalId);
  try {
    await invoke("play_sound", {
      soundType: next.state === "waiting-approval" ? "needs-approval" : "needs-input",
    });
  } catch {
    // audio non-critical
  }
}

// ── Queue ──

function getQueue(): AgentInfo[] {
  return Array.from(agents.values())
    .filter((a) => a.state === "waiting-input" || a.state === "waiting-approval")
    .sort((a, b) => {
      if (a.state === "waiting-approval" && b.state !== "waiting-approval") return -1;
      if (b.state === "waiting-approval" && a.state !== "waiting-approval") return 1;
      return a.stateChangedAt - b.stateChangedAt;
    });
}

// ── Rendering (diff-based to avoid flicker) ──

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

function stateLabel(state: AgentState): string {
  switch (state) {
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

function badgeHtml(agent: AgentInfo): string {
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

/**
 * Diff-based rendering: update existing DOM elements in-place instead of
 * replacing innerHTML every tick. This eliminates the blinking/flashing.
 */

// Generate a stable key for an agent
function agentKey(agent: AgentInfo): string {
  return agent.sessionId;
}

function createAgentEl(agent: AgentInfo): HTMLElement {
  const row = document.createElement("div");
  row.className = "agent-row";
  row.dataset.key = agentKey(agent);
  // Store sessionId, look up terminalId at click time (it may not exist yet)
  row.dataset.sessionId = agent.sessionId;
  row.addEventListener("click", () => {
    const a = agents.get(row.dataset.sessionId || "");
    if (a?.terminalId) focusAgent(a.terminalId);
  });
  updateAgentEl(row, agent);
  return row;
}

function updateAgentEl(row: HTMLElement, agent: AgentInfo): void {
  // Update classes
  const classes = ["agent-row"];
  if (agent.state === "waiting-input") classes.push("waiting");
  if (agent.state === "waiting-approval") classes.push("destructive");
  if (agent.state === "stale") classes.push("stale");
  row.className = classes.join(" ");

  const preview = agent.message
    ? `<div class="agent-preview">${escHtml(agent.message)}</div>`
    : "";

  const newHtml = `
    <div class="agent-dot"><span class="dot ${dotClass(agent.state)}"></span></div>
    <div class="agent-info">
      <div class="agent-name">${escHtml(agent.name)}</div>
      <div class="agent-status">${stateLabel(agent.state)}</div>
      ${preview}
    </div>
    <div class="agent-meta">
      <div class="agent-time">${agent.state === "done" ? "—" : timeAgo(agent.stateChangedAt)}</div>
      ${badgeHtml(agent)}
    </div>`;

  // Only update innerHTML if content actually changed (skip time-only changes for most ticks)
  const currentHash = row.dataset.hash;
  // Hash excludes time to reduce unnecessary repaints
  const stableHash = `${agent.name}|${agent.state}|${agent.message || ""}|${agent.autoApproveCount}|${agent.detectionMethod}`;

  if (currentHash !== stableHash) {
    row.innerHTML = newHtml;
    row.dataset.hash = stableHash;
    row.dataset.sessionId = agent.sessionId;
  } else {
    // Just update the time element
    const timeEl = row.querySelector(".agent-time");
    if (timeEl) {
      const newTime = agent.state === "done" ? "—" : timeAgo(agent.stateChangedAt);
      if (timeEl.textContent !== newTime) {
        timeEl.textContent = newTime;
      }
    }
  }
}

function renderAgentList(sortedAgents: AgentInfo[]): void {
  const existingRows = new Map<string, HTMLElement>();
  for (const child of Array.from(agentListEl.children) as HTMLElement[]) {
    const key = child.dataset.key;
    if (key) existingRows.set(key, child);
  }

  const newKeys = sortedAgents.map(agentKey);
  const currentKeys = Array.from(existingRows.keys());

  // Remove rows that no longer exist
  for (const key of currentKeys) {
    if (!newKeys.includes(key)) {
      existingRows.get(key)!.remove();
      existingRows.delete(key);
    }
  }

  // Update or insert rows in correct order
  let prevEl: HTMLElement | null = null;
  for (const agent of sortedAgents) {
    const key = agentKey(agent);
    let row = existingRows.get(key);

    if (row) {
      updateAgentEl(row, agent);
    } else {
      row = createAgentEl(agent);
      existingRows.set(key, row);
    }

    // Ensure correct order
    const expectedNext = prevEl ? prevEl.nextElementSibling : agentListEl.firstElementChild;
    if (expectedNext !== row) {
      if (prevEl) {
        prevEl.after(row);
      } else {
        agentListEl.prepend(row);
      }
    }

    prevEl = row;
  }
}

function renderQueueList(queue: AgentInfo[]): void {
  // Queue is small (0-3 items typically), innerHTML is fine
  if (queue.length > 0) {
    queueSectionEl.classList.remove("hidden");
    queueListEl.innerHTML = queue
      .map(
        (a, i) => `
      <div class="queue-item" data-tid="${a.terminalId || ""}">
        <span class="queue-num">${i + 1}</span>
        <span class="dot ${dotClass(a.state)}"></span>
        <span>${escHtml(a.name)} — ${escHtml(a.message || "waiting")}</span>
      </div>`
      )
      .join("");
    // Attach click handlers
    for (const item of Array.from(queueListEl.querySelectorAll(".queue-item")) as HTMLElement[]) {
      item.addEventListener("click", () => {
        const tid = item.dataset.tid;
        if (tid) focusAgent(tid);
      });
    }
  } else {
    queueSectionEl.classList.add("hidden");
  }
}

function render(): void {
  const all = Array.from(agents.values());
  const queue = getQueue();

  renderQueueList(queue);

  if (all.length > 0) {
    emptyStateEl.classList.add("hidden");
    agentListEl.style.display = "";

    const sorted = [...all].sort((a, b) => {
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

    renderAgentList(sorted);
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

// ── Main loop ──

let previousWaitingCount = 0;

async function tick(): Promise<void> {
  try {
    ghosttyAvailable = (await invoke("check_ghostty_running")) as boolean;

    if (!ghosttyAvailable) {
      agents.clear();
      render();
      return;
    }

    const events = (await invoke("read_hook_events")) as HookEvent[];
    for (const event of events) {
      processHookEvent(event);
    }

    const tabs = (await invoke("list_ghostty_tabs")) as TerminalTab[];
    processTabPoll(tabs);
    matchAgentsToTabs(tabs);
    detectStale();

    for (const agent of agents.values()) {
      if (agent.state === "waiting-approval") {
        await handleAutoApprove(agent);
      }
    }

    const currentWaiting = getQueue().length;
    if (currentWaiting > previousWaitingCount && currentWaiting > 0) {
      await focusNextWaiting();
    }
    previousWaitingCount = currentWaiting;

    render();
  } catch (e) {
    console.error("Tick error:", e);
    render();
  }
}

async function init(): Promise<void> {
  try { await invoke("ensure_hook_dir"); } catch { /* non-critical */ }

  // Wire up drag bar
  const dragBar = document.getElementById("drag-bar");
  if (dragBar) {
    dragBar.addEventListener("mousedown", async (e) => {
      if (e.button === 0) {
        try { await invoke("start_drag"); } catch { /* ignore */ }
      }
    });
  }

  render();
  setInterval(tick, POLL_INTERVAL);
  tick();
}

init();
