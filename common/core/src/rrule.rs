//! RRULE helpers ported from `web/src/rrule.ts`: the quick presets, a parse/build round trip for the custom
//! recurrence editor, and the localized humanizer shown in the event popover and editor summary.
//!
//! This is the client-side recurrence logic the web has. It does NOT expand a rule into occurrences: the
//! Kubuno Calendar server does that and returns ready `EventInstance`s (see `crate::model`).

use crate::date::{Date, Lang};

/// iCal weekday codes indexed by JavaScript `getDay()` (Sunday = 0).
pub const WEEKDAY_BY: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/// French display order (week starting on Monday).
pub const WEEKDAYS_ORDERED: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/// The weekday code of a date (`WEEKDAY_BY[getDay()]`).
pub fn weekday_code(date: Date) -> &'static str {
    WEEKDAY_BY[date.js_day() as usize]
}

/// Build the RRULE string for a quick preset, aligned on `start`. `None` for `"none"`/unknown.
pub fn build_rrule(preset: &str, start: Date) -> Option<String> {
    match preset {
        "daily" => Some("FREQ=DAILY".to_string()),
        "weekly" => Some(format!("FREQ=WEEKLY;BYDAY={}", weekday_code(start))),
        "weekday" => Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".to_string()),
        "monthly" => Some("FREQ=MONTHLY".to_string()),
        "yearly" => Some("FREQ=YEARLY".to_string()),
        _ => None,
    }
}

/// Which quick preset an RRULE corresponds to, or `"custom"`/`"none"` (`presetFromRrule`).
pub fn preset_from_rrule(rrule: Option<&str>) -> String {
    let Some(rrule) = rrule.filter(|s| !s.is_empty()) else {
        return "none".to_string();
    };
    let parts = parse_parts(rrule);
    let get = |k: &str| parts.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let non_trivial = get("INTERVAL").is_some_and(|v| v != "1") || get("COUNT").is_some() || get("UNTIL").is_some();
    if !non_trivial {
        if get("FREQ") == Some("DAILY") {
            return "daily".to_string();
        }
        if get("BYDAY") == Some("MO,TU,WE,TH,FR") {
            return "weekday".to_string();
        }
        if get("FREQ") == Some("WEEKLY") && get("BYDAY").is_none_or(|b| b.split(',').count() == 1) {
            return "weekly".to_string();
        }
        if get("FREQ") == Some("MONTHLY") && get("BYDAY").is_none() && get("BYMONTHDAY").is_none() {
            return "monthly".to_string();
        }
        if get("FREQ") == Some("YEARLY") {
            return "yearly".to_string();
        }
    }
    "custom".to_string()
}

/// Parse `"RRULE:FREQ=WEEKLY;BYDAY=MO"` into `[(KEY, VALUE)]` with both upper-cased, preserving order
/// (`parseRruleParts`).
pub fn parse_parts(rrule: &str) -> Vec<(String, String)> {
    let body = rrule.trim_start_matches("RRULE:").trim_start_matches("rrule:");
    // The web does a case-insensitive `^RRULE:` strip; replicate for either case.
    let body = if rrule.len() >= 6 && rrule[..6].eq_ignore_ascii_case("RRULE:") {
        &rrule[6..]
    } else {
        body
    };
    body.split(';')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            let mut it = kv.splitn(2, '=');
            let k = it.next().unwrap_or("").to_uppercase();
            let v = it.next().unwrap_or("").to_uppercase();
            (k, v)
        })
        .collect()
}

/// The frequency of a custom recurrence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    fn as_str(self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "DAILY" => Some(Freq::Daily),
            "WEEKLY" => Some(Freq::Weekly),
            "MONTHLY" => Some(Freq::Monthly),
            "YEARLY" => Some(Freq::Yearly),
            _ => None,
        }
    }
}

/// How a custom recurrence ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Never,
    Count,
    Until,
}

/// MONTHLY by the date of the month, or by the rank of the weekday.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthlyMode {
    ByMonthDay,
    ByDay,
}

