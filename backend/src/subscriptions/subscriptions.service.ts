import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from "typeorm";
import { Environment, Subscription, SubscriptionStatus } from './subscription.entity';
import { ChangePlanDto, CreateSubscriptionDto } from './subscriptions.dto';
import {
  BusinessRuleError,
  LIVE_STATUSES,
  assertPeriod,
  assertTransition,
  initialStatus,
  isExpired,
} from './subscription-rules';
import { Partner, PartnerStatus } from '../partners/partner.entity';
import { ApiProduct, ApiStatus } from '../apis/api-product.entity';
import { Plan } from '../plans/plan.entity';
import { AuditService } from '../audit/audit.service';
import { GatewaySyncService } from '../gateway/gateway-sync.service';
import { CLOCK, Clock } from '../common/clock';
import { addYears, firstDayOfNextMonth, isIsoDate } from '../common/dates';
import { findOr404 } from '../common/crud';
import { APP_CONFIG, AppConfig } from '../config';
import { Onboarding } from '../onboarding/onboarding.entities';
import { isAcceptanceSigned } from '../onboarding/onboarding-rules';

export interface SubscriptionFilter {
  partnerId?: string;
  apiId?: string;
  status?: SubscriptionStatus;
  environment?: Environment;
}

@Injectable()
export class SubscriptionsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(Subscription) private readonly repo: Repository<Subscription>,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
    @InjectRepository(Plan) private readonly plans: Repository<Plan>,
    private readonly audit: AuditService,
    private readonly sync: GatewaySyncService,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectRepository(Onboarding) private readonly onboardings: Repository<Onboarding>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Tâche de maintenance horaire : expirations et changements de plan programmés. */
  onApplicationBootstrap(): void {
    if (process.env.DISABLE_JOBS === 'true') return;
    this.timer = setInterval(() => {
      this.runDailyMaintenance().catch((e) => this.logger.error(`Maintenance en échec : ${e}`));
    }, 3600_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(filter: SubscriptionFilter) {
    const where: FindOptionsWhere<Subscription> = {};
    for (const key of ['partnerId', 'apiId', 'status', 'environment'] as const) {
      if (filter[key]) (where as any)[key] = filter[key];
    }
    return this.repo.find({ where, order: { createdAt: 'DESC' } });
  }

  get(id: string) {
    return findOr404(this.repo, id, 'Abonnement');
  }

  async create(dto: CreateSubscriptionDto, actor: string): Promise<Subscription> {
    const partner = await findOr404(this.partners, dto.partnerId, 'Partenaire');
    const api = await findOr404(this.apis, dto.apiId, 'Service');
    const plan = await findOr404(this.plans, dto.planId, 'Plan');
    const environment = dto.environment ?? Environment.PRODUCTION;
    await this.assertOnboarded(partner.id, api.id, environment);

    if (partner.status === PartnerStatus.TERMINATED) {
      throw new BusinessRuleError('PARTNER_TERMINATED', 'Ce partenaire est résilié.');
    }
    const subscribable =
      api.status === ApiStatus.PUBLISHED || (api.status === ApiStatus.BETA && environment === Environment.SANDBOX);
    if (!subscribable) {
      throw new BusinessRuleError(
        'API_NOT_SUBSCRIBABLE',
        api.status === ApiStatus.BETA
          ? 'Ce service est en bêta : abonnement possible en sandbox uniquement.'
          : `Ce service n'accepte pas de nouveaux abonnements (statut ${api.status}).`,
      );
    }
    if (!plan.active) {
      throw new BusinessRuleError('PLAN_INACTIVE', 'Ce plan n’accepte plus de nouveaux abonnements.');
    }

    const startDate = dto.startDate ?? this.clock.today();
    const endDate = dto.endDate ?? addYears(startDate, 1);
    this.assertDates(startDate, endDate);

    const duplicate = await this.repo.findOne({
      where: { partnerId: partner.id, apiId: api.id, environment, status: In(LIVE_STATUSES) },
    });
    if (duplicate) {
      throw new BusinessRuleError(
        'DUPLICATE_SUBSCRIPTION',
        'Ce partenaire a déjà un abonnement en cours à ce service dans cet environnement : renouvelez-le ou changez son plan.',
      );
    }

    const sub = await this.repo.save(
      this.repo.create({
        partnerId: partner.id,
        apiId: api.id,
        planId: plan.id,
        environment,
        startDate,
        endDate,
        customDailyQuota: dto.customDailyQuota ?? null,
        contractReference: dto.contractReference ?? null,
        status: initialStatus(plan, partner),
      }),
    );
    await this.audit.record({
      actor,
      action: 'subscription.created',
      objectType: 'subscription',
      objectId: sub.id,
      details: { partner: partner.code, api: api.slug, plan: plan.name, environment, startDate, endDate, status: sub.status },
    });
    await this.sync.trySync(`abonnement ${partner.code} / ${api.slug} créé`);
    return sub;
  }

  async validate(id: string, actor: string) {
    const sub = await this.get(id);
    await this.assertOnboarded(sub.partnerId, sub.apiId, sub.environment);
    return this.transition(id, 'validate', actor, (s) => (s.status = SubscriptionStatus.ACTIVE));
  }

  reject(id: string, actor: string, reason?: string) {
    return this.transition(id, 'reject', actor, (s) => (s.status = SubscriptionStatus.REJECTED), { reason });
  }

  suspend(id: string, actor: string, reason?: string) {
    return this.transition(id, 'suspend', actor, (s) => (s.status = SubscriptionStatus.SUSPENDED), { reason });
  }

  reactivate(id: string, actor: string) {
    return this.transition(id, 'reactivate', actor, (s) => (s.status = SubscriptionStatus.ACTIVE));
  }

  terminate(id: string, actor: string, reason?: string) {
    return this.transition(id, 'terminate', actor, (s) => (s.status = SubscriptionStatus.TERMINATED), { reason });
  }

  async renew(id: string, endDate: string, actor: string) {
    const current = await this.get(id);
    if (!isIsoDate(endDate) || endDate <= current.endDate) {
      throw new BusinessRuleError('INVALID_PERIOD', `La nouvelle date de fin doit être postérieure au ${current.endDate}.`);
    }
    return this.transition(id, 'renew', actor, (s) => {
      const previous = s.endDate;
      s.endDate = endDate;
      // Un abonnement expiré redevient actif ; un abonnement suspendu reste suspendu.
      if (s.status === SubscriptionStatus.EXPIRED) s.status = SubscriptionStatus.ACTIVE;
      return { previousEndDate: previous, endDate };
    });
  }

  async changePlan(id: string, dto: ChangePlanDto, actor: string) {
    const plan = await findOr404(this.plans, dto.planId, 'Plan');
    if (!plan.active) throw new BusinessRuleError('PLAN_INACTIVE', 'Ce plan n’accepte plus de nouveaux abonnements.');
    return this.transition(id, 'changePlan', actor, (s) => {
      if (s.planId === plan.id && !s.scheduledPlanId) {
        throw new BusinessRuleError('SAME_PLAN', 'L’abonnement utilise déjà ce plan.');
      }
      const from = s.planId;
      if (dto.effective === 'IMMEDIATE') {
        s.planId = plan.id;
        s.scheduledPlanId = null;
        s.scheduledPlanFrom = null;
        return { from, to: plan.id, effective: this.clock.today() };
      }
      s.scheduledPlanId = plan.id;
      s.scheduledPlanFrom = firstDayOfNextMonth(this.clock.today());
      return { from, to: plan.id, effective: s.scheduledPlanFrom };
    });
  }

  async setCustomQuota(id: string, quota: number | null, actor: string) {
    const sub = await this.get(id);
    if (!LIVE_STATUSES.includes(sub.status)) {
      throw new BusinessRuleError('INVALID_TRANSITION', 'Le quota ne peut être modifié que sur un abonnement en cours.');
    }
    const from = sub.customDailyQuota;
    sub.customDailyQuota = quota;
    const saved = await this.repo.save(sub);
    await this.audit.record({ actor, action: 'subscription.quota_changed', objectType: 'subscription', objectId: id, details: { from, to: quota } });
    await this.sync.trySync(`quota abonnement ${id} modifié`);
    return saved;
  }

  /**
   * Passe en EXPIRED les abonnements arrivés à échéance et applique les changements de plan programmés.
   * La passerelle refuse déjà les appels hors période (contrôle des dates dans le plugin) :
   * cette tâche met le statut métier en cohérence.
   */
  async runDailyMaintenance(): Promise<{ expired: number; plansApplied: number }> {
    const today = this.clock.today();
    const candidates = await this.repo.find({
      where: { status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED]) },
    });
    let expired = 0;
    let plansApplied = 0;
    for (const sub of candidates) {
      if (isExpired(sub, today)) {
        sub.status = SubscriptionStatus.EXPIRED;
        await this.repo.save(sub);
        await this.audit.record({ actor: 'system', origin: 'SYSTEM', action: 'subscription.expired', objectType: 'subscription', objectId: sub.id, details: { endDate: sub.endDate } });
        expired++;
      } else if (sub.scheduledPlanId && sub.scheduledPlanFrom && sub.scheduledPlanFrom <= today) {
        const from = sub.planId;
        sub.planId = sub.scheduledPlanId;
        sub.scheduledPlanId = null;
        sub.scheduledPlanFrom = null;
        await this.repo.save(sub);
        await this.audit.record({ actor: 'system', origin: 'SYSTEM', action: 'subscription.plan_applied', objectType: 'subscription', objectId: sub.id, details: { from, to: sub.planId } });
        plansApplied++;
      }
    }
    if (expired || plansApplied) await this.sync.trySync('maintenance quotidienne');
    return { expired, plansApplied };
  }

  /** Pas de production sans mise en service validée : PV signé banque + SMT (spécifications §10). */
  private async assertOnboarded(partnerId: string, apiId: string, environment: Environment): Promise<void> {
    if (environment !== Environment.PRODUCTION) return;
    if (this.config.onboarding?.enforceForProduction === false) return;
    const done = await this.onboardings.find({ where: { partnerId, apiId, cancelled: false } });
    if (!done.some(isAcceptanceSigned)) {
      throw new BusinessRuleError(
        'ONBOARDING_REQUIRED',
        'Production refusée : aucune mise en service validée (PV de recette signé par la banque et SMT) pour ce service.',
      );
    }
  }

  private assertDates(startDate: string, endDate: string): void {
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) {
      throw new BusinessRuleError('INVALID_DATE', 'Date invalide (format AAAA-MM-JJ attendu).');
    }
    assertPeriod(startDate, endDate);
  }

  private async transition(
    id: string,
    name: Parameters<typeof assertTransition>[1],
    actor: string,
    apply: (sub: Subscription) => unknown,
    extra: Record<string, unknown> = {},
  ): Promise<Subscription> {
    const sub = await this.get(id);
    assertTransition(sub, name);
    const from = sub.status;
    const result = apply(sub);
    const details = { from, to: sub.status, ...extra, ...(typeof result === 'object' && result ? result : {}) };
    const saved = await this.repo.save(sub);
    await this.audit.record({ actor, action: `subscription.${name}`, objectType: 'subscription', objectId: id, details });
    await this.sync.trySync(`abonnement ${id} : ${name}`);
    return saved;
  }
}
