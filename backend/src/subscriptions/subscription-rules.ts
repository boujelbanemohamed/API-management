import { Subscription, SubscriptionStatus } from './subscription.entity';
import { Partner, PartnerStatus } from '../partners/partner.entity';
import { Plan } from '../plans/plan.entity';

/**
 * Règles du cycle de vie d'un abonnement (spécifications fonctionnelles §6.2).
 * Fonctions pures : aucune dépendance à la base ni à la passerelle.
 */

export class BusinessRuleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type Transition = 'validate' | 'reject' | 'suspend' | 'reactivate' | 'renew' | 'changePlan' | 'terminate';

const ALLOWED: Record<Transition, SubscriptionStatus[]> = {
  validate: [SubscriptionStatus.PENDING],
  reject: [SubscriptionStatus.PENDING],
  suspend: [SubscriptionStatus.ACTIVE],
  reactivate: [SubscriptionStatus.SUSPENDED],
  renew: [SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED, SubscriptionStatus.EXPIRED],
  changePlan: [SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED],
  terminate: [
    SubscriptionStatus.PENDING,
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.SUSPENDED,
    SubscriptionStatus.EXPIRED,
  ],
};

const LABELS: Record<SubscriptionStatus, string> = {
  PENDING: 'en attente',
  ACTIVE: 'actif',
  SUSPENDED: 'suspendu',
  EXPIRED: 'expiré',
  REJECTED: 'refusé',
  TERMINATED: 'résilié',
};

export function assertTransition(sub: Subscription, transition: Transition): void {
  if (!ALLOWED[transition].includes(sub.status)) {
    throw new BusinessRuleError(
      'INVALID_TRANSITION',
      `Action « ${transition} » impossible : l'abonnement est ${LABELS[sub.status]}.`,
    );
  }
}

export function assertPeriod(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new BusinessRuleError('INVALID_PERIOD', 'La date de fin doit être postérieure ou égale à la date de début.');
  }
}

/** Statut initial : actif d'emblée si le plan est en validation automatique et le partenaire actif. */
export function initialStatus(plan: Plan, partner: Partner): SubscriptionStatus {
  return plan.approval === 'AUTOMATIC' && partner.status === PartnerStatus.ACTIVE
    ? SubscriptionStatus.ACTIVE
    : SubscriptionStatus.PENDING;
}

/** Un abonnement laisse-t-il passer les appels aujourd'hui ? (RG-T-05) */
export function grantsAccess(sub: Subscription, partner: Partner, today: string): boolean {
  return (
    partner.status === PartnerStatus.ACTIVE &&
    sub.status === SubscriptionStatus.ACTIVE &&
    sub.startDate <= today &&
    today <= sub.endDate
  );
}

/** Quota journalier effectif : le quota personnalisé l'emporte sur celui du plan (RG-T-15). */
export function effectiveDailyQuota(sub: Subscription, plan: Plan): number {
  return sub.customDailyQuota ?? plan.dailyQuota;
}

/** Plan applicable à une date donnée, en tenant compte d'un changement programmé. */
export function planIdAt(sub: Subscription, day: string): string {
  if (sub.scheduledPlanId && sub.scheduledPlanFrom && day >= sub.scheduledPlanFrom) {
    return sub.scheduledPlanId;
  }
  return sub.planId;
}

/** Un abonnement actif dont la date de fin est passée doit être marqué expiré. */
export function isExpired(sub: Subscription, today: string): boolean {
  return (
    (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.SUSPENDED) &&
    sub.endDate < today
  );
}

/** Statuts qui occupent la place : on ne peut pas avoir deux abonnements vivants au même service. */
export const LIVE_STATUSES = [SubscriptionStatus.PENDING, SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED];
