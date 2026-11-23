import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { Partner, PartnerStatus } from './partner.entity';
import { CreatePartnerDto, UpdatePartnerDto } from './partners.dto';
import { Subscription, SubscriptionStatus } from '../subscriptions/subscription.entity';
import { LIVE_STATUSES, BusinessRuleError } from '../subscriptions/subscription-rules';
import { AuditService } from '../audit/audit.service';
import { GatewaySyncService } from '../gateway/gateway-sync.service';
import { GATEWAY_ADMIN, GatewayAdmin } from '../gateway/gateway-admin';
import { consumerName } from '../gateway/gateway-config.builder';
import { CLOCK, Clock } from '../common/clock';
import { diff, findOr404 } from '../common/crud';

const PARTNER_TRANSITIONS: Record<'activate' | 'suspend' | 'terminate', PartnerStatus[]> = {
  activate: [PartnerStatus.PENDING, PartnerStatus.SUSPENDED],
  suspend: [PartnerStatus.ACTIVE],
  terminate: [PartnerStatus.PENDING, PartnerStatus.ACTIVE, PartnerStatus.SUSPENDED],
};

@Injectable()
export class PartnersService {
  constructor(
    @InjectRepository(Partner) private readonly repo: Repository<Partner>,
    @InjectRepository(Subscription) private readonly subscriptions: Repository<Subscription>,
    private readonly audit: AuditService,
    private readonly sync: GatewaySyncService,
    @Inject(GATEWAY_ADMIN) private readonly gateway: GatewayAdmin,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(status?: PartnerStatus): Promise<Partner[]> {
    return this.repo.find({ where: status ? { status } : {}, order: { name: 'ASC' } });
  }

  get(id: string): Promise<Partner> {
    return findOr404(this.repo, id, 'Partenaire');
  }

  async create(dto: CreatePartnerDto, actor: string): Promise<Partner> {
    const code = dto.code.toUpperCase();
    if (await this.repo.findOne({ where: { code } })) {
      throw new BusinessRuleError('DUPLICATE_CODE', `Le code ${code} est déjà utilisé.`);
    }
    const partner = await this.repo.save(
      this.repo.create({ ...dto, code, allowedIps: dto.allowedIps ?? [], status: PartnerStatus.PENDING }),
    );
    await this.audit.record({ actor, action: 'partner.created', objectType: 'partner', objectId: partner.id, details: { code } });
    await this.sync.trySync(`partenaire ${code} créé`);
    return partner;
  }

  async update(id: string, dto: UpdatePartnerDto, actor: string): Promise<Partner> {
    const partner = await this.get(id);
    const changes = diff(partner, dto);
    Object.assign(partner, dto);
    const saved = await this.repo.save(partner);
    if (Object.keys(changes).length) {
      await this.audit.record({ actor, action: 'partner.updated', objectType: 'partner', objectId: id, details: changes });
      await this.sync.trySync(`partenaire ${partner.code} modifié`);
    }
    return saved;
  }

  async changeStatus(id: string, action: 'activate' | 'suspend' | 'terminate', actor: string, reason?: string): Promise<Partner> {
    const partner = await this.get(id);
    if (!PARTNER_TRANSITIONS[action].includes(partner.status)) {
      throw new BusinessRuleError('INVALID_TRANSITION', `Action « ${action} » impossible : le partenaire est ${partner.status}.`);
    }
    const from = partner.status;
    partner.status = { activate: PartnerStatus.ACTIVE, suspend: PartnerStatus.SUSPENDED, terminate: PartnerStatus.TERMINATED }[action];
    await this.repo.save(partner);

    let terminatedSubscriptions = 0;
    if (action === 'terminate') {
      // Résilier le partenaire résilie tous ses abonnements vivants.
      const live = await this.subscriptions.find({
        where: { partnerId: id, status: In([...LIVE_STATUSES, SubscriptionStatus.EXPIRED]) },
      });
      for (const sub of live) sub.status = SubscriptionStatus.TERMINATED;
      await this.subscriptions.save(live);
      terminatedSubscriptions = live.length;
      partner.apiKeyHash = null;
      await this.repo.save(partner);
    }

    await this.audit.record({
      actor,
      action: `partner.${action}`,
      objectType: 'partner',
      objectId: id,
      details: { from, to: partner.status, reason: reason ?? null, terminatedSubscriptions },
    });
    // Suspension : effet immédiat sur tous les appels, via la synchronisation des droits.
    await this.sync.trySync(`partenaire ${partner.code} : ${action}`);
    return partner;
  }

  /**
   * Génère (ou remplace) la clé d'API du partenaire. La clé en clair n'est renvoyée qu'une fois ;
   * seule son empreinte SHA-256 est conservée. L'ancienne clé cesse de fonctionner immédiatement.
   */
  async issueApiKey(id: string, actor: string): Promise<{ apiKey: string; createdAt: string; fingerprint: string }> {
    const partner = await this.get(id);
    if (partner.status === PartnerStatus.TERMINATED) {
      throw new BusinessRuleError('PARTNER_TERMINATED', 'Impossible de générer une clé pour un partenaire résilié.');
    }
    const apiKey = `ak_${partner.code.toLowerCase()}_${randomBytes(24).toString('base64url')}`;
    const fingerprint = createHash('sha256').update(apiKey).digest('hex');

    // Le consumer doit exister côté passerelle avant d'y rattacher l'identifiant.
    await this.sync.syncAll(`clé d'API ${partner.code}`);
    await this.gateway.putCredential(consumerName(partner), 'api-key', { 'key-auth': { key: apiKey } });

    const rotated = partner.apiKeyHash !== null;
    partner.apiKeyHash = fingerprint;
    partner.apiKeyCreatedAt = this.clock.now().toISOString();
    await this.repo.save(partner);
    await this.audit.record({
      actor,
      action: rotated ? 'partner.api_key_rotated' : 'partner.api_key_created',
      objectType: 'partner',
      objectId: id,
      details: { fingerprint: fingerprint.slice(0, 12) },
    });
    return { apiKey, createdAt: partner.apiKeyCreatedAt, fingerprint: fingerprint.slice(0, 12) };
  }
}
