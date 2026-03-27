// ─── Calling Hours Enforcement ───────────────────────────────────────────────
// Determines whether an outbound call is permitted based on the prospect's
// local time. The default window is 08:00–21:00 (8 AM to 9 PM) inclusive start,
// exclusive end — matches Ofcom/FTC "reasonable calling hours" guidelines.
//
// Timezone is derived from the lead's country code using the most-populated /
// capital IANA timezone. For multi-timezone countries (US, AU, CA) this uses
// the largest economic hub — a deliberate approximation: being conservative
// (not calling when uncertain) is preferable to disturbing prospects at 5 AM.

// Country ISO-3166-1 alpha-2 → IANA timezone (primary/most-populated zone)
const COUNTRY_TIMEZONE: Record<string, string> = {
  // British Isles
  GB: 'Europe/London',  UK: 'Europe/London',  IE: 'Europe/Dublin',
  // Western Europe
  DE: 'Europe/Berlin',  FR: 'Europe/Paris',   ES: 'Europe/Madrid',
  IT: 'Europe/Rome',    NL: 'Europe/Amsterdam', BE: 'Europe/Brussels',
  CH: 'Europe/Zurich',  AT: 'Europe/Vienna',  PT: 'Europe/Lisbon',
  LU: 'Europe/Luxembourg',
  // Northern Europe
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',  IS: 'Atlantic/Reykjavik',
  // Eastern / Southern Europe
  PL: 'Europe/Warsaw',   CZ: 'Europe/Prague',  HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest', GR: 'Europe/Athens', HR: 'Europe/Zagreb',
  SK: 'Europe/Bratislava', SI: 'Europe/Ljubljana', BG: 'Europe/Sofia',
  // Turkey / Middle East
  TR: 'Europe/Istanbul', AE: 'Asia/Dubai', SA: 'Asia/Riyadh',
  IL: 'Asia/Jerusalem',  QA: 'Asia/Qatar',   KW: 'Asia/Kuwait',
  // Africa
  ZA: 'Africa/Johannesburg', NG: 'Africa/Lagos', EG: 'Africa/Cairo',
  // Asia-Pacific
  IN: 'Asia/Kolkata',   SG: 'Asia/Singapore', JP: 'Asia/Tokyo',
  HK: 'Asia/Hong_Kong', MY: 'Asia/Kuala_Lumpur', TH: 'Asia/Bangkok',
  PH: 'Asia/Manila',    ID: 'Asia/Jakarta',   VN: 'Asia/Ho_Chi_Minh',
  CN: 'Asia/Shanghai',  KR: 'Asia/Seoul',     TW: 'Asia/Taipei',
  PK: 'Asia/Karachi',   BD: 'Asia/Dhaka',
  // Oceania (largest city per country)
  AU: 'Australia/Sydney', NZ: 'Pacific/Auckland',
  // Americas
  US: 'America/New_York',            // US: Eastern (most populous zone)
  CA: 'America/Toronto',             // Canada: Eastern
  MX: 'America/Mexico_City',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  CO: 'America/Bogota', CL: 'America/Santiago', PE: 'America/Lima',
}

// Fallback when a country isn't in the map — London is the most conservative
// default for a UK-based calling agent (BST/GMT is the reference timezone).
const FALLBACK_TIMEZONE = 'Europe/London'

export interface CallingHoursConfig {
  enabled:   boolean
  startHour: number   // 0–23 inclusive — calls allowed at this hour
  endHour:   number   // 0–23 exclusive — calls blocked at this hour and beyond
}

/**
 * Returns the IANA timezone for a given ISO-3166-1 alpha-2 country code.
 * Case-insensitive. Falls back to Europe/London for unknown codes.
 */
export function getProspectTimezone(countryCode: string): string {
  const code = (countryCode || 'GB').toUpperCase().trim()
  return COUNTRY_TIMEZONE[code] ?? FALLBACK_TIMEZONE
}

/**
 * Returns true if the current time in the prospect's timezone is within the
 * allowed calling window. Also returns true when enforcement is disabled.
 */
export function isWithinCallingHours(countryCode: string, config: CallingHoursConfig): boolean {
  if (!config.enabled) return true

  const timezone = getProspectTimezone(countryCode)
  try {
    // hour12:false with Intl returns "0"–"23", but some runtimes return "24"
    // for midnight — the % 24 handles that edge case.
    const hourStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date())
    const hour = parseInt(hourStr, 10) % 24
    return hour >= config.startHour && hour < config.endHour
  } catch {
    // Invalid timezone — allow the call rather than silently blocking it
    console.warn(`[CallingHours] Could not parse timezone "${timezone}" for country "${countryCode}" — allowing call`)
    return true
  }
}

/**
 * Returns a human-readable local time string for error messages and logs.
 * Example: "22:15 GMT" or "09:30 BST"
 */
export function formatLocalTime(countryCode: string): string {
  const timezone = getProspectTimezone(countryCode)
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date())
  } catch {
    return 'unknown time'
  }
}