/// The custom-recurrence editor state (`CustomRecurrence`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomRecurrence {
    pub freq: Freq,
    pub interval: u32,
    /// WEEKLY: checked weekdays (iCal codes).
    pub byday: Vec<String>,
    pub monthly_mode: MonthlyMode,
    pub end: End,
    pub count: u32,
    /// `yyyy-MM-dd`.
    pub until: String,
}

/// Default editor state aligned on `start` (`defaultCustomRecurrence`).
pub fn default_custom_recurrence(start: Date) -> CustomRecurrence {
    CustomRecurrence {
        freq: Freq::Weekly,
        interval: 1,
        byday: vec![weekday_code(start).to_string()],
        monthly_mode: MonthlyMode::ByMonthDay,
        end: End::Never,
        count: 10,
        until: start.iso(),
    }
}

/// Interpret an existing RRULE as editor state, best effort (`parseCustomRecurrence`).
pub fn parse_custom_recurrence(rrule: Option<&str>, start: Date) -> CustomRecurrence {
    let def = default_custom_recurrence(start);
    let Some(rrule) = rrule.filter(|s| !s.is_empty()) else {
        return def;
    };
    let parts = parse_parts(rrule);
    let get = |k: &str| parts.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let freq = get("FREQ").as_deref().and_then(Freq::from_str).unwrap_or(Freq::Weekly);
    let byday: Vec<String> = get("BYDAY")
        .unwrap_or_default()
        .split(',')
        .map(strip_ordinal)
        .filter(|d| WEEKDAY_BY.contains(&d.as_str()))
        .collect();
    let until = get("UNTIL")
        .and_then(|u| parse_until_date(&u))
        .unwrap_or_else(|| def.until.clone());
    CustomRecurrence {
        freq,
        interval: get("INTERVAL").and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).max(1),
        byday: if freq == Freq::Weekly && !byday.is_empty() { byday } else { def.byday.clone() },
        monthly_mode: if freq == Freq::Monthly && get("BYDAY").is_some() {
            MonthlyMode::ByDay
        } else {
            MonthlyMode::ByMonthDay
        },
        end: if get("COUNT").is_some() {
            End::Count
        } else if get("UNTIL").is_some() {
            End::Until
        } else {
            End::Never
        },
        count: get("COUNT").and_then(|v| v.parse::<u32>().ok()).unwrap_or(10).max(1),
        until,
    }
}

/// Build the RRULE matching the custom editor state (`buildCustomRrule`).
pub fn build_custom_rrule(c: &CustomRecurrence, start: Date) -> String {
    let mut parts = vec![format!("FREQ={}", c.freq.as_str())];
    if c.interval > 1 {
        parts.push(format!("INTERVAL={}", c.interval));
    }
    if c.freq == Freq::Weekly {
        let days: Vec<&str> = WEEKDAYS_ORDERED
            .iter()
            .copied()
            .filter(|d| c.byday.iter().any(|b| b == d))
            .collect();
        if !days.is_empty() {
            parts.push(format!("BYDAY={}", days.join(",")));
        }
    }
    if c.freq == Freq::Monthly {
        match c.monthly_mode {
            MonthlyMode::ByMonthDay => parts.push(format!("BYMONTHDAY={}", start.day)),
            MonthlyMode::ByDay => {
                // Rank of the day within the month: 1st..4th, or last (-1) when the 5th.
                let nth = start.day.div_ceil(7) as i32;
                let rank = if nth >= 5 { -1 } else { nth };
                parts.push(format!("BYDAY={}{}", rank, weekday_code(start)));
            }
        }
    }
    match c.end {
        End::Count => parts.push(format!("COUNT={}", c.count.max(1))),
        End::Until if !c.until.is_empty() => {
            // End of day UTC so the occurrence on the chosen day stays included.
            parts.push(format!("UNTIL={}T235959Z", c.until.replace('-', "")));
        }
        _ => {}
    }
    parts.join(";")
}

