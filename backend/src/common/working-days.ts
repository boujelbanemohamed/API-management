/**
 * Calendrier des jours ouvrés tunisiens (spécifications §9, F-DEM-02).
 * Week-end : samedi et dimanche. Jours fériés : fixes (ci-dessous) + fêtes religieuses
 * à date variable, saisies chaque année dans la table des jours fériés.
 * Dates au format AAAA-MM-JJ.
 */

const FIXED_HOLIDAYS = [
  '01-01', // Jour de l'an
  '03-20', // Fête de l'indépendance
  '04-09', // Journée des martyrs
  '05-01', // Fête du travail
  '07-25', // Fête de la République
  '08-13', // Fête de la femme
  '10-15', // Fête de l'évacuation
  '12-17', // Fête de la révolution
];

export function fixedTunisianHolidays(year: number): string[] {
  return FIXED_HOLIDAYS.map((md) => `${year}-${md}`);
}

function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return format(d);
}

/** Écart en jours calendaires (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

export class WorkingCalendar {
  private readonly holidays: Set<string>;

  /** @param variableHolidays fêtes à date variable (Aïd, Mouled, Ras El Am El Hijri…) */
  constructor(variableHolidays: string[] = []) {
    this.holidays = new Set(variableHolidays);
  }

  isWorkingDay(date: string): boolean {
    const day = parse(date).getUTCDay();
    if (day === 0 || day === 6) return false;
    if (this.holidays.has(date)) return false;
    return !FIXED_HOLIDAYS.includes(date.slice(5));
  }

  /** Date atteinte après `n` jours ouvrés comptés à partir du lendemain de `start`. */
  addWorkingDays(start: string, n: number): string {
    let date = start;
    let left = n;
    while (left > 0) {
      date = addDays(date, 1);
      if (this.isWorkingDay(date)) left--;
    }
    return date;
  }

  /** Nombre de jours ouvrés dans l'intervalle ]from, to]. 0 si to <= from. */
  workingDaysBetween(from: string, to: string): number {
    let count = 0;
    for (let date = addDays(from, 1); date <= to; date = addDays(date, 1)) {
      if (this.isWorkingDay(date)) count++;
    }
    return count;
  }
}
