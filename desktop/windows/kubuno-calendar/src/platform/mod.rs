//! The Windows overrides of the portable extension points: the local calendar date and the viewer's zone
//! offset (the web reads instants in the browser's local zone; here we read the OS zone).

use kubuno_calendar_core::date::Date;
use kubuno_calendar_desktop_common::platform::{now_ms, Clock, Platform, Portable};
use windows::Win32::System::SystemInformation::{GetLocalTime, GetSystemTime};

/// The Windows clock: `GetLocalTime` for « today », and the local-minus-UTC difference for the zone offset.
struct WindowsClock;

impl Clock for WindowsClock {
    fn today(&self) -> Date {
        let t = unsafe { GetLocalTime() };
        Date::new(t.wYear as i32, t.wMonth as u32, t.wDay as u32)
            .unwrap_or_else(|| Date::from_days(now_ms().div_euclid(86_400_000)))
    }

    fn utc_offset_minutes(&self) -> i32 {
        let local = unsafe { GetLocalTime() };
        let utc = unsafe { GetSystemTime() };
        let minutes = |s: &windows::Win32::Foundation::SYSTEMTIME| -> i64 {
            Date::new(s.wYear as i32, s.wMonth as u32, s.wDay as u32)
                .map(|d| d.to_days() * 1_440 + s.wHour as i64 * 60 + s.wMinute as i64)
                .unwrap_or(0)
        };
        (minutes(&local) - minutes(&utc)) as i32
    }
}

/// The Windows platform: the local clock, the portable launch rules.
pub fn platform() -> Platform {
    Platform { name: "windows", launch: Box::new(Portable), clock: Box::new(WindowsClock) }
}
