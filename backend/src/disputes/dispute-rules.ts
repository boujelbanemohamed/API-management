import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { addDays } from '../common/working-days';

/**
 * Litiges du scheme national (spécifications §11). Machine à états pure.
 * Délais en jours calendaires ; le délai d'une étape est celui laissé à la partie qui doit répondre.
 */

export enum DisputeStage {
  OPENED = 'OPENED', // transaction identifiée, aucune action encore
  INFO_REQUESTED = 'INFO_REQUESTED',
  INFO_PROVIDED = 'INFO_PROVIDED',
  CHARGEBACK = 'CHARGEBACK',
  SECOND_PRESENTMENT = 'SECOND_PRESENTMENT',
  SECOND_CHARGEBACK = 'SECOND_CHARGEBACK',
  ARBITRATION_REQUESTED = 'ARBITRATION_REQUESTED',
  CLOSED_ACCEPTED = 'CLOSED_ACCEPTED',
  CLOSED_DECIDED = 'CLOSED_DECIDED',
  CLOSED_EXPIRED = 'CLOSED_EXPIRED',
}

export type Party = 'ISSUER' | 'ACQUIRER' | 'SMT';

export type DisputeAction =
  | 'info-request'
  | 'info-response'
  | 'chargeback'
  | 'second-presentment'
  | 'second-chargeback'
  | 'arbitration-request'
  | 'accept'
  | 'decide';

export interface IsoMessage {
  mti: string;
  functionCode: string;
}

export const CHARGEBACK_WINDOW_DAYS = 120;
export const DEADLINES = {
  infoResponse: 30,
  secondPresentment: 45,
  secondChargeback: 30,
  arbitrationRequest: 30,
};

export interface DisputeState {
  stage: DisputeStage;
  transactionDate: string;
  transactionAmount: number;
  /** Échéance de la prochaine action attendue (incluse). */
  deadline: string | null;
}

export interface ActionInput {
  party: Party;
  /** Montant contesté (chargebacks, second présentement). */
  amount?: number;
  /** Nouveau justificatif joint à cette action. */
  newDocument?: boolean;
  /** Décision d'arbitrage : partie gagnante et frais. */
  winner?: 'ISSUER' | 'ACQUIRER';
  fees?: number;
}

export interface ActionResult {
  stage: DisputeStage;
  deadline: string | null;
  message: IsoMessage | null;
}

const CLOSED = [DisputeStage.CLOSED_ACCEPTED, DisputeStage.CLOSED_DECIDED, DisputeStage.CLOSED_EXPIRED];

/** Qui doit agir à chaque étape. */
export function partyToAct(stage: DisputeStage): Party | null {
  switch (stage) {
    case DisputeStage.OPENED:
    case DisputeStage.INFO_PROVIDED:
    case DisputeStage.SECOND_PRESENTMENT:
      return 'ISSUER';
    case DisputeStage.INFO_REQUESTED:
    case DisputeStage.CHARGEBACK:
    case DisputeStage.SECOND_CHARGEBACK:
      return 'ACQUIRER';
    case DisputeStage.ARBITRATION_REQUESTED:
      return 'SMT';
    default:
      return null;
  }
}

const NEXT: Partial<Record<DisputeStage, DisputeAction[]>> = {
  [DisputeStage.OPENED]: ['info-request', 'chargeback'],
  [DisputeStage.INFO_REQUESTED]: ['info-response'],
  [DisputeStage.INFO_PROVIDED]: ['chargeback', 'accept'],
  [DisputeStage.CHARGEBACK]: ['second-presentment', 'accept'],
  [DisputeStage.SECOND_PRESENTMENT]: ['second-chargeback', 'accept'],
  [DisputeStage.SECOND_CHARGEBACK]: ['arbitration-request', 'accept'],
  [DisputeStage.ARBITRATION_REQUESTED]: ['decide'],
};

export function allowedActions(stage: DisputeStage): DisputeAction[] {
  return NEXT[stage] ?? [];
}

