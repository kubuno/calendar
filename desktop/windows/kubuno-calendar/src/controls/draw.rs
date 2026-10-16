//! Shared drawing of the event pills and the all-day banners, so the Month, Week and Day views render events
//! identically to the web (`web/src/MonthView.tsx` chips, `EventBanners.tsx` bars, `EventCard.tsx` pills).
//! Colours and radii are the web's exact values.

use kubuno_desktop::ui::graphics::{Brush, Color, Font, GraphicsPath, Pen, PointF, StringAlignment, StringFormat, StringFormatFlags, StringTrimming};
use kubuno_desktop::ui::Rect;

use kubuno_calendar_core::layout::shade;

use crate::controls::model::{color_of, hex};

/// The fallback event colour (`#1a73e8`, the web default throughout).
pub const DEFAULT_EVENT_COLOR: u32 = 0x1a73e8;
/// Event-pill corner radius (`rounded-md` = 8px, theme.css overrides the Tailwind scale).
pub const PILL_RADIUS: f32 = 8.0;
/// Banner body corner radius (`EventBanners.tsx:44-47`, `5`).
pub const BANNER_RADIUS: f32 = 5.0;
/// Banner continuation arrow-tip width (`EventBanners.tsx:10`, `TIP = 7`).
pub const BANNER_TIP: f32 = 7.0;

fn one(a: StringAlignment) -> StringFormat {
    StringFormat { alignment: a, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP }
}

/// A solid filled event pill with white text (`MonthView.tsx:243-261`): the optional start time (slightly
/// faded) then the title in medium weight. `color_hex` is the event colour; past events (web `color + '2b'`)
/// are drawn tinted with coloured text when `past` is set.
#[allow(clippy::too_many_arguments)]
pub fn draw_event_pill(
    g: &kubuno_desktop::ui::graphics::Graphics<'_>,
    rect: Rect,
    color_hex: &str,
    time: Option<&str>,
    title: &str,
    font_time: &Font,
    font_title: &Font,
    past: bool,
    ring: bool,
) {
    let color = color_of(color_hex, hex(DEFAULT_EVENT_COLOR));
    let bg = if past { color.with_alpha(43.0 / 255.0) } else { color };
    let ink = if past { color } else { Color::WHITE };
    g.fill_rounded_rectangle(Brush::solid(bg), rect, PILL_RADIUS);
    // The day/week blocks carry a 1px white inner ring (`ring-1 ring-surface-0/60`).
    if ring && !past {
        let inset = Rect::new(rect.left + 0.5, rect.top + 0.5, rect.right - 0.5, rect.bottom - 0.5);
        g.draw_rounded_rectangle(&Pen::new(Color::WHITE.with_alpha(0.6), 1.0), inset, PILL_RADIUS);
    }
    let mut x = rect.left + 6.0; // px-1.5
    if let Some(t) = time {
        // The time is a touch faded (`opacity-85`) and a hair smaller (`text-[11px]`).
        let slot = Rect::new(x, rect.top, (x + 34.0).min(rect.right - 2.0), rect.bottom);
        g.draw_string(t, font_time, Brush::solid(ink.with_alpha(if past { 1.0 } else { 0.85 })), slot, &one(StringAlignment::Near));
        x += 36.0;
    }
    if x < rect.right - 2.0 {
        g.draw_string(title, font_title, Brush::solid(ink), Rect::new(x, rect.top, rect.right - 3.0, rect.bottom), &one(StringAlignment::Near));
    }
}

/// The lit part of the moon (`moon.tsx:98`, `#f6c453`).
pub const MOON_LIT: u32 = 0xf6c453;

/// A principal-phase moon marker (`moon.tsx` PrincipalMoonIcon): a disc in `fill` outlined in `stroke`, with
/// the lit part in `MOON_LIT` - empty for new, right half for first quarter, full for full, left for last.
pub fn draw_principal_moon(
    g: &kubuno_desktop::ui::graphics::Graphics<'_>,
    cx: f32,
    cy: f32,
    r: f32,
    phase: kubuno_calendar_core::moon::PrincipalPhase,
    fill: Color,
    stroke: Color,
) {
    use kubuno_calendar_core::moon::PrincipalPhase;
    let rect = Rect::new(cx - r, cy - r, cx + r, cy + r);
    let lit = hex(MOON_LIT);
    g.fill_ellipse(Brush::solid(fill), rect);
    match phase {
        PrincipalPhase::New => {}
        PrincipalPhase::Full => g.fill_ellipse(Brush::solid(lit), rect),
        PrincipalPhase::FirstQuarter => {
            let mut p = GraphicsPath::new();
            p.add_pie(rect, -90.0, 180.0); // north → east → south = right half
            g.fill_path(Brush::solid(lit), &p);
        }
        PrincipalPhase::LastQuarter => {
            let mut p = GraphicsPath::new();
            p.add_pie(rect, 90.0, 180.0); // south → west → north = left half
            g.fill_path(Brush::solid(lit), &p);
        }
    }
    g.draw_ellipse(&Pen::new(stroke, 1.0), rect);
}

