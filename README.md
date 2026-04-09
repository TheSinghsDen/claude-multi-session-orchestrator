# Claude Command Center

Floating sidebar overlay for managing multiple Claude Code sessions in Ghostty.

Auto-switches tabs when an agent needs your attention. Shows a priority queue of waiting sessions. Auto-approves safe operations (Read, Glob, Grep) without interrupting you.

## How it works

```
Claude Code sessions (Ghostty tabs)
        │
        ├──[hooks]──→ Notification hooks write state to /tmp/cc-state/
        │              (instant detection, rich context)
        │
        └──[fallback]─→ Tab title emoji polling via AppleScript
                         (2s intervals, coarser)

State files → Agent Monitor → Priority Queue → Tab switching + Audio alerts
```

## Requirements

- macOS (Ghostty's AppleScript API is macOS-only)
- [Ghostty](https://ghostty.org) 1.3.0+
- [Claude Code](https://claude.ai/code) running in Ghostty tabs

## Quick Start

**From source (development):**

```bash
# Requires Rust toolchain (rustup.rs) and Node.js
git clone https://github.com/TheSinghsDen/claude-multi-session-orchestrator.git
cd claude-multi-session-orchestrator
npm install
npx tauri dev
```

**Pre-built binary:** Coming soon on [GitHub Releases](https://github.com/TheSinghsDen/claude-multi-session-orchestrator/releases).

## Architecture

4 modules:

| Module | Purpose |
|--------|---------|
| `ghostty-bridge.ts` | AppleScript interface for tab enumeration, focus, and targeted input |
| `agent-monitor.ts` | Hook file watcher, state classifier, auto-approve engine, priority queue |
| `audio.ts` | Differentiated alert sounds via macOS afplay |
| Tauri webview | Sidebar overlay UI (HTML/CSS/JS) |

## Detection: Hooks-first

The command center uses Claude Code notification hooks as the primary detection mechanism. Hooks fire immediately and provide rich JSON (session_id, cwd, tool name, message text).

Tab-title emoji polling is the fallback for sessions without hooks configured.

## Status

Early development. Built for personal use, sharing because other Claude Code power users have the same tab-hunting problem.

## License

MIT
