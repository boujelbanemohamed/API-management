import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UsageEvent } from './usage-event.entity';
import { ApiProduct } from '../apis/api-product.entity';
import { todayInTunis } from '../common/dates';

/** Entrée envoyée par le plugin http-logger d'APISIX (format par défaut, extrait). */
export interface ApisixLogEntry {
  route_id?: string;
  consumer?: { username?: string };
  latency?: number;
  start_time?: number;
  request?: { headers?: Record<string, string> };
  response?: { status?: number; headers?: Record<string, string> };
}

/** Statuts posés par la passerelle elle-même (refus) : jamais facturés. */
const GATEWAY_REFUSALS = new Set([401, 403, 429]);

export interface UsageSummaryRow {
  partnerCode: string;
  apiSlug: string;
  calls: number;
  billable: number;
  errors: number;
  avgLatencyMs: number;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(UsageEvent) private readonly repo: Repository<UsageEvent>,
    @InjectRepository(ApiProduct) private readonly apis: Repository<ApiProduct>,
  ) {}

  /**
   * Enregistre un lot d'appels. Idempotent : un même identifiant de requête n'est compté qu'une fois,
   * même si APISIX renvoie le lot après une erreur réseau.
   */
  async ingest(entries: ApisixLogEntry[]): Promise<{ received: number; inserted: number; ignored: number }> {
    const slugs = [...new Set(entries.map((e) => e.route_id).filter(Boolean) as string[])];
    const apis = new Map((slugs.length ? await this.apis.find({ where: { slug: In(slugs) } }) : []).map((a) => [a.slug, a]));

    const rows = new Map<string, Partial<UsageEvent>>();
    for (const entry of entries) {
      const row = this.toRow(entry, apis);
      if (row && !rows.has(row.requestId!)) rows.set(row.requestId!, row);
    }
    if (rows.size === 0) return { received: entries.length, inserted: 0, ignored: entries.length };

    const existing = await this.repo.find({ where: { requestId: In([...rows.keys()]) }, select: { requestId: true } });
    for (const e of existing) rows.delete(e.requestId);

    if (rows.size) {
      await this.repo.createQueryBuilder().insert().into(UsageEvent).values([...rows.values()]).orIgnore().execute();
    }
    return { received: entries.length, inserted: rows.size, ignored: entries.length - rows.size };
  }

  private toRow(entry: ApisixLogEntry, apis: Map<string, ApiProduct>): Partial<UsageEvent> | null {
    const requestId = header(entry.request?.headers, 'x-request-id') ?? header(entry.response?.headers, 'x-request-id');
    const consumer = entry.consumer?.username;
    const slug = entry.route_id;
    const status = Number(entry.response?.status);
    // Appel non authentifié (pas de consumer) : rejeté par la passerelle, rien à compter pour un partenaire.
    if (!requestId || !consumer || !slug || !Number.isFinite(status)) return null;

    const api = apis.get(slug);
    const success = status >= 200 && status < 300;
    const billable = success || (!!api?.billFailedCalls && status >= 400 && !GATEWAY_REFUSALS.has(status));
    const startedAt = Number.isFinite(entry.start_time) ? new Date(entry.start_time!) : new Date();

    return {
      requestId: requestId.slice(0, 80),
      partnerCode: consumer.toUpperCase(),
      apiSlug: slug,
      httpStatus: status,
      latencyMs: Math.max(0, Math.round(entry.latency ?? 0)),
      billable,
      day: todayInTunis(startedAt),
      occurredAt: startedAt.toISOString(),
    };
  }

  /** Synthèse par partenaire et par service sur une période (bornes incluses). */
  async summary(filter: { from: string; to: string; partnerCode?: string; apiSlug?: string }): Promise<UsageSummaryRow[]> {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('u.partnerCode', 'partnerCode')
      .addSelect('u.apiSlug', 'apiSlug')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN u.billable THEN 1 ELSE 0 END)', 'billable')
      .addSelect('SUM(CASE WHEN u.httpStatus >= 400 THEN 1 ELSE 0 END)', 'errors')
      .addSelect('AVG(u.latencyMs)', 'avgLatencyMs')
      .where('u.day >= :from AND u.day <= :to', { from: filter.from, to: filter.to })
      .groupBy('u.partnerCode')
      .addGroupBy('u.apiSlug')
      .orderBy('u.partnerCode')
      .addOrderBy('u.apiSlug');
    if (filter.partnerCode) qb.andWhere('u.partnerCode = :p', { p: filter.partnerCode.toUpperCase() });
    if (filter.apiSlug) qb.andWhere('u.apiSlug = :a', { a: filter.apiSlug });
    const raw = await qb.getRawMany();
    return raw.map((r) => ({
      partnerCode: r.partnerCode,
      apiSlug: r.apiSlug,
      calls: Number(r.calls),
      billable: Number(r.billable),
      errors: Number(r.errors),
      avgLatencyMs: Math.round(Number(r.avgLatencyMs) || 0),
    }));
  }

  /** Volume par jour, pour les graphiques de la console et du portail. */
  async daily(filter: { from: string; to: string; partnerCode?: string; apiSlug?: string }) {
    const qb = this.repo
      .createQueryBuilder('u')
      .select('u.day', 'day')
      .addSelect('COUNT(*)', 'calls')
      .addSelect('SUM(CASE WHEN u.billable THEN 1 ELSE 0 END)', 'billable')
      .where('u.day >= :from AND u.day <= :to', { from: filter.from, to: filter.to })
      .groupBy('u.day')
      .orderBy('u.day');
    if (filter.partnerCode) qb.andWhere('u.partnerCode = :p', { p: filter.partnerCode.toUpperCase() });
    if (filter.apiSlug) qb.andWhere('u.apiSlug = :a', { a: filter.apiSlug });
    return (await qb.getRawMany()).map((r) => ({ day: r.day, calls: Number(r.calls), billable: Number(r.billable) }));
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? String(headers[key]) : undefined;
}
