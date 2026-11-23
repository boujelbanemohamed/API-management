import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { AuditEvent } from './audit-event.entity';

export interface AuditEntry {
  actor: string;
  origin?: 'ADMIN' | 'PARTNER' | 'SYSTEM';
  action: string;
  objectType: string;
  objectId: string;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@InjectRepository(AuditEvent) private readonly repo: Repository<AuditEvent>) {}

  async record(entry: AuditEntry): Promise<AuditEvent> {
    return this.repo.save(
      this.repo.create({
        actor: entry.actor,
        origin: entry.origin ?? 'ADMIN',
        action: entry.action,
        objectType: entry.objectType,
        objectId: entry.objectId,
        details: entry.details ?? null,
        at: new Date().toISOString(),
      }),
    );
  }

  async search(filter: { objectType?: string; objectId?: string; actor?: string; limit?: number }): Promise<AuditEvent[]> {
    const where: FindOptionsWhere<AuditEvent> = {};
    if (filter.objectType) where.objectType = filter.objectType;
    if (filter.objectId) where.objectId = filter.objectId;
    if (filter.actor) where.actor = filter.actor;
    return this.repo.find({ where, order: { at: 'DESC' }, take: Math.min(filter.limit ?? 100, 1000) });
  }
}
