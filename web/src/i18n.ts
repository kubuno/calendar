import { registerModuleTranslations } from '@kubuno/sdk'

// Translations are split one file per language under ./i18n/ (one file = one
// language); this module only assembles them and registers them with the host.
import { en } from './i18n/en'
import { fr } from './i18n/fr'
import { es } from './i18n/es'
import { pt } from './i18n/pt'
import { it } from './i18n/it'
import { de } from './i18n/de'
import { el } from './i18n/el'
import { ru } from './i18n/ru'
import { ar } from './i18n/ar'
import { he } from './i18n/he'
import { hi } from './i18n/hi'
import { zh } from './i18n/zh'
import { ja } from './i18n/ja'

registerModuleTranslations('calendar', { en, fr, es, pt, it, de, el, ru, ar, he, hi, zh, ja })
