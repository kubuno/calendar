import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCalendarStore, type ViewMode } from './store'
import {
  X, Calendar as CalendarIcon,
  Clock, MapPin, Search, Plus, Edit2, Copy, Trash2, Bell,
  Mail, Share2, AlignLeft, Check, User as UserIcon,
  MoreVertical, Printer, Link2, Lock, Globe,
  Repeat, Users, Briefcase, ChevronDown, Pipette, Video, Tag,
  LayoutGrid, Home, Building, Building2,
} from 'lucide-react'
import { useAuthStore } from '@kubuno/sdk'
import { FloatingWindow, MenuDropdown, type MenuItem, type MenuDropdownPos } from '@ui'
import { Dropdown, Checkbox, Button, DatePicker, Input, RichText, ColorPicker, useAppPickerTheme, useIsMobile } from '@ui'
import {
  format, startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  eachDayOfInterval, isSameMonth, isToday,
  isSameDay, parseISO, addDays, startOfDay, endOfDay,
  startOfYear, endOfYear, getDay, subYears, addYears,
} from 'date-fns'
import DOMPurify from 'dompurify'
import { getDateLocale } from '@kubuno/sdk'
import {
  calendarApi, weatherApi, wmoInfo, weatherIconUrl, appointmentApi,
  type Calendar, type EventInstance, type DailyWeather,
  type EventReminder, type AppointmentSchedule,
} from './api'
import { ExtensionRegistry, ModuleServiceRegistry } from '@kubuno/sdk'
import { CALENDAR_OVERLAY, type CalendarOverlayItem, type CalendarOverlayProvider } from '@kubuno/sdk'
import {
  useCalendarSettings, timePattern, hourPattern, workDayFor, isWorkingHour,
  type CalendarSettings, type WeekStart, type WorkLocation,
} from './calendarSettings'
import { buildRrule, presetFromRrule, describeRrule } from './rrule'
import { copyKubunoData, eventEnvelope, openLabelPicker } from './kubunoData'
import RecurrenceCustomDialog from './RecurrenceCustomDialog'
import { MonoText } from './MonoText'
import {
  MoonIcon, PrincipalMoonIcon, moonPhase, moonIllumination,
  moonPhaseName, principalPhaseOfDay, principalPhaseName,
} from './moon'
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom'

export function AvailabilityStrip({ ev, top, height, sMin, onClick, compact }: {
  ev: EventInstance; top: number; height: number; sMin: number; onClick: () => void
  // compact: icon only — the overflowing label would pile up across the narrow
  // columns of the mobile week view.
  compact?: boolean
}) {
  const color = ev.color ?? '#4D38DB'
  const hm = `${String(Math.floor(sMin / 60)).padStart(2, '0')}:${String(sMin % 60).padStart(2, '0')}`
  return (
    <div onClick={onClick} title={`${ev.title} · ${hm}`}
      className="absolute z-[6] cursor-pointer" style={{ top, height, left: 2, width: 13 }}>
      <div className="absolute inset-0 rounded-md" style={{ background: color + '26', border: `1px solid ${color}59` }} />
      <div className="absolute top-1 left-0 flex items-center gap-1.5 whitespace-nowrap pointer-events-none">
        <span className="shrink-0 grid place-items-center w-5 h-5 rounded-full ring-2 ring-surface-0 shadow-sm"
          style={{ background: color, color: '#fff' }}>
          <LayoutGrid size={11} />
        </span>
        {!compact && (
          <span className="text-[11px] font-medium leading-none" style={{ color }}>{ev.title}, <MonoText>{hm}</MonoText></span>
        )}
      </div>
    </div>
  )
}

// ── Day view ──────────────────────────────────────────────────────────────────

