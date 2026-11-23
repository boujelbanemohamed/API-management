import {
  BusinessRuleError,
  assertPeriod,
  assertTransition,
  effectiveDailyQuota,
  grantsAccess,
  initialStatus,
  isExpired,
  planIdAt,
} from '../src/subscriptions/subscription-rules';
import { SubscriptionStatus } from '../src/subscriptions/subscription.entity';
import { PartnerStatus } from '../src/partners/partner.entity';
import { ApprovalMode } from '../src/plans/plan.entity';
import { addYears, firstDayOfNextMonth, isIsoDate, todayInTunis } from '../src/common/dates';
import { partner, plan, subscription } from './fixtures';

describe('Règles du cycle de vie des abonnements', () => {
  it('autorise uniquement les transitions prévues', () => {
    expect(() => assertTransition(subscription({ status: SubscriptionStatus.PENDING }), 'validate')).not.toThrow();
    expect(() => assertTransition(subscription({ status: SubscriptionStatus.ACTIVE }), 'validate')).toThrow(BusinessRuleError);
    expect(() => assertTransition(subscription({ status: SubscriptionStatus.EXPIRED }), 'renew')).not.toThrow();
    expect(() => assertTransition(subscription({ status: SubscriptionStatus.TERMINATED }), 'reactivate')).toThrow(
      /résilié/,
    );
    expect(() => assertTransition(subscription({ status: SubscriptionStatus.REJECTED }), 'terminate')).toThrow();
  });

  it('refuse une période dont la fin précède le début', () => {
    expect(() => assertPeriod('2026-05-01', '2026-04-30')).toThrow(/postérieure/);
    expect(() => assertPeriod('2026-05-01', '2026-05-01')).not.toThrow();
  });

  it('active d’emblée uniquement en validation automatique et partenaire actif', () => {
    expect(initialStatus(plan({ approval: ApprovalMode.AUTOMATIC }), partner())).toBe(SubscriptionStatus.ACTIVE);
    expect(initialStatus(plan({ approval: ApprovalMode.MANUAL }), partner())).toBe(SubscriptionStatus.PENDING);
    expect(initialStatus(plan({ approval: ApprovalMode.AUTOMATIC }), partner({ status: PartnerStatus.PENDING }))).toBe(
      SubscriptionStatus.PENDING,
    );
  });

  it('n’ouvre l’accès que dans la période, abonnement et partenaire actifs', () => {
    const sub = subscription();
    expect(grantsAccess(sub, partner(), '2026-06-15')).toBe(true);
    expect(grantsAccess(sub, partner(), '2026-12-31')).toBe(true); // dernier jour inclus
    expect(grantsAccess(sub, partner(), '2027-01-01')).toBe(false);
    expect(grantsAccess(sub, partner(), '2025-12-31')).toBe(false);
    expect(grantsAccess(sub, partner({ status: PartnerStatus.SUSPENDED }), '2026-06-15')).toBe(false);
    expect(grantsAccess(subscription({ status: SubscriptionStatus.SUSPENDED }), partner(), '2026-06-15')).toBe(false);
  });

  it('applique le quota personnalisé et le plan programmé', () => {
    expect(effectiveDailyQuota(subscription(), plan())).toBe(10000);
    expect(effectiveDailyQuota(subscription({ customDailyQuota: 250 }), plan())).toBe(250);
    const sub = subscription({ scheduledPlanId: 'plan-2', scheduledPlanFrom: '2026-07-01' });
    expect(planIdAt(sub, '2026-06-30')).toBe('plan-1');
    expect(planIdAt(sub, '2026-07-01')).toBe('plan-2');
  });

  it('détecte les abonnements échus', () => {
    expect(isExpired(subscription(), '2027-01-01')).toBe(true);
    expect(isExpired(subscription(), '2026-12-31')).toBe(false);
    expect(isExpired(subscription({ status: SubscriptionStatus.PENDING }), '2027-01-01')).toBe(false);
  });
});

describe('Dates métier', () => {
  it('calcule le jour à Tunis (UTC+1)', () => {
    expect(todayInTunis(new Date('2026-03-31T23:30:00Z'))).toBe('2026-04-01');
    expect(todayInTunis(new Date('2026-03-31T22:30:00Z'))).toBe('2026-03-31');
  });

  it('valide et calcule les dates', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(firstDayOfNextMonth('2026-12-15')).toBe('2027-01-01');
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
  });
});