export function initialDeadline(transactionDate: string): string {
  return addDays(transactionDate, CHARGEBACK_WINDOW_DAYS);
}

function isPartial(state: DisputeState, amount: number | undefined): boolean {
  if (amount === undefined) return false;
  if (amount <= 0 || amount > state.transactionAmount) {
    throw new BusinessRuleError('INVALID_AMOUNT', 'Le montant contesté doit être positif et ne pas dépasser celui de la transaction.');
  }
  return amount < state.transactionAmount;
}

export function applyAction(state: DisputeState, action: DisputeAction, input: ActionInput, today: string): ActionResult {
  if (CLOSED.includes(state.stage)) throw new BusinessRuleError('DISPUTE_CLOSED', 'Ce litige est clos.');
  if (!allowedActions(state.stage).includes(action)) {
    throw new BusinessRuleError('INVALID_TRANSITION', `Action « ${action} » impossible à l'étape ${state.stage}.`);
  }
  const expected = partyToAct(state.stage);
  if (input.party !== expected) {
    throw new BusinessRuleError('NOT_YOUR_TURN', `À cette étape, c'est à ${expected} d'agir.`);
  }
  if (state.deadline && today > state.deadline && action !== 'decide') {
    throw new BusinessRuleError('DEADLINE_PASSED', `Délai dépassé : l'échéance était le ${state.deadline}.`);
  }

  switch (action) {
    case 'info-request':
      return { stage: DisputeStage.INFO_REQUESTED, deadline: addDays(today, DEADLINES.infoResponse), message: { mti: '1644', functionCode: '603' } };
    case 'info-response':
      // Le chargeback reste possible jusqu'à 120 jours après la transaction.
      return { stage: DisputeStage.INFO_PROVIDED, deadline: initialDeadline(state.transactionDate), message: null };
    case 'chargeback':
      return {
        stage: DisputeStage.CHARGEBACK,
        deadline: addDays(today, DEADLINES.secondPresentment),
        message: { mti: '1442', functionCode: isPartial(state, input.amount) ? '453' : '450' },
      };
    case 'second-presentment':
      return {
        stage: DisputeStage.SECOND_PRESENTMENT,
        deadline: addDays(today, DEADLINES.secondChargeback),
        message: { mti: '1240', functionCode: isPartial(state, input.amount) ? '282' : '205' },
      };
    case 'second-chargeback':
      if (!input.newDocument) {
        throw new BusinessRuleError('NEW_DOCUMENT_REQUIRED', 'Un second chargeback exige un nouveau justificatif.');
      }
      return {
        stage: DisputeStage.SECOND_CHARGEBACK,
        deadline: addDays(today, DEADLINES.arbitrationRequest),
        message: { mti: '1442', functionCode: isPartial(state, input.amount) ? '454' : '451' },
      };
    case 'arbitration-request':
      return { stage: DisputeStage.ARBITRATION_REQUESTED, deadline: null, message: null };
    case 'accept':
      return { stage: DisputeStage.CLOSED_ACCEPTED, deadline: null, message: null };
    case 'decide':
      if (!input.winner) throw new BusinessRuleError('WINNER_REQUIRED', 'Indiquez la partie gagnante.');
      return {
        stage: DisputeStage.CLOSED_DECIDED,
        deadline: null,
        message: input.fees && input.fees > 0 ? { mti: '1740', functionCode: '700' } : null,
      };
  }
}

/** Litige dont l'échéance est passée sans action : la partie qui devait agir perd. */
export function expiredLoser(state: DisputeState, today: string): Party | null {
  if (CLOSED.includes(state.stage) || !state.deadline || today <= state.deadline) return null;
  const p = partyToAct(state.stage);
  return p === 'SMT' ? null : p;
}

/** Un numéro de carte n'est accepté que masqué : 6 premiers et 4 derniers chiffres (PCI-DSS). */
export const MASKED_PAN = /^\d{6}[*X]{3,9}\d{4}$/;

export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) throw new BusinessRuleError('INVALID_PAN', 'Numéro de carte invalide.');
  return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
}