/// The localized sentence describing a rule (`describeRrule`). Only French is translated in the web app
/// (the humanizer strings are hard-coded French); English returns the French form unchanged, matching the web.
pub fn describe_rrule(rrule: Option<&str>, _lang: Lang, start: Date) -> Option<String> {
    let rrule = rrule.filter(|s| !s.is_empty())?;
    let parts = parse_parts(rrule);
    let get = |k: &str| parts.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let freq = get("FREQ")?;
    let interval = get("INTERVAL").and_then(|v| v.parse::<u32>().ok()).unwrap_or(1).max(1);

    let byday: Vec<String> = get("BYDAY").unwrap_or("").split(',').map(strip_ordinal).filter(|s| !s.is_empty()).collect();
    let day_list: Vec<&str> = byday.iter().filter_map(|d| day_name(d)).collect();
    let join_days = |ds: &[&str]| -> String {
        if ds.len() <= 1 {
            ds.first().copied().unwrap_or("").to_string()
        } else {
            format!("{} et {}", ds[..ds.len() - 1].join(", "), ds[ds.len() - 1])
        }
    };

    let mut base = match freq {
        "DAILY" => {
            if interval == 1 {
                "Tous les jours".to_string()
            } else {
                format!("Tous les {interval} jours")
            }
        }
        "WEEKLY" => {
            let days = if !day_list.is_empty() {
                join_days(&day_list)
            } else {
                // The web uses formatDate(start,'weekday'); match with the French short weekday.
                crate::date::format(start, crate::date::DateFormat::WeekdayShort, Lang::Fr)
            };
            if interval == 1 {
                format!("Toutes les semaines le {days}")
            } else {
                format!("Toutes les {interval} semaines le {days}")
            }
        }
        "MONTHLY" => {
            let suffix = monthly_suffix(get("BYDAY"), get("BYMONTHDAY")).unwrap_or_default();
            let head = if interval == 1 {
                "Tous les mois".to_string()
            } else {
                format!("Tous les {interval} mois")
            };
            format!("{head}{suffix}")
        }
        "YEARLY" => {
            if interval == 1 {
                "Tous les ans".to_string()
            } else {
                format!("Tous les {interval} ans")
            }
        }
        _ => return None,
    };

    if let Some(count) = get("COUNT") {
        base += &format!(", {count} fois");
    } else if let Some(until) = get("UNTIL") {
        if let Some(d) = parse_until_date(until).and_then(|iso| Date::parse(&iso)) {
            base += &format!(", jusqu'au {}", crate::date::format(d, crate::date::DateFormat::Date, Lang::Fr));
        }
    }
    Some(base)
}

/// The French name of a weekday code.
fn day_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "MO" => "lundi",
        "TU" => "mardi",
        "WE" => "mercredi",
        "TH" => "jeudi",
        "FR" => "vendredi",
        "SA" => "samedi",
        "SU" => "dimanche",
        _ => return None,
    })
}

/// « le 2ᵉ lundi » / « le dernier mardi » / « le 15 » for a MONTHLY rule.
fn monthly_suffix(byday: Option<&str>, bymonthday: Option<&str>) -> Option<String> {
    if let Some(bd) = byday {
        // `^(-?\d)([A-Z]{2})$`.
        let bytes = bd.as_bytes();
        if let Some(code_start) = bytes.iter().position(|b| b.is_ascii_alphabetic()) {
            let (num, code) = bd.split_at(code_start);
            if code.len() == 2 {
                let label = match num {
                    "-1" => "dernier".to_string(),
                    "1" => "1ᵉʳ".to_string(),
                    n => format!("{n}ᵉ"),
                };
                return Some(format!(" le {} {}", label, day_name(code).unwrap_or("")));
            }
        }
        return None;
    }
    if let Some(md) = bymonthday {
        if let Ok(n) = md.parse::<i64>() {
            return Some(format!(" le {n}"));
        }
    }
    None
}

/// Drop a leading iCal ordinal (`"2TU"` → `"TU"`, `"-1FR"` → `"FR"`).
fn strip_ordinal(d: &str) -> String {
    d.trim_start_matches(|c: char| c == '+' || c == '-' || c.is_ascii_digit()).to_string()
}

