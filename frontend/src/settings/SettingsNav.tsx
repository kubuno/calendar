// Navigation of the settings page — rendered by the SHELL in its left panel
// (registered in entry.ts for the `/calendar/user-settings` prefix, which wins
// over the module's own prefix: most-specific route prefix wins).
//
// While the settings are open, this replaces the calendar's usual sidebar (mini
// calendar, calendar list, weather…) instead of stacking a second column next to
// it — same approach as the mail module.
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  CalendarPlus, ChevronDown, ChevronRight,
  Link2, Upload, Settings, Server, CloudSun, Info,
} from 'lucide-react'
import { SidebarNavItem } from '@kubuno/sdk'
import { calendarApi, type Calendar } from '../api'
import CalendarEditModal from '../CalendarEditModal'
import CalendarSubscribeModal from '../CalendarSubscribeModal'
import { GENERAL_SECTIONS } from './GeneralSettings'
import { calendarSections } from './CalendarDetailSettings'

const BASE = '/calendar/user-settings'

export function isOwnedCalendar(cal: Calendar): boolean {
  return (cal.my_permission == null || cal.my_permission === 'owner') && !cal.subscription_url
}

/** Section anchors are scrolled to inside the page's scroll container. */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function SectionLinks({ ids, labels }: { ids: readonly string[]; labels: Record<string, string> }) {
  return (
    <div className="ml-6 border-l border-border/70 my-0.5">
      {ids.map(id => (
        <a key={id} href={`#${id}`}
          onClick={e => { e.preventDefault(); scrollToSection(id) }}
          className="block pl-3 pr-2 py-1.5 text-text-secondary rounded-r-full
                     hover:bg-[#e4ecf7] hover:text-primary transition-colors">
          {labels[id] ?? id}
        </a>
      ))}
    </div>
  )
}

// Group heading between sets of nav entries. Kept quiet on purpose — the shell's
// sidebar has no shouty uppercase labels, so a small tertiary heading with a hair
// line above blends in instead of breaking the rhythm of the nav pills.
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 mt-2 border-t border-border/60 text-text-tertiary">
      {children}
    </p>
  )
}

/** Coloured bullet standing in for the icon of a calendar entry. */
function Dot({ color }: { color: string }) {
  return <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
}

