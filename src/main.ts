/**
 * main.ts — Frontend entry point for Claude Command Center overlay
 *
 * Renders the agent list, queue, and summary from agent-monitor state.
 * Communicates with the Tauri backend via invoke/events.
 */

import type { AgentInfo } from "./lib/agent-monitor.js";

// ── State ──

let agents: AgentInfo[] = [];
let queue: AgentInfo[] = [];
let activeAgentId: string | null = null;

// ── DOM references ──

const agentListEl = document.getElementById("agent-list")!;
const queueSectionEl = document.getElementById("queue-section")!;
const queueListEl = document.getElementById("queue-list")!;
const emptyStateEl = document.getElementById("empty-state")!;
const statRunning = document.getElementById("stat-running")!;
const statWaiting = document.getElementById("stat-waiting")!;
const statDone = document.getElementById("stat-done")!;

// ── Rendering ──

function dotClass(state: AgentInfo["state"]): string {
  switch (state) {
    case "running":
      return "dot-green";
    case "waiting-input":
      return "dot-yellow";
    case "waiting-approval":
      return "dot-red";
    case "stale":
      return "dot-orange";
    case "done":
      return "dot-gray";
    default:
      return "dot-gray";
  }
}

function stateLabel(agent: AgentInfo): string {
  switch (agent.state) {
    case "running":
      return "Running";
    case "waiting-input":
      return "Waiting for input";
    case "waiting-approval":
      return "Needs approval";
    case "stale":
      return "Stale — no activity 5m+";
    case "done":
      return "Done";
    default:
      return "Unknown";
  }
}

function rowClasses(agent: AgentInfo): string {
  const classes = ["agent-row"];
  if (agent.sessionId === activeAgentId) classes.push("active");
  if (agent.state === "waiting-input") classes.push("waiting");
  if (agent.state === "waiting-approval") classes.push("destructive");
  if (agent.state === "stale") classes.push("stale");
  return classes.join(" ");
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function renderBadge(agent: AgentInfo): string {
  if (agent.state === "waiting-approval") {
    return '<div class="badge badge-destructive">DESTRUCTIVE</div>';
  }
  if (agent.autoApproveCount > 0) {
    return `<div class="badge badge-auto">${agent.autoApproveCount} auto</div>`;
  }
  if (agent.state === "stale") {
    return '<div class="badge badge-stale">?</div>';
  }
  if (agent.detectionMethod === "hook") {
    return '<div class="badge badge-hook">via hook</div>';
  }
  return "";
}

function renderAgentRow(agent: AgentInfo): string {
  const preview = agent.message
    ? `<div class="agent-preview">${escapeHtml(agent.message)}</div>`
    : "";

  return `
    <div class="${rowClasses(agent)}" data-id="${agent.sessionId}">
      <div class="agent-dot"><span class="dot ${dotClass(agent.state)}"></span></div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(agent.name)}</div>
        <div class="agent-status">${stateLabel(agent)}</div>
        ${preview}
      </div>
      <div class="agent-meta">
        <div class="agent-time">${agent.state === "done" ? "—" : timeAgo(agent.stateChangedAt)}</div>
        ${renderBadge(agent)}
      </div>
    </div>
  `;
}

function renderQueueItem(agent: AgentInfo, index: number): string {
  return `
    <div class="queue-item" data-id="${agent.sessionId}">
      <span class="queue-num">${index + 1}</span>
      <span class="dot ${dotClass(agent.state)}"></span>
      <span>${escapeHtml(agent.name)} — ${escapeHtml(agent.message || "waiting")}</span>
    </div>
  `;
}

function render(): void {
  // Queue
  if (queue.length > 0) {
    queueSectionEl.classList.remove("hidden");
    queueListEl.innerHTML = queue
      .map((a, i) => renderQueueItem(a, i))
      .join("");
  } else {
    queueSectionEl.classList.add("hidden");
  }

  // Agent list
  if (agents.length > 0) {
    emptyStateEl.classList.add("hidden");
    agentListEl.innerHTML = agents.map(renderAgentRow).join("");
  } else {
    emptyStateEl.classList.remove("hidden");
    agentListEl.innerHTML = "";
  }

  // Summary
  const running = agents.filter(
    (a) => a.state === "running"
  ).length;
  const waiting = agents.filter(
    (a) => a.state === "waiting-input" || a.state === "waiting-approval"
  ).length;
  const done = agents.filter((a) => a.state === "done").length;

  statRunning.innerHTML = `<span class="dot dot-green"></span> ${running} running`;
  statWaiting.innerHTML = `<span class="dot dot-yellow"></span> ${waiting} waiting`;
  statDone.innerHTML = `<span class="dot dot-gray"></span> ${done} done`;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Demo data for development ──

function loadDemoData(): void {
  const now = Date.now();
  agents = [
    {
      sessionId: "demo-1",
      name: "ceo-agent",
      cwd: "/agents/ceo",
      state: "waiting-approval",
      lastHookTime: now - 12000,
      stateChangedAt: now - 12000,
      message: 'git push origin main --force',
      toolName: "Bash",
      toolInput: { command: "git push origin main --force" },
      autoApproveCount: 0,
      detectionMethod: "hook",
    },
    {
      sessionId: "demo-2",
      name: "instagram-exec",
      cwd: "/agents/instagram-executor",
      state: "waiting-input",
      lastHookTime: now - 45000,
      stateChangedAt: now - 45000,
      message: "Which variant do you prefer? A or B?",
      autoApproveCount: 0,
      detectionMethod: "hook",
    },
    {
      sessionId: "demo-3",
      name: "lead-enrichment",
      cwd: "/agents/lead-enrichment",
      state: "running",
      lastHookTime: now - 120000,
      stateChangedAt: now - 120000,
      autoApproveCount: 3,
      detectionMethod: "hook",
    },
    {
      sessionId: "demo-4",
      name: "slack-agent",
      cwd: "/agents/slack",
      state: "running",
      lastHookTime: now - 300000,
      stateChangedAt: now - 300000,
      autoApproveCount: 0,
      detectionMethod: "hook",
    },
    {
      sessionId: "demo-5",
      name: "x-content",
      cwd: "/agents/x-content",
      state: "running",
      lastHookTime: now - 480000,
      stateChangedAt: now - 480000,
      autoApproveCount: 0,
      detectionMethod: "polling",
    },
    {
      sessionId: "demo-6",
      name: "screening",
      cwd: "/agents/screening",
      state: "stale",
      lastHookTime: now - 360000,
      stateChangedAt: now - 60000,
      message: "No activity for 5+ minutes",
      autoApproveCount: 0,
      detectionMethod: "hook",
    },
  ];

  queue = agents.filter(
    (a) => a.state === "waiting-input" || a.state === "waiting-approval"
  ).sort((a, b) => {
    // Destructive first
    if (a.state === "waiting-approval" && b.state !== "waiting-approval") return -1;
    if (b.state === "waiting-approval" && a.state !== "waiting-approval") return 1;
    return a.stateChangedAt - b.stateChangedAt;
  });

  render();
}

// ── Init ──

// For now, load demo data. Real integration will use Tauri events.
loadDemoData();

// Update time displays every second
setInterval(() => {
  const timeEls = document.querySelectorAll(".agent-time");
  timeEls.forEach((el, i) => {
    if (agents[i] && agents[i].state !== "done") {
      el.textContent = timeAgo(agents[i].stateChangedAt);
    }
  });
}, 1000);
