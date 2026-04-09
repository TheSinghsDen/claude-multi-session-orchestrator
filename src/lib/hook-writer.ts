#!/usr/bin/env node
/**
 * hook-writer.ts — Claude Code hook script
 *
 * Receives JSON on stdin from Claude Code hooks, writes to /tmp/cc-state/{session_id}.json
 * The agent-monitor watches this directory for new files.
 *
 * Install: add to ~/.claude/settings.json hooks for PermissionRequest, PostToolUse, etc.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_DIR = "/tmp/cc-state";

// Ensure state directory exists
mkdirSync(STATE_DIR, { recursive: true });

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  try {
    const raw = JSON.parse(input);
    const event = {
      session_id: raw.session_id || "unknown",
      event_type: raw.hook_event_name || "unknown",
      tool_name: raw.tool_name,
      payload: raw.tool_input || {},
      timestamp: new Date().toISOString(),
      cwd: raw.cwd,
    };

    const filename = `${event.session_id}-${Date.now()}.json`;
    writeFileSync(join(STATE_DIR, filename), JSON.stringify(event));
  } catch {
    // Silent failure — don't break Claude Code
  }
  process.exit(0);
});

// Timeout safety
setTimeout(() => process.exit(0), 2000);
