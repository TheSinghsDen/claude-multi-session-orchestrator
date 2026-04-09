use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
                // Set to screen-saver level for fullscreen app compatibility
                let _ = window.set_always_on_top(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
