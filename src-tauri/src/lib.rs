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
          select t
          activate w
          focus term
          return
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