/// A moon disc for any phase (`phase` 0..1, 0 = new / 0.5 = full; `illum` the lit fraction): the dark base,
/// the lit limb (right while waxing, left while waning) carved to a crescent or extended to a gibbous by the
/// terminator ellipse, and the outline - the shape the sidebar's Moon widget shows (`web MoonIcon`).
#[allow(clippy::too_many_arguments)]
pub fn draw_moon(g: &kubuno_desktop::ui::graphics::Graphics<'_>, cx: f32, cy: f32, r: f32, phase: f64, illum: f64, fill: Color, stroke: Color) {
    let rect = Rect::new(cx - r, cy - r, cx + r, cy + r);
    let lit = hex(MOON_LIT);
    g.fill_ellipse(Brush::solid(fill), rect);
    if illum > 0.985 {
        g.fill_ellipse(Brush::solid(lit), rect);
    } else if illum > 0.015 {
        let waxing = phase < 0.5;
        let mut p = GraphicsPath::new();
        // The lit half: north→east→south (right) while waxing, south→west→north (left) while waning.
        if waxing {
            p.add_pie(rect, -90.0, 180.0);
        } else {
            p.add_pie(rect, 90.0, 180.0);
        }
        g.fill_path(Brush::solid(lit), &p);
        // The terminator ellipse carves (crescent, < half lit) or extends (gibbous, > half lit) the lit half.
        let tf = (2.0 * illum - 1.0).abs() as f32;
        let term = Rect::new(cx - r * tf, cy - r, cx + r * tf, cy + r);
        let term_color = if illum < 0.5 { fill } else { lit };
        g.fill_ellipse(Brush::solid(term_color), term);
    }
    g.draw_ellipse(&Pen::new(stroke, 1.0), rect);
}

/// A timed-event block in the Day/Week grid (`WeekView.tsx` / `DayView.tsx`): the title on the first line
/// (semibold) and, when the block is tall enough, the time range (and location) faded on a second line - not a
/// time prefix. Carries the thin white inner ring and the web radius.
#[allow(clippy::too_many_arguments)]
pub fn draw_timed_block(
    g: &kubuno_desktop::ui::graphics::Graphics<'_>,
    rect: Rect,
    color_hex: &str,
    title: &str,
    subtitle: &str,
    font_title: &Font,
    font_sub: &Font,
) {
    let color = color_of(color_hex, hex(DEFAULT_EVENT_COLOR));
    g.fill_rounded_rectangle(Brush::solid(color), rect, PILL_RADIUS);
    let inset = Rect::new(rect.left + 0.5, rect.top + 0.5, rect.right - 0.5, rect.bottom - 0.5);
    g.draw_rounded_rectangle(&Pen::new(Color::WHITE.with_alpha(0.6), 1.0), inset, PILL_RADIUS);
    let near = StringFormat { alignment: StringAlignment::Near, line_alignment: StringAlignment::Center, trimming: StringTrimming::EllipsisCharacter, flags: StringFormatFlags::NO_WRAP };
    let h = rect.bottom - rect.top;
    if h >= 34.0 {
        g.draw_string(title, font_title, Brush::solid(Color::WHITE), Rect::new(rect.left + 6.0, rect.top + 3.0, rect.right - 5.0, rect.top + 20.0), &near);
        g.draw_string(subtitle, font_sub, Brush::solid(Color::WHITE.with_alpha(0.85)), Rect::new(rect.left + 6.0, rect.top + 19.0, rect.right - 5.0, (rect.top + 35.0).min(rect.bottom)), &near);
    } else {
        // Compact: title with the time appended, on one line.
        let one = format!("{title}  {subtitle}");
        g.draw_string(&one, font_title, Brush::solid(Color::WHITE), Rect::new(rect.left + 6.0, rect.top, rect.right - 5.0, rect.bottom), &near);
    }
}

/// An all-day / multi-day banner bar (`EventBanners.tsx`): a rounded body pill in the event colour with the
/// title in white, and a darker pointed arrow tip on any end that runs past the visible range. `shorten_right`
/// leaves the 10px gap the web uses to mark the true end of the event.
#[allow(clippy::too_many_arguments)]
pub fn draw_banner(
    g: &kubuno_desktop::ui::graphics::Graphics<'_>,
    left: f32,
    right: f32,
    y: f32,
    h: f32,
    color_hex: &str,
    continues_before: bool,
    continues_after: bool,
    shorten_right: bool,
    title: &str,
    font: &Font,
) {
    let color = color_of(color_hex, hex(DEFAULT_EVENT_COLOR));
    let dark = color_of(&shade(color_hex, 0.62), color);
    let ml = if continues_before { 0.0 } else { 3.0 };
    let mr = if continues_after { 0.0 } else if shorten_right { 10.0 } else { 3.0 };
    let body_left = if continues_before { left + BANNER_TIP } else { left + ml };
    let body_right = if continues_after { right - BANNER_TIP } else { right - mr };
    if body_right <= body_left {
        return;
    }
    g.fill_rounded_rectangle(Brush::solid(color), Rect::new(body_left, y, body_right, y + h), BANNER_RADIUS);
    if continues_before {
        let mut p = GraphicsPath::new();
        p.add_polygon(&[PointF::new(left + BANNER_TIP, y), PointF::new(left + BANNER_TIP, y + h), PointF::new(left, y + h / 2.0)]);
        g.fill_path(Brush::solid(dark), &p);
    }
    if continues_after {
        let mut p = GraphicsPath::new();
        p.add_polygon(&[PointF::new(right - BANNER_TIP, y), PointF::new(right - BANNER_TIP, y + h), PointF::new(right, y + h / 2.0)]);
        g.fill_path(Brush::solid(dark), &p);
    }
    g.draw_string(title, font, Brush::solid(Color::WHITE), Rect::new(body_left + 6.0, y, body_right - 4.0, y + h), &one(StringAlignment::Near));
}
