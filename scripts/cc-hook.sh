#!/bin/bash
# Claude Command Center hook — writes Claude Code events to /tmp/cc-state/
# Installed into ~/.claude/settings.json alongside existing hooks.
# Reads JSON from stdin, extracts key fields, writes to state file.

mkdir -p /tmp/cc-state

INPUT=$(cat)

# Extract fields using node (fast, available on all dev machines)
node -e "
const raw = JSON.parse(process.argv[1]);
const event = {
  session_id: raw.session_id || 'unknown',
  event_type: raw.hook_event_name || 'unknown',
  tool_name: raw.tool_name || null,
  payload: raw.tool_input || null,
  timestamp: new Date().toISOString(),
  cwd: raw.cwd || null,
};
const fs = require('fs');
const filename = event.session_id + '-' + Date.now() + '.json';
fs.writeFileSync('/tmp/cc-state/' + filename, JSON.stringify(event));
" "$INPUT" 2>/dev/null

exit 0
