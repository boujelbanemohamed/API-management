import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { WorkingCalendar } from '../common/working-days';

/**
 * Demandes et engagements de service (spécifications §9).
 * Fonctions pures : aucune dépendance à la base.
 */

export enum RequestType {
  OPERATION = 'OPERATION',
  API_ACCESS = 'API_ACCESS',
  IP_CERTIFICATE = 'IP_CERTIFICATE',
  SUPPORT = 'SUPPORT',
}

export enum RequestStatus {
  NEW = 'NEW',
  IN_PROGRESS = 'IN_PROGRESS',
  WAITING_BANK = 'WAITING_BANK',
  WAITING_THIRD_PARTY = 'WAITING_THIRD_PARTY',
  AWAITING_VALIDATION = 'AWAITING_VALIDATION',
  DONE = 'DONE',
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
}

export enum SlaLevel {
  OK = 'OK',
  ALERT = 'ALERT',
  BREACH = 'BREACH',
  PAUSED = 'PAUSED',
  MET = 'MET',
  MISSED = 'MISSED',
}

/** Engagement par défaut ; l'écran « Engagements » peut le remplacer (F-DEM-08). */
export const DEFAULT_COMMITMENTS: Record<RequestType, { team: string; slaDays: number }> = {
  [RequestType.OPERATION]: { team: 'OPERATIONS', slaDays: 2 },
  [RequestType.API_ACCESS]: { team: 'INTEGRATION', slaDays: 3 },
  [RequestType.IP_CERTIFICATE]: { team: 'SECURITY', slaDays: 2 },
  [RequestType.SUPPORT]: { team: 'SUPPORT', slaDays: 5 },
};

export const ALERT_RATIO = 0.75;
export const REOPEN_WINDOW_DAYS = 5;

const OPEN = [
  RequestStatus.NEW,
  RequestStatus.IN_PROGRESS,
  RequestStatus.WAITING_BANK,
  RequestStatus.WAITING_THIRD_PARTY,
  RequestStatus.AWAITING_VALIDATION,
];
const WAITING = [RequestStatus.WAITING_BANK, RequestStatus.WAITING_THIRD_PARTY];

export type RequestAction = 'assign' | 'wait' | 'resume' | 'prepare' | 'validate' | 'complete' | 'close' | 'reject' | 'reopen';

const ALLOWED: Record<RequestAction, RequestStatus[]> = {
  assign: [RequestStatus.NEW, RequestStatus.IN_PROGRESS],
  wait: [RequestStatus.IN_PROGRESS],
  resume: WAITING,
  prepare: [RequestStatus.IN_PROGRESS],
  validate: [RequestStatus.AWAITING_VALIDATION],
  complete: [RequestStatus.IN_PROGRESS],
  close: [RequestStatus.DONE],
  reject: OPEN,
  reopen: [RequestStatus.DONE, RequestStatus.CLOSED],
};

export interface SlaState {
  status: RequestStatus;
  openedOn: string;
  slaDays: number;
  /** Jours ouvrés déjà passés en attente (banque ou tiers), suspensions terminées. */
  suspendedWorkingDays: number;
  /** Début de la suspension en cours, le cas échéant. */
  suspendedSince: string | null;
  doneOn: string | null;
}

export function assertAction(status: RequestStatus, action: RequestAction): void {
  if (!ALLOWED[action].includes(status)) {
    throw new BusinessRuleError('INVALID_TRANSITION', `Action « ${action} » impossible sur une demande à l'état ${status}.`);
  }
}

export function isOpen(status: RequestStatus): boolean {
  return OPEN.includes(status);
}

/** Échéance = ouverture + délai en jours ouvrés + jours ouvrés de suspension (F-DEM-02, F-DEM-03). */
export function dueDate(s: SlaState, cal: WorkingCalendar, today: string): string {
  const running = s.suspendedSince ? cal.workingDaysBetween(s.suspendedSince, today) : 0;
  return cal.addWorkingDays(s.openedOn, s.slaDays + s.suspendedWorkingDays + running);
}

/** Jours ouvrés consommés sur le délai, hors suspensions. */
export function consumedWorkingDays(s: SlaState, cal: WorkingCalendar, today: string): number {
  const end = s.doneOn ?? (s.suspendedSince ?? today);
  return Math.max(0, cal.workingDaysBetween(s.openedOn, end) - s.suspendedWorkingDays);
}

/** Niveau d'engagement : alerte à 75 %, dépassement à 100 % (F-DEM-04). */
export function slaLevel(s: SlaState, cal: WorkingCalendar, today: string): SlaLevel {
  const used = consumedWorkingDays(s, cal, today);
  if (s.doneOn) return used <= s.slaDays ? SlaLevel.MET : SlaLevel.MISSED;
  if (s.suspendedSince) return SlaLevel.PAUSED;
  if (used >= s.slaDays) return SlaLevel.BREACH;
  if (used >= Math.ceil(s.slaDays * ALERT_RATIO)) return SlaLevel.ALERT;
  return SlaLevel.OK;
}

/** Fin de suspension : on cumule les jours ouvrés passés en attente. */
export function endSuspension(s: SlaState, cal: WorkingCalendar, today: string): number {
  if (!s.suspendedSince) return s.suspendedWorkingDays;
  return s.suspendedWorkingDays + cal.workingDaysBetween(s.suspendedSince, today);
}

/** Double validation : deux personnes distinctes (F-DEM-06, F-ROL-03). */
export function assertSecondValidator(preparedBy: string | null, validator: string): void {
  if (!preparedBy) throw new BusinessRuleError('NOT_PREPARED', 'La demande n’a pas été préparée.');
  if (preparedBy.trim().toLowerCase() === validator.trim().toLowerCase()) {
    throw new BusinessRuleError('SAME_VALIDATOR', 'La validation doit être faite par une autre personne que celle qui a préparé.');
  }
}

export function assertReopenable(doneOn: string | null, cal: WorkingCalendar, today: string): void {
  if (!doneOn || cal.workingDaysBetween(doneOn, today) > REOPEN_WINDOW_DAYS) {
    throw new BusinessRuleError('REOPEN_EXPIRED', `Une demande ne peut être rouverte que sous ${REOPEN_WINDOW_DAYS} jours ouvrés.`);
  }
}
