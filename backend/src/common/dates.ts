/** Dates métier au format AAAA-MM-JJ (heure de Tunis), comparables comme des chaînes. */

const TIME_ZONE = 'Africa/Tunis';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayInTunis(now: Date = new Date()): string {
  // en-CA produit le format AAAA-MM-JJ.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function firstDayOfNextMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const year = m === 12 ? y + 1 : y;
  const month = m === 12 ? 1 : m + 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1, d));
  // 29 février -> 28 février si l'année cible n'est pas bissextile.
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}
