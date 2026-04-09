#!/bin/bash
mkdir -p /tmp/cc-state

INPUT=$(cat)

# Walk up the process tree to find a process with a real TTY
FOUND_TTY=""
CHECK_PID=$$
for i in 1 2 3 4 5; do
  CHECK_PID=$(ps -o ppid= -p $CHECK_PID 2>/dev/null | tr -d ' ')
  if [ -z "$CHECK_PID" ] || [ "$CHECK_PID" = "1" ]; then break; fi
  TTY_CHECK=$(ps -o tty= -p $CHECK_PID 2>/dev/null | tr -d ' ')
  if [ -n "$TTY_CHECK" ] && [ "$TTY_CHECK" != "??" ]; then
    FOUND_TTY="$TTY_CHECK"
    break
  fi
done

node -e "
const raw = JSON.parse(process.argv[1]);
const tty = process.argv[2] || '';
const event = {
  session_id: raw.session_id || 'unknown',
  event_type: raw.hook_event_name || 'unknown',
  tool_name: raw.tool_name || null,
  payload: raw.tool_input || null,
  timestamp: new Date().toISOString(),
  cwd: raw.cwd || null,
  tty: tty || null,
};
const fs = require('fs');
const filename = event.session_id + '-' + Date.now() + '.json';
fs.writeFileSync('/tmp/cc-state/' + filename, JSON.stringify(event));
" "$INPUT" "$FOUND_TTY" 2>/dev/null

exit 0
