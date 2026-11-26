/** Libellés français des valeurs du back-end. Les autres langues viendront compléter ce dictionnaire. */

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'accent' | undefined;
export interface Label { text: string; tone?: Tone }

const L = (text: string, tone?: Tone): Label => ({ text, tone });

export const REQUEST_TYPE: Record<string, string> = {
  OPERATION: 'Opération',
  API_ACCESS: 'Accès API',
  IP_CERTIFICATE: 'IP et certificat',
  SUPPORT: 'Ticket support',
};

export const REQUEST_STATUS: Record<string, Label> = {
  NEW: L('Nouvelle', 'info'),
  IN_PROGRESS: L('Prise en charge', 'accent'),
  WAITING_BANK: L('En attente de votre réponse', 'warn'),
  WAITING_THIRD_PARTY: L('En attente d’un tiers', 'warn'),
  AWAITING_VALIDATION: L('En validation', 'accent'),
  DONE: L('Traitée', 'ok'),
  CLOSED: L('Clôturée'),
  REJECTED: L('Rejetée', 'danger'),
};

export const SLA: Record<string, Label> = {
  OK: L('Dans les délais', 'ok'),
  ALERT: L('Délai bientôt atteint', 'warn'),
  BREACH: L('Délai dépassé', 'danger'),
  PAUSED: L('Délai suspendu'),
  MET: L('Délai respecté', 'ok'),
  MISSED: L('Délai non respecté', 'danger'),
};

export const DISPUTE_STAGE: Record<string, Label> = {
  OPENED: L('Ouvert', 'info'),
  INFO_REQUESTED: L('Demande d’information', 'accent'),
  INFO_PROVIDED: L('Information fournie', 'accent'),
  CHARGEBACK: L('Chargeback', 'warn'),
  SECOND_PRESENTMENT: L('Second présentement', 'warn'),
  SECOND_CHARGEBACK: L('Second chargeback', 'warn'),
  ARBITRATION_REQUESTED: L('Arbitrage demandé', 'danger'),
  CLOSED_ACCEPTED: L('Clos : accepté', 'ok'),
  CLOSED_DECIDED: L('Clos : arbitrage rendu', 'ok'),
  CLOSED_EXPIRED: L('Clos : délai expiré'),
};

export const DISPUTE_ACTION: Record<string, string> = {
  'info-request': 'Demander une information',
  'info-response': 'Fournir l’information',
  chargeback: 'Émettre le chargeback',
  'second-presentment': 'Second présentement',
  'second-chargeback': 'Second chargeback',
  'arbitration-request': 'Demander l’arbitrage',
  accept: 'Accepter et clore',
  expire: 'Clôture pour délai expiré',
  decide: 'Décision d’arbitrage',
};

export const ONBOARDING_STEP: Record<string, string> = {
  REQUEST: 'Demande',
  CONTRACT: 'Contrat',
  SANDBOX: 'Sandbox',
  TESTS: 'Tests',
  ACCEPTANCE: 'Recette',
  PRODUCTION: 'Production',
};
export const STEP_ORDER = ['REQUEST', 'CONTRACT', 'SANDBOX', 'TESTS', 'ACCEPTANCE', 'PRODUCTION'];

export const TEST_MODE: Record<string, string> = { AUTONOMOUS: 'Autonomie', JOINT: 'Conjoint', MIXED: 'Mixte' };

export const CASE_STATUS: Record<string, Label> = {
  TODO: L('À faire'),
  PASSED: L('Réussi', 'ok'),
  FAILED: L('Échoué', 'danger'),
  NOT_APPLICABLE: L('Non applicable'),
};

export const SUBSCRIPTION_STATUS: Record<string, Label> = {
  PENDING: L('En attente de validation', 'warn'),
  ACTIVE: L('Actif', 'ok'),
  SUSPENDED: L('Suspendu', 'danger'),
  EXPIRED: L('Expiré'),
  TERMINATED: L('Résilié'),
  REJECTED: L('Refusé', 'danger'),
};

/** Acheminement d'un message ISO vers la plateforme Chargeback. */
export const DELIVERY: Record<string, Label> = {
  PENDING: L('Envoi en cours', 'info'),
  ACKED: L('Accusé par la plateforme', 'ok'),
  REJECTED: L('Refusé par la plateforme', 'danger'),
  FAILED: L('Échec d’envoi', 'danger'),
};

export const OPERATION_SERVICE: Record<string, string> = {
  CARTE: 'Carte',
  GAB: 'GAB',
  TPE: 'TPE',
  AFFILIATION: 'Affiliation e-commerce',
};

export const ENVIRONMENT: Record<string, string> = { SANDBOX: 'Sandbox', PRODUCTION: 'Production' };
