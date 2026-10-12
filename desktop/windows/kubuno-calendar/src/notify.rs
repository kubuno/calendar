//! Native desktop notifications for the reminder worker — a balloon from a notification-area icon
//! (`Shell_NotifyIcon`, the same mechanism the Kubuno desktop shell uses). A single hidden message-only window
//! owns one tray icon; each reminder updates it with `NIF_INFO` to pop a balloon.

use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_TIP, NIM_ADD, NIM_MODIFY, NOTIFYICONDATAW, NOTIFYICONDATAW_0, NIIF_INFO};
use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, LoadIconW, RegisterClassW, HICON, IDI_APPLICATION, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW};

/// UTF-16 copy into a fixed `[u16; N]` field (truncated, NUL-terminated).
fn put(dst: &mut [u16], s: &str) {
    let w: Vec<u16> = s.encode_utf16().take(dst.len() - 1).collect();
    dst[..w.len()].copy_from_slice(&w);
    dst[w.len()] = 0;
    for c in &mut dst[w.len() + 1..] {
        *c = 0;
    }
}

struct Notifier {
    hwnd: HWND,
    icon: HICON,
}

// SAFETY: the Notifier is only ever used from the one worker thread it is created on; the raw handles are not
// shared across threads. It is stored in a thread-local, so this marker is for the OnceLock bound only.
unsafe impl Send for Notifier {}
unsafe impl Sync for Notifier {}

extern "system" fn wndproc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(h, msg, w, l) }
}

fn notifier() -> Option<&'static Notifier> {
    static N: OnceLock<Option<Notifier>> = OnceLock::new();
    N.get_or_init(|| unsafe {
        let hinst = GetModuleHandleW(PCWSTR::null()).ok()?;
        let class_name: Vec<u16> = "KubunoCalendarNotify\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);
        // A hidden top-level window owns the tray icon (a message-only window cannot show balloons).
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(hinst.into()),
            None,
        )
        .ok()?;
        let icon = LoadIconW(None, IDI_APPLICATION).unwrap_or_default();
        let mut data = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: 1,
            uFlags: NIF_ICON | NIF_TIP,
            hIcon: icon,
            ..Default::default()
        };
        put(&mut data.szTip, "Kubuno Agenda");
        let _ = Shell_NotifyIconW(NIM_ADD, &data);
        Some(Notifier { hwnd, icon })
    })
    .as_ref()
}

/// Start the reminder worker (web `CalendarNotificationWorker`): a background thread that, every minute, fetches
/// the upcoming events of `doc`, checks which reminders fall due, and pops a native notification for each new
/// one — honouring the user's notifications mode (`off` / `in_app` / `desktop`). Detached; it ends with the
/// process. `offset_minutes` is the local-zone offset (for the notification time), `fr` the UI language.
pub fn start_worker(doc: String, offset_minutes: i32, fr: bool) {
    std::thread::spawn(move || {
        let mut fired: std::collections::HashSet<String> = std::collections::HashSet::new();
        loop {
            run_cycle(&doc, offset_minutes, fr, &mut fired);
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}

fn run_cycle(doc: &str, offset_minutes: i32, fr: bool, fired: &mut std::collections::HashSet<String>) {
    use kubuno_calendar_desktop_common::{live, reminders};
    let settings = live::fetch_calendar_settings().unwrap_or_default();
    let mode = settings.get("notifications_mode").map(|v| v.as_string()).unwrap_or_else(|| "in_app".to_string());
    if mode == "off" {
        return;
    }
    let only_accepted = settings.get("notify_only_if_accepted").map(|v| v.as_bool()).unwrap_or(false);

    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return,
    };
    let today = kubuno_calendar_core::date::Date::from_days(now.div_euclid(86_400));
    let until = kubuno_calendar_core::date::Date::from_days(today.to_days() + 8);
    let events = match live::fetch_events(doc, today, until) {
        Ok(e) => e,
        Err(_) => return,
    };
    for d in reminders::due_reminders(&events, now, 60, only_accepted) {
        if fired.insert(d.key.clone()) {
            let body = reminders::reminder_body(&d, offset_minutes, fr);
            toast(&d.title, &body);
        }
    }
}

/// Pop a balloon notification for a reminder. No-op if the icon could not be created.
pub fn toast(title: &str, body: &str) {
    let Some(n) = notifier() else {
        return;
    };
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: n.hwnd,
        uID: 1,
        uFlags: NIF_INFO | NIF_ICON,
        hIcon: n.icon,
        Anonymous: NOTIFYICONDATAW_0 { uTimeout: 10_000 },
        dwInfoFlags: NIIF_INFO,
        ..Default::default()
    };
    put(&mut data.szInfoTitle, title);
    put(&mut data.szInfo, body);
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &data);
    }
}
