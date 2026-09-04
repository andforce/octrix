use std::env;
#[cfg(not(debug_assertions))]
use std::net::TcpStream;
#[cfg(not(debug_assertions))]
use std::path::PathBuf;
use std::process::Command;
#[cfg(not(debug_assertions))]
use std::time::{Duration, Instant};

use tauri::Manager;

const DEFAULT_PORT: u16 = 39800;

fn escape_applescript(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn show_startup_error(message: &str) {
    eprintln!("[tauri] startup failed: {}", message);
    #[cfg(target_os = "macos")]
    {
        let escaped = escape_applescript(message);
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "display alert \"Octrix 启动失败\" message \"{}\" as critical",
                    escaped
                ),
            ])
            .output();
    }
}

#[cfg(not(debug_assertions))]
fn find_host_source_root(app: &tauri::App) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    for root in [resource_dir.join("_up_"), resource_dir] {
        if root.join("host/install.sh").exists()
            && root.join("dist-runtime/node").exists()
            && root.join("dist-server/index.mjs").exists()
        {
            return Some(root);
        }
    }
    None
}

#[cfg(not(debug_assertions))]
fn install_and_start_host(app: &tauri::App, port: u16) -> Result<(), String> {
    let source_root = find_host_source_root(app).ok_or_else(|| {
        "安装包中缺少 Octrix Host、Web TUI 或运行时资源，请重新下载安装。".to_string()
    })?;
    let installer = source_root.join("host/install.sh");
    let status = Command::new("/bin/bash")
        .arg(installer)
        .arg("--source-root")
        .arg(&source_root)
        .env("OCTRIX_LOCAL_PORT", port.to_string())
        .status()
        .map_err(|error| format!("无法运行 Octrix Host 安装器：{}", error))?;
    if !status.success() {
        return Err(format!("Octrix Host 安装器退出：{}", status));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn wait_for_host(port: u16, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err(format!(
        "Octrix Host 未能在 {} 秒内启动（端口 {}）",
        timeout.as_secs(),
        port
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let port = env::var("CLI_BRIDGE_PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(DEFAULT_PORT);

            #[cfg(not(debug_assertions))]
            {
                if let Err(error) = install_and_start_host(app, port)
                    .and_then(|_| wait_for_host(port, Duration::from_secs(30)))
                {
                    show_startup_error(&error);
                    std::process::exit(1);
                }
            }

            let url = if cfg!(debug_assertions) {
                "http://localhost:5173".to_string()
            } else {
                format!("http://127.0.0.1:{}", port)
            };

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title("Octrix")
            .theme(Some(tauri::Theme::Dark))
            .inner_size(1280.0, 860.0)
            .min_inner_size(800.0, 500.0)
            .disable_drag_drop_handler()
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(error) => show_startup_error(&error.to_string()),
    }
}
