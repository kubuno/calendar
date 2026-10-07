/**
 * "Guest permissions" — what the organiser lets the invited do.
 *
 * Three separate decisions, not one level of trust: they are not ordered, and
 * a gathering whose guests may bring others but may not see the list is a real
 * arrangement, not a mistake. Each is enforced by the server — modifying the
 * event, adding a guest, reading the list — so a box ticked here changes what
 * someone else can actually do, and an unticked one refuses them for real.
 *
 * The defaults are the ones the field has: guests may invite and may see each
 * other, and may not rewrite the event. They are what most meetings want, and
 * the two permissive ones are what makes an invitation feel like an invitation
 * rather than a summons.
 */
import { useTranslation } from 'react-i18next'
import { Checkbox } from '@ui'

export interface GuestPerms {
  guests_can_modify:     boolean
  guests_can_invite:     boolean
  guests_can_see_guests: boolean
}

export const DEFAULT_GUEST_PERMS: GuestPerms = {
  guests_can_modify:     false,
  guests_can_invite:     true,
  guests_can_see_guests: true,
}

export function GuestPermissions({ value, onChange, disabled }: {
  value: GuestPerms
  onChange: (v: GuestPerms) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('calendar')
  const set = (k: keyof GuestPerms) => (v: boolean) => onChange({ ...value, [k]: v })

  return (
    <div className="space-y-2">
      <p className="text-sm text-text-secondary">
        {t('guest_perms_title', { defaultValue: 'Autorisations des invités' })}
      </p>
      <Checkbox
        disabled={disabled}
        checked={value.guests_can_modify}
        onChange={set('guests_can_modify')}
        label={t('guest_perms_modify', { defaultValue: 'Modifier l’événement' })}
      />
      <Checkbox
        disabled={disabled}
        checked={value.guests_can_invite}
        onChange={set('guests_can_invite')}
        label={t('guest_perms_invite', { defaultValue: 'Inviter d’autres personnes' })}
      />
      <Checkbox
        disabled={disabled}
        checked={value.guests_can_see_guests}
        onChange={set('guests_can_see_guests')}
        label={t('guest_perms_see', { defaultValue: 'Voir la liste des invités' })}
      />
    </div>
  )
}
