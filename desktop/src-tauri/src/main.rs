#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct NodeProc(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // wtui.js лежит в Resources/app; зависимости — в ~/Library/Application Support/TorrentOnline
            let res = app.path().resource_dir().unwrap_or_default().join("app");
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            let deps = format!("{}/Library/Application Support/TorrentOnline", home);
            let script = format!(
                "mkdir -p '{deps}'; cp '{res}/wtui.js' '{res}/package.json' '{deps}/' 2>/dev/null; cd '{deps}'; [ -f node_modules/.installed ] || (npm i --omit=dev && touch node_modules/.installed); exec node wtui.js --web --port=8123 --no-open",
                deps = deps,
                res = res.display()
            );
            let child = Command::new("/bin/zsh")
                .args(["-l", "-c", &script])
                .spawn()
                .ok();
            app.manage(NodeProc(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("TorrentOnline: ошибка Tauri")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(s) = app.try_state::<NodeProc>() {
                    if let Some(mut c) = s.0.lock().unwrap().take() {
                        let _ = c.kill();
                    }
                }
            }
        });
}