export default function SettingsNav({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation('calendar')
  const navigate = useNavigate()
  const location = useLocation()

  const page = location.pathname.startsWith(BASE + '/')
    ? location.pathname.slice(BASE.length + 1)
    : 'general'

  const [addOpen, setAddOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [showSubscribe, setShowSubscribe] = useState(false)

  const { data } = useQuery({ queryKey: ['calendar-calendars'], queryFn: calendarApi.listCalendars })
  const calendars = useMemo(() => data?.calendars ?? [], [data])
  const mine   = useMemo(() => calendars.filter(isOwnedCalendar), [calendars])
  const others = useMemo(() => calendars.filter(c => !isOwnedCalendar(c)), [calendars])

  const go = (p: string) => {
    navigate(p === 'general' ? BASE : `${BASE}/${p}`)
    document.getElementById('calendar-settings-pane')?.scrollTo({ top: 0 })
  }

  const generalLabels: Record<string, string> = {
    'region':        t('settings_section_region',        { defaultValue: 'Langue et région' }),
    'timezone':      t('settings_section_timezone',      { defaultValue: 'Fuseau horaire' }),
    'world-clock':   t('settings_section_world_clock',   { defaultValue: 'Horloge mondiale' }),
    'events':        t('settings_section_events',        { defaultValue: 'Paramètres des événements' }),
    'notifications': t('settings_section_notifications', { defaultValue: 'Paramètres de notification' }),
    'display':       t('settings_section_display',       { defaultValue: 'Options d’affichage' }),
    'working-hours': t('settings_section_working_hours', { defaultValue: 'Heures de travail' }),
    'shortcuts':     t('settings_section_shortcuts',     { defaultValue: 'Raccourcis clavier' }),
  }
  const calendarLabels: Record<string, string> = {
    'settings':    t('settings_section_calendar',    { defaultValue: 'Paramètres de l’agenda' }),
    'shared':      t('settings_section_shared',      { defaultValue: 'Partagé avec' }),
    'permissions': t('settings_section_permissions', { defaultValue: 'Autorisations d’accès aux événements' }),
    'integrate':   t('settings_section_integrate',   { defaultValue: 'Intégrer l’agenda' }),
    'remove':      t('settings_section_remove',      { defaultValue: 'Supprimer l’agenda' }),
  }

  const calendarEntry = (c: Calendar, owner: boolean) => (
    <React.Fragment key={c.id}>
      <SidebarNavItem
        label={c.name}
        icon={<Dot color={c.color} />}
        collapsed={collapsed}
        active={page === `cal-${c.id}`}
        onClick={() => go(`cal-${c.id}`)}
      />
      {!collapsed && page === `cal-${c.id}` && (
        <SectionLinks
          ids={calendarSections(c, owner)}
          labels={{
            ...calendarLabels,
            remove: c.subscription_url
              ? t('settings_unsubscribe', { defaultValue: 'Se désabonner de l’agenda' })
              : calendarLabels.remove,
          }}
        />
      )}
    </React.Fragment>
  )

  return (
    <div className={`flex-1 overflow-y-auto py-1 space-y-0.5 ${collapsed ? 'px-2' : 'px-3'}`}>
      <SidebarNavItem
        label={t('settings_nav_general', { defaultValue: 'Paramètres généraux' })}
        icon={<Settings size={16} />}
        collapsed={collapsed}
        active={page === 'general'}
        onClick={() => go('general')}
      />
      {!collapsed && page === 'general' && (
        <SectionLinks ids={GENERAL_SECTIONS} labels={generalLabels} />
      )}

      <SidebarNavItem
        label={t('settings_nav_add_calendar', { defaultValue: 'Ajouter un agenda' })}
        icon={addOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        collapsed={collapsed}
        onClick={() => setAddOpen(o => !o)}
      />
      {!collapsed && addOpen && (
        <div className="ml-6 border-l border-border/70 my-0.5">
          <a href="#" onClick={e => { e.preventDefault(); setShowCreate(true) }}
            className="flex items-center gap-2 pl-3 pr-2 py-1.5 text-text-secondary
                       rounded-r-full hover:bg-[#e4ecf7] hover:text-primary transition-colors">
            <CalendarPlus size={13} />{t('cal_create_action', { defaultValue: 'Créer un agenda' })}
          </a>
          <a href="#" onClick={e => { e.preventDefault(); setShowSubscribe(true) }}
            className="flex items-center gap-2 pl-3 pr-2 py-1.5 text-text-secondary
                       rounded-r-full hover:bg-[#e4ecf7] hover:text-primary transition-colors">
            <Link2 size={13} />{t('subscribe_title', { defaultValue: 'S’abonner à une URL' })}
          </a>
          <a href="#" onClick={e => { e.preventDefault(); go('import-export') }}
            className="flex items-center gap-2 pl-3 pr-2 py-1.5 text-text-secondary
                       rounded-r-full hover:bg-[#e4ecf7] hover:text-primary transition-colors">
            <Upload size={13} />{t('settings_section_import', { defaultValue: 'Importer' })}
          </a>
        </div>
      )}

      <SidebarNavItem
        label={t('settings_nav_import_export', { defaultValue: 'Importer et exporter' })}
        icon={<Upload size={16} />}
        collapsed={collapsed}
        active={page === 'import-export'}
        onClick={() => go('import-export')}
      />
      {!collapsed && page === 'import-export' && (
        <SectionLinks ids={['import', 'export']} labels={{
          import: t('settings_section_import', { defaultValue: 'Importer' }),
          export: t('settings_section_export', { defaultValue: 'Exporter' }),
        }} />
      )}

      <SidebarNavItem label="CalDAV" icon={<Server size={16} />} collapsed={collapsed}
        active={page === 'caldav'} onClick={() => go('caldav')} />
      <SidebarNavItem label={t('settings_tab_weather', { defaultValue: 'Météo' })}
        icon={<CloudSun size={16} />} collapsed={collapsed}
        active={page === 'weather'} onClick={() => go('weather')} />
      <SidebarNavItem label={t('settings_tab_about', { defaultValue: 'À propos' })}
        icon={<Info size={16} />} collapsed={collapsed}
        active={page === 'about'} onClick={() => go('about')} />

      {mine.length > 0 && (
        <>
          {!collapsed && (
            <GroupLabel>{t('settings_nav_my_calendars', { defaultValue: 'Paramètres de mes agendas' })}</GroupLabel>
          )}
          {mine.map(c => calendarEntry(c, true))}
        </>
      )}

      {others.length > 0 && (
        <>
          {!collapsed && (
            <GroupLabel>{t('settings_nav_other_calendars', { defaultValue: 'Paramètres des autres agendas' })}</GroupLabel>
          )}
          {others.map(c => calendarEntry(c, false))}
        </>
      )}

      {showCreate    && <CalendarEditModal onClose={() => setShowCreate(false)} />}
      {showSubscribe && <CalendarSubscribeModal onClose={() => setShowSubscribe(false)} />}
    </div>
  )
}
