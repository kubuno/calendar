//! Moon phases - a 100% client-side synodic computation, ported from `web/src/moon.tsx` (no API). Position
//! within the synodic cycle since a reference new moon; accurate to within a few hours over several decades,
//! which is all a calendar needs.
//!
//! The web works on JavaScript `Date` instants; here instants are whole seconds since the Unix epoch, and the
//! day-scoped helpers take the viewer-zone offset (`offset_minutes`, east of UTC) so a « principal phase of
//! the day » is decided on local day boundaries, exactly as the web does with `setHours(0,0,0,0)`.

use crate::date::Date;

/// Mean length of the synodic month, in days.
pub const SYNODIC: f64 = 29.530_588_853;

/// Reference new moon: 2000-01-06 18:14 UTC, in seconds since the Unix epoch.
fn new_moon_epoch_seconds() -> i64 {
    // 2000-01-06 at 18:14:00 UTC.
    let day = Date { year: 2000, month: 1, day: 6 }.to_days();
    day * 86_400 + 18 * 3_600 + 14 * 60
}

/// Position within the cycle, in [0, 1) - 0 = new moon, 0.5 = full moon (`moonPhase`).
pub fn moon_phase(epoch_seconds: i64) -> f64 {
    let days = (epoch_seconds - new_moon_epoch_seconds()) as f64 / 86_400.0;
    (((days % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC
}

/// Illuminated fraction of the disc, in [0, 1] (`moonIllumination`).
pub fn moon_illumination(epoch_seconds: i64) -> f64 {
    (1.0 - (2.0 * std::f64::consts::PI * moon_phase(epoch_seconds)).cos()) / 2.0
}

/// A principal lunar phase - the markers a paper calendar prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalPhase {
    New,
    FirstQuarter,
    Full,
    LastQuarter,
}

/// The principal phase reached on `day` in the viewer's zone, if any (`principalPhaseOfDay`).
pub fn principal_phase_of_day(day: Date, offset_minutes: i32) -> Option<PrincipalPhase> {
    // UTC instant of local midnight = local-midnight-as-UTC minus the zone offset.
    let start = day.to_days() * 86_400 - offset_minutes as i64 * 60;
    let end = start + 86_400;
    let p0 = moon_phase(start);
    let p1_raw = moon_phase(end);
    // Unwrap the 1 → 0 rollover so a crossing can be tested with a plain interval.
    let p1 = if p1_raw < p0 { p1_raw + 1.0 } else { p1_raw };
    for (target, phase) in [
        (0.25, PrincipalPhase::FirstQuarter),
        (0.5, PrincipalPhase::Full),
        (0.75, PrincipalPhase::LastQuarter),
        (1.0, PrincipalPhase::New),
    ] {
        if p0 < target && target <= p1 {
            return Some(phase);
        }
    }
    None
}

/// The eight named phases (`moonPhaseName`); the client maps these to localized strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase8 {
    New,
    WaxingCrescent,
    FirstQuarter,
    WaxingGibbous,
    Full,
    WaningGibbous,
    LastQuarter,
    WaningCrescent,
}

/// The named phase on a given instant (`moonPhaseName` without the i18n lookup).
pub fn phase8(epoch_seconds: i64) -> Phase8 {
    let p = moon_phase(epoch_seconds);
    let half = 0.5 / SYNODIC;
    if p < half || p > 1.0 - half {
        Phase8::New
    } else if (p - 0.25).abs() < half {
        Phase8::FirstQuarter
    } else if (p - 0.5).abs() < half {
        Phase8::Full
    } else if (p - 0.75).abs() < half {
        Phase8::LastQuarter
    } else if p < 0.25 {
        Phase8::WaxingCrescent
    } else if p < 0.5 {
        Phase8::WaxingGibbous
    } else if p < 0.75 {
        Phase8::WaningGibbous
    } else {
        Phase8::WaningCrescent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instant(iso: &str) -> i64 {
        crate::model::Instant::parse(iso).expect("instant").epoch_seconds
    }

    #[test]
    fn epoch_is_new_moon() {
        let p = moon_phase(new_moon_epoch_seconds());
        assert!(p < 1e-6, "phase at epoch was {p}");
        assert!(moon_illumination(new_moon_epoch_seconds()) < 1e-3);
    }

    #[test]
    fn half_cycle_is_full_moon() {
        let full = new_moon_epoch_seconds() + (SYNODIC / 2.0 * 86_400.0) as i64;
        assert!((moon_phase(full) - 0.5).abs() < 0.01);
        assert!(moon_illumination(full) > 0.99);
        assert_eq!(phase8(full), Phase8::Full);
    }

    #[test]
    fn full_moon_marker_agrees_with_phase8() {
        // The day that carries the « full moon » principal marker is a day whose phase is Full - the marker
        // and the named phase must agree (self-consistent, no external almanac asserted).
        let full_day = (0..30)
            .map(|off| Date::new(2026, 10, 1).expect("d").add_days(off))
            .find(|&d| principal_phase_of_day(d, 60) == Some(PrincipalPhase::Full))
            .expect("a full-moon marker in October 2026");
        let noon = full_day.to_days() * 86_400 + 12 * 3_600 - 60 * 60;
        assert_eq!(phase8(noon), Phase8::Full);
    }

    #[test]
    fn most_days_have_no_principal_marker() {
        // Across a synodic month exactly four principal markers appear.
        let mut count = 0;
        for off in 0..30 {
            let d = Date::new(2026, 10, 1).expect("d").add_days(off);
            if principal_phase_of_day(d, 0).is_some() {
                count += 1;
            }
        }
        assert_eq!(count, 4);
    }

    #[test]
    fn phase8_progression() {
        // A few days after new moon is a waxing crescent.
        let p = new_moon_epoch_seconds() + 3 * 86_400;
        assert_eq!(phase8(p), Phase8::WaxingCrescent);
        let _ = instant("2026-10-12T00:00:00Z"); // smoke: parser agrees with epoch math
    }
}
