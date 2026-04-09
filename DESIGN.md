# Design System — Claude Command Center

## Product Context
- **What this is:** Floating desktop sidebar overlay for managing multiple Claude Code sessions
- **Who it's for:** Claude Code power users running 3-10 concurrent AI agent sessions in Ghostty
- **Space/industry:** Developer tools, terminal utilities, AI agent orchestration
- **Project type:** Desktop overlay (Tauri v2, macOS-first)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Retro-Futuristic touches
- **Decoration level:** Minimal. No gradients, no shadows, no rounded cards. Color only for status.
- **Mood:** Submarine control panel. Every element earns its pixel. Calm, purposeful, information-dense. The data IS the decoration.
- **Reference sites:** Linear (dimmed sidebar pattern), Raycast (native macOS overlay), Warp (UI surface on dark themes), Vercel dashboard (data density)

## Typography
- **Display/Hero:** JetBrains Mono 600
- **Body:** JetBrains Mono 400
- **UI/Labels:** JetBrains Mono 300 at 9-10px
- **Data/Tables:** JetBrains Mono 400 (tabular-nums enabled)
- **Loading:** Bundled with Tauri app (Google Fonts for dev)
- **Scale:** 13px (agent names), 11px (status text, queue items), 10px (metadata, previews), 9px (labels, hints, keyboard shortcuts)

## Color
- **Approach:** Restrained. Color communicates status, nothing else.
- **Background:** #11111b at 85% opacity
- **Surface:** rgba(30,30,46,0.6)
- **Text primary:** #cdd6f4
- **Text secondary:** #a6adc8
- **Text muted:** #6c7086
- **Text faint:** #585b70
- **Accent:** #89b4fa (active states, focus rings, links)
- **Status green (running):** #a6e3a1 with 4px glow shadow
- **Status yellow (waiting):** #f9e2af with 4px glow shadow
- **Status red (destructive):** #f38ba8 with 4px glow shadow
- **Status orange (stale):** #fab387 with 3px glow shadow
- **Status gray (done):** #45475a (no glow)
- **Dark mode:** Dark-only. Terminal tools are always dark.
- **Base palette:** Catppuccin Mocha

## Status Indicators (Color + Shape)
- **Running:** Green filled circle with subtle pulse (opacity 0.6-1.0, 2s)
- **Waiting for input:** Yellow diamond
- **Needs approval:** Red triangle (+ "DESTRUCTIVE" badge for dangerous ops)
- **Stale/crashed:** Orange question mark
- **Done:** Gray checkmark
- Shapes provide a11y differentiation for colorblind users

## Spacing
- **Base unit:** 4px
- **Density:** Compact (8+ agents visible without scrolling)
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32)
- **Row padding:** 10px vertical, 14px horizontal
- **Gap tight:** 6px, Gap normal: 10px

## Layout
- **Approach:** Grid-disciplined, single column
- **Sidebar width:** 300px fixed (v1)
- **Inline expand:** Context panel expands rows in-place, sidebar widens to ~500px temporarily
- **Border radius:** 0px (rows), 4px (buttons, badges), 8px (sidebar container only)

## Information Hierarchy
1. ATTENTION QUEUE (top) — what needs the user NOW
2. Agent list (middle) — all sessions with status
3. Summary bar (footer) — ambient counts

## Motion
- **Approach:** Minimal-functional
- **Status dot pulse:** opacity 0.6-1.0, 2s cycle
- **New agent slide-in:** translateX(-20px) to 0, 200ms ease-out
- **State color transition:** 150ms crossfade
- No decorative animations

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-09 | Initial design system | Competitive research (Linear, Raycast, Warp) + /office-hours design doc |
| 2026-04-09 | Catppuccin Mocha palette | Widely adopted in terminal ecosystem, good a11y contrast |
| 2026-04-09 | JetBrains Mono only | Terminal tool = monospace only. Zero coherence risk. |
| 2026-04-09 | Shape-differentiated status | a11y for colorblind users + visual character |
| 2026-04-09 | Queue-on-top hierarchy | Action items first, ambient info last |
| 2026-04-09 | #11111b at 85% opacity | Darker base for better contrast on variable terminal backgrounds |
