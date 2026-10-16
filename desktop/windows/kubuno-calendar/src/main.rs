//! Kubuno Calendar for Windows (`kubuno-calendar.exe`) - `Program.cs`: the app of desktop/common with the
//! Windows platform registered and the Win32 window as its user interface.
//!
//! `kubuno-calendar [--dark] [--culture fr|en] [--view month|week|day|year|schedule] [--date yyyy-mm-dd]
//!  [--sample | --live]`

// A GUI application: no console window, in Debug too.
#![windows_subsystem = "windows"]

fn main() {
    let code = kubuno_calendar_desktop_common::app::run(
        kubuno_calendar::platform::platform(),
        &kubuno_calendar::WindowsUi,
    );
    std::process::exit(code);
}
