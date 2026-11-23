import { BusinessRuleError } from '../subscriptions/subscription-rules';

/**
 * Mises en service (spécifications §10).
 * Demande → Contrat → Sandbox → Tests → Recette → Production. Fonctions pures.
 */

export enum OnboardingStep {
  REQUEST = 'REQUEST',
  CONTRACT = 'CONTRACT',
  SANDBOX = 'SANDBOX',
  TESTS = 'TESTS',
  ACCEPTANCE = 'ACCEPTANCE',
  PRODUCTION = 'PRODUCTION',
}

export const STEP_ORDER = [
  OnboardingStep.REQUEST,
  OnboardingStep.CONTRACT,
  OnboardingStep.SANDBOX,
  OnboardingStep.TESTS,
  OnboardingStep.ACCEPTANCE,
  OnboardingStep.PRODUCTION,
];

export enum TestMode {
  AUTONOMOUS = 'AUTONOMOUS',
  JOINT = 'JOINT',
  MIXED = 'MIXED',
}

export enum TestCaseStatus {
  TODO = 'TODO',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

export interface OnboardingState {
  step: OnboardingStep;
  cancelled: boolean;
  contractReference: string | null;
  contractValidatedBy: string | null;
  testMode: TestMode | null;
  jointSessions: number;
  bankSignedBy: string | null;
  smtSignedBy: string | null;
}

export interface CaseState {
  mandatory: boolean;
  status: TestCaseStatus;
  evidence: string | null;
}

/** PV de recette signé par la banque ET par SMT (F-MES-07). */
export function isAcceptanceSigned(o: Pick<OnboardingState, 'bankSignedBy' | 'smtSignedBy'>): boolean {
  return !!o.bankSignedBy && !!o.smtSignedBy;
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const i = STEP_ORDER.indexOf(step);
  return i < STEP_ORDER.length - 1 ? STEP_ORDER[i + 1] : null;
}

/** Contrôle le passage à l'étape suivante ; renvoie l'étape atteinte. */
export function assertCanAdvance(o: OnboardingState, cases: CaseState[]): OnboardingStep {
  if (o.cancelled) throw new BusinessRuleError('ONBOARDING_CANCELLED', 'Cette mise en service est annulée.');
  const target = nextStep(o.step);
  if (!target) throw new BusinessRuleError('ONBOARDING_DONE', 'Le service est déjà en production.');

  switch (o.step) {
    case OnboardingStep.CONTRACT:
      if (!o.contractReference || !o.contractValidatedBy) {
        throw new BusinessRuleError('CONTRACT_MISSING', 'Le contrat signé doit être joint et validé par le juridique.');
      }
      break;
    case OnboardingStep.SANDBOX:
      if (!o.testMode) throw new BusinessRuleError('TEST_MODE_MISSING', 'Choisissez le mode de test : autonomie, conjoint ou mixte.');
      break;
    case OnboardingStep.TESTS: {
      const blocking = cases.filter(
        (c) => c.mandatory && !(c.status === TestCaseStatus.PASSED && c.evidence) && c.status !== TestCaseStatus.NOT_APPLICABLE,
      );
      if (cases.length === 0 || blocking.length > 0) {
        throw new BusinessRuleError(
          'TESTS_INCOMPLETE',
          `Cas obligatoires non réussis ou sans preuve : ${blocking.length || 'aucun cas au cahier'}.`,
        );
      }
      if (o.testMode !== TestMode.AUTONOMOUS && o.jointSessions === 0) {
        throw new BusinessRuleError('JOINT_SESSION_MISSING', 'Le mode choisi exige au moins une session de test conjointe.');
      }
      break;
    }
    case OnboardingStep.ACCEPTANCE:
      if (!isAcceptanceSigned(o)) {
        throw new BusinessRuleError('ACCEPTANCE_NOT_SIGNED', 'Le PV de recette doit être signé par la banque et par SMT.');
      }
      break;
  }
  return target;
}

/** Les signatures ne sont possibles qu'en recette, une fois par partie. */
export function assertCanSign(o: OnboardingState, party: 'BANK' | 'SMT'): void {
  if (o.step !== OnboardingStep.ACCEPTANCE) {
    throw new BusinessRuleError('NOT_IN_ACCEPTANCE', 'Le PV ne peut être signé qu’à l’étape de recette.');
  }
  if ((party === 'BANK' && o.bankSignedBy) || (party === 'SMT' && o.smtSignedBy)) {
    throw new BusinessRuleError('ALREADY_SIGNED', 'Cette partie a déjà signé le PV.');
  }
}