/// `UNTIL=20261231T235959Z` → `"2026-12-31"`.
fn parse_until_date(until: &str) -> Option<String> {
    let digits: String = until.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        Some(format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> Date {
        Date::new(y, m, day).expect("date")
    }

    #[test]
    fn builds_presets() {
        // 2026-10-12 is a Monday → MO.
        assert_eq!(build_rrule("weekly", d(2026, 10, 12)).as_deref(), Some("FREQ=WEEKLY;BYDAY=MO"));
        assert_eq!(build_rrule("weekday", d(2026, 10, 12)).as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
        assert_eq!(build_rrule("daily", d(2026, 10, 12)).as_deref(), Some("FREQ=DAILY"));
        assert_eq!(build_rrule("none", d(2026, 10, 12)), None);
    }

    #[test]
    fn classifies_presets() {
        assert_eq!(preset_from_rrule(None), "none");
        assert_eq!(preset_from_rrule(Some("FREQ=DAILY")), "daily");
        assert_eq!(preset_from_rrule(Some("FREQ=WEEKLY;BYDAY=MO")), "weekly");
        assert_eq!(preset_from_rrule(Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")), "weekday");
        assert_eq!(preset_from_rrule(Some("FREQ=MONTHLY")), "monthly");
        assert_eq!(preset_from_rrule(Some("FREQ=YEARLY")), "yearly");
        assert_eq!(preset_from_rrule(Some("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO")), "custom");
        assert_eq!(preset_from_rrule(Some("FREQ=DAILY;COUNT=5")), "custom");
        assert_eq!(preset_from_rrule(Some("FREQ=WEEKLY;BYDAY=MO,WE")), "custom");
    }

    #[test]
    fn custom_round_trip_weekly() {
        let start = d(2026, 10, 14); // Wednesday
        let c = CustomRecurrence {
            freq: Freq::Weekly,
            interval: 2,
            byday: vec!["MO".into(), "WE".into(), "FR".into()],
            monthly_mode: MonthlyMode::ByMonthDay,
            end: End::Count,
            count: 8,
            until: start.iso(),
        };
        let r = build_custom_rrule(&c, start);
        assert_eq!(r, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=8");
        assert_eq!(parse_custom_recurrence(Some(&r), start), c);
    }

    #[test]
    fn custom_monthly_byday_rank() {
        // 2026-10-14 is the 2nd Wednesday (14 / 7 = 2).
        let start = d(2026, 10, 14);
        let c = CustomRecurrence {
            freq: Freq::Monthly,
            interval: 1,
            byday: vec![],
            monthly_mode: MonthlyMode::ByDay,
            end: End::Until,
            count: 10,
            until: "2027-06-30".into(),
        };
        let r = build_custom_rrule(&c, start);
        assert_eq!(r, "FREQ=MONTHLY;BYDAY=2WE;UNTIL=20270630T235959Z");
        // 29th → 5th occurrence of the weekday → last (-1).
        let last = d(2026, 10, 29); // Thursday
        let c2 = CustomRecurrence { monthly_mode: MonthlyMode::ByDay, ..c.clone() };
        let r2 = build_custom_rrule(&c2, last);
        assert_eq!(r2, "FREQ=MONTHLY;BYDAY=-1TH;UNTIL=20270630T235959Z");
    }

    #[test]
    fn humanizes_french() {
        let start = d(2026, 10, 12);
        assert_eq!(describe_rrule(Some("FREQ=DAILY"), Lang::Fr, start).as_deref(), Some("Tous les jours"));
        assert_eq!(
            describe_rrule(Some("FREQ=WEEKLY;BYDAY=MO,WE"), Lang::Fr, start).as_deref(),
            Some("Toutes les semaines le lundi et mercredi")
        );
        assert_eq!(
            describe_rrule(Some("FREQ=MONTHLY;BYDAY=2WE"), Lang::Fr, start).as_deref(),
            Some("Tous les mois le 2ᵉ mercredi")
        );
        assert_eq!(
            describe_rrule(Some("FREQ=MONTHLY;BYMONTHDAY=15"), Lang::Fr, start).as_deref(),
            Some("Tous les mois le 15")
        );
        assert_eq!(
            describe_rrule(Some("FREQ=DAILY;COUNT=3"), Lang::Fr, start).as_deref(),
            Some("Tous les jours, 3 fois")
        );
        assert_eq!(
            describe_rrule(Some("FREQ=YEARLY;UNTIL=20271231T235959Z"), Lang::Fr, start).as_deref(),
            Some("Tous les ans, jusqu'au 31 déc. 2027")
        );
    }
}
