use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalTab {
    pub tab_index: u32,
    pub tab_name: String,
    pub terminal_id: String,
    pub working_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookEvent {
    pub session_id: String,
    pub event_type: String,
    pub tool_name: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub timestamp: String,
    pub cwd: Option<String>,
    pub tty: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TtyMapping {
    pub tty: String,
    pub terminal_id: String,
}

// ── Tauri Commands ──

#[tauri::command]
fn list_ghostty_tabs() -> Result<Vec<TerminalTab>, String> {
    let script = r#"
tell application "Ghostty"
  set output to ""
  set windowList to every window
  repeat with w in windowList
    set tabList to every tab of w
    repeat with t in tabList
      set tabName to name of t
      set tabIdx to index of t
      set termList to every terminal of t
      repeat with term in termList
        set termId to id of term
        set termDir to working directory of term
        set output to output & tabIdx & "\t" & tabName & "\t" & termId & "\t" & termDir & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AppleScript error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let tabs: Vec<TerminalTab> = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 4 {
                Some(TerminalTab {
                    tab_index: parts[0].parse().unwrap_or(0),
                    tab_name: parts[1].to_string(),
                    terminal_id: parts[2].to_string(),
                    working_directory: parts[3].to_string(),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(tabs)
}

#[tauri::command]
fn focus_tab(terminal_id: String) -> Result<(), String> {
    let script = format!(
        r#"
tell application "Ghostty"
  repeat with w in every window
    repeat with t in every tab of w
      repeat with term in every terminal of t
        if id of term is "{}" then
          focus term
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell"#,
        terminal_id
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Focus failed: {}", stderr));
    }

    Ok(())
}

#[tauri::command]
fn send_input(terminal_id: String, text: String) -> Result<(), String> {
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"
tell application "Ghostty"
  repeat with w in every window
    repeat with t in every tab of w
      repeat with term in every terminal of t
        if id of term is "{}" then
          input text "{}" to term
          return
        end if
      end repeat
    end repeat
  end repeat
end tell"#,
        terminal_id, escaped
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Send input failed: {}", stderr));
    }

    Ok(())
}

#[tauri::command]
fn read_hook_events() -> Result<Vec<HookEvent>, String> {
    let state_dir = PathBuf::from("/tmp/cc-state");
    if !state_dir.exists() {
        return Ok(vec![]);
    }

    let mut events = Vec::new();

    let entries = fs::read_dir(&state_dir).map_err(|e| format!("Read dir error: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        match fs::read_to_string(&path) {
            Ok(content) => {
                if let Ok(event) = serde_json::from_str::<HookEvent>(&content) {
                    events.push(event);
                }
                // Remove processed file
                let _ = fs::remove_file(&path);
            }
            Err(_) => continue,
        }
    }

    Ok(events)
}

#[tauri::command]
fn play_sound(sound_type: String) -> Result<(), String> {
    let sound_path = match sound_type.as_str() {
        "needs-input" => "/System/Library/Sounds/Glass.aiff",
        "needs-approval" => "/System/Library/Sounds/Submarine.aiff",
        "destructive" => "/System/Library/Sounds/Basso.aiff",
        "done" => "/System/Library/Sounds/Purr.aiff",
        _ => return Err("Unknown sound type".to_string()),
    };

    let volume = match sound_type.as_str() {
        "needs-input" => "0.6",
        "needs-approval" => "0.8",
        "destructive" => "1.0",
        "done" => "0.3",
        _ => "0.5",
    };

    // Fire and forget — audio is non-blocking
    let _ = Command::new("afplay")
        .arg("-v")
        .arg(volume)
        .arg(sound_path)
        .spawn();

    Ok(())
}

#[tauri::command]
fn check_ghostty_running() -> bool {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events" to return (name of processes) contains "Ghostty""#)
        .output();

    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == "true",
        Err(_) => false,
    }
}

#[tauri::command]
fn ensure_hook_dir() -> Result<(), String> {
    fs::create_dir_all("/tmp/cc-state").map_err(|e| format!("Failed to create hook dir: {}", e))
}

/// Build a map of TTY device → Ghostty terminal_id.
/// Uses `ps` to find shell processes whose grandparent is Ghostty,
/// then matches their TTY to the Ghostty terminal by correlating
/// the shell's cwd with the terminal's working_directory.
#[tauri::command]
fn get_tty_map() -> Result<Vec<TtyMapping>, String> {
    // Step 1: Get Ghostty's PID
    let ghostty_pid_output = Command::new("pgrep")
        .arg("-x")
        .arg("Ghostty")
        .output()
        .map_err(|e| format!("pgrep failed: {}", e))?;

    let ghostty_pid = String::from_utf8_lossy(&ghostty_pid_output.stdout)
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    if ghostty_pid.is_empty() {
        return Ok(vec![]);
    }

    // Step 2: Find all shell processes under Ghostty with their TTY and CWD
    // ps output: PID TTY PPID COMMAND
    let ps_output = Command::new("ps")
        .args(["-eo", "pid,tty,ppid,args"])
        .output()
        .map_err(|e| format!("ps failed: {}", e))?;

    let ps_text = String::from_utf8_lossy(&ps_output.stdout);

    // Find shells whose parent's parent is Ghostty (login → shell)
    // Or whose parent is Ghostty directly
    let mut tty_to_cwd: Vec<(String, String)> = Vec::new();

    for line in ps_text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let pid = parts[0];
        let tty = parts[1];
        let ppid = parts[2];

        if tty == "??" || !tty.starts_with("ttys") {
            continue;
        }

        // Check if this is a shell whose grandparent is Ghostty
        // (Ghostty → login → shell) or parent is Ghostty
        let gppid_output = Command::new("ps")
            .args(["-o", "ppid=", "-p", ppid])
            .output();

        let is_ghostty_child = ppid == ghostty_pid;
        let is_ghostty_grandchild = match &gppid_output {
            Ok(o) => String::from_utf8_lossy(&o.stdout).trim() == ghostty_pid,
            Err(_) => false,
        };

        if is_ghostty_child || is_ghostty_grandchild {
            // Get this process's cwd via lsof
            let lsof_output = Command::new("lsof")
                .args(["-a", "-p", pid, "-d", "cwd", "-Fn"])
                .output();

            if let Ok(lo) = lsof_output {
                let lsof_text = String::from_utf8_lossy(&lo.stdout);
                for l in lsof_text.lines() {
                    if l.starts_with('n') && l.len() > 1 {
                        tty_to_cwd.push((tty.to_string(), l[1..].to_string()));
                    }
                }
            }
        }
    }

    // Step 3: Get Ghostty terminals with their working directories
    let tabs = list_ghostty_tabs().unwrap_or_default();

    // Step 4: Match TTY → terminal_id via cwd correlation
    let mut mappings: Vec<TtyMapping> = Vec::new();
    let mut claimed_terminals: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (tty, cwd) in &tty_to_cwd {
        // Find a terminal with matching cwd that isn't already claimed
        if let Some(tab) = tabs.iter().find(|t| {
            t.working_directory == *cwd && !claimed_terminals.contains(&t.terminal_id)
        }) {
            mappings.push(TtyMapping {
                tty: tty.clone(),
                terminal_id: tab.terminal_id.clone(),
            });
            claimed_terminals.insert(tab.terminal_id.clone());
        }
    }

    Ok(mappings)
}

#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| format!("Drag failed: {}", e))
}

// ── App Setup ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_ghostty_tabs,
            focus_tab,
            send_input,
            read_hook_events,
            play_sound,
            check_ghostty_running,
            ensure_hook_dir,
            start_drag,
            get_tty_map,
        ])
        .setup(|app| {
            // Position sidebar on the right edge of the screen
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(monitor) = window.current_monitor() {
                    if let Some(monitor) = monitor {
                        let screen_size = monitor.size();
                        let scale = monitor.scale_factor();
                        let width = 300.0;
                        let x = (screen_size.width as f64 / scale) - width;
                        let _ = window.set_position(tauri::Position::Logical(
                            tauri::LogicalPosition::new(x, 0.0),
                        ));
                        let _ = window.set_size(tauri::Size::Logical(
                            tauri::LogicalSize::new(width, screen_size.height as f64 / scale),
                        ));
                    }
                }
                let _ = window.set_always_on_top(true);
            }

            // Ensure hook state directory exists
            let _ = fs::create_dir_all("/tmp/cc-state");

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
