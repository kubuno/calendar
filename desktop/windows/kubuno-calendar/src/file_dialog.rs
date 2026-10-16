//! Native Open / Save file dialogs (the common-dialog Win32 API), for importing and exporting `.ics` files.
//! These are ordinary shell dialogs - no process is spawned - so they are allowed under the seccomp policy.

use std::path::PathBuf;

use windows::core::PWSTR;
use windows::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, GetSaveFileNameW, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW};

/// UTF-16, NUL-terminated.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a NUL-terminated UTF-16 buffer back to a `String`.
fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// The `.ics` filter, as the double-NUL-terminated list the common dialogs want.
fn ics_filter() -> Vec<u16> {
    let mut v = Vec::new();
    for part in ["iCalendar (*.ics)", "*.ics", "All files (*.*)", "*.*"] {
        v.extend(part.encode_utf16());
        v.push(0);
    }
    v.push(0);
    v
}

/// Ask the user for an existing `.ics` file to open.
pub fn open_ics(title: &str) -> Option<PathBuf> {
    let mut file = vec![0u16; 1024];
    let filter = ics_filter();
    let title_w = wide(title);
    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: windows::core::PCWSTR(filter.as_ptr()),
        lpstrFile: PWSTR(file.as_mut_ptr()),
        nMaxFile: file.len() as u32,
        lpstrTitle: windows::core::PCWSTR(title_w.as_ptr()),
        Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY,
        ..Default::default()
    };
    let ok = unsafe { GetOpenFileNameW(&mut ofn) }.as_bool();
    if ok {
        Some(PathBuf::from(from_wide(&file)))
    } else {
        None
    }
}

/// Ask the user where to save an exported `.ics`, suggesting `default_name`.
pub fn save_ics(title: &str, default_name: &str) -> Option<PathBuf> {
    let mut file = wide(default_name);
    file.resize(1024, 0);
    let filter = ics_filter();
    let title_w = wide(title);
    let ext = wide("ics");
    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: windows::core::PCWSTR(filter.as_ptr()),
        lpstrFile: PWSTR(file.as_mut_ptr()),
        nMaxFile: file.len() as u32,
        lpstrTitle: windows::core::PCWSTR(title_w.as_ptr()),
        lpstrDefExt: windows::core::PCWSTR(ext.as_ptr()),
        Flags: OFN_OVERWRITEPROMPT | OFN_HIDEREADONLY,
        ..Default::default()
    };
    let ok = unsafe { GetSaveFileNameW(&mut ofn) }.as_bool();
    if ok {
        Some(PathBuf::from(from_wide(&file)))
    } else {
        None
    }
}
