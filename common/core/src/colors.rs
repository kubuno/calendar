//! The calendar's fixed colour tokens, ported from `web/src/calendarColors.ts` and `calendarUtils.ts` so the
//! desktop paints events and calendars in exactly the web's hues. The light/dark surface theme is NOT here:
//! the module ships only light `@theme` tokens on the web, so the desktop takes its surfaces from the Kubuno
//! desktop framework theme (which already carries a faithful dark mode); see CALENDAR-DESKTOP.md §5.

/// Default palette suggested for a calendar (`calendarColors.CALENDAR_COLORS`).
pub const CALENDAR_COLORS: [&str; 12] = [
    "#1a73e8", "#4D38DB", "#0b8043", "#188038", "#f4b400", "#f09300",
    "#d93025", "#c2185b", "#8e24aa", "#616161", "#00897b", "#3949ab",
];

/// Event colour swatches offered in the editor (`calendarUtils.EVENT_SWATCHES`).
pub const EVENT_SWATCHES: [&str; 9] = [
    "#1a73e8", "#1e8e3e", "#d93025", "#f9ab00", "#9334e6", "#e8710a", "#12b5cb", "#4D38DB", "#5f6368",
];

/// Fallback colour for an event with no colour of its own (the web's `#1a73e8` default throughout).
pub const DEFAULT_EVENT_COLOR: &str = "#1a73e8";

/// The single green every territory's public holiday is drawn in (`holidays.HOLIDAY_COLOR`).
pub const HOLIDAY_COLOR: &str = "#0b8043";

/// The colour of a module's primary accent on the web (`theme.css --color-primary`), used for « today » and
/// selection. The desktop applies it through `[data-module="calendar"]`.
pub const PRIMARY: &str = "#1a73e8";
