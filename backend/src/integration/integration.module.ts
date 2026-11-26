import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';
import { BusMessage, MESSAGE_BUS, MessageBus } from './message-bus';
import { backoffMs, InboxMessage, MAX_ATTEMPTS, OutboxMessage } from './outbox';
import { APP_CONFIG, AppConfig } from '../config';

/** Publie les messages de l'outbox sur le bus, avec reprise et délai croissant. */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectRepository(OutboxMessage) private readonly repo: Repository<OutboxMessage>,
    @Inject(MESSAGE_BUS) private readonly bus: MessageBus,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const ms = this.config.integration?.relayIntervalMs ?? 1000;
    if (ms > 0 && process.env.DISABLE_JOBS !== 'true') this.timer = setInterval(() => void this.flush(), ms);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.bus.close();
  }

  /** Publie les messages dus ; renvoie le nombre publié. */
  async flush(now = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let published = 0;
    try {
      const due = await this.repo.find({
        where: { status: 'PENDING', nextAttemptAt: LessThanOrEqual(now) },
        order: { createdAt: 'ASC' },
        take: 100,
      });
      for (const m of due) {
        try {
          await this.bus.publish(m.topic, m.payload, m.id);
          m.status = 'PUBLISHED';
          m.publishedAt = now;
          m.lastError = null;
          published++;
        } catch (e) {
          m.attempts += 1;
          m.lastError = String((e as Error).message).slice(0, 300);
          m.nextAttemptAt = now + backoffMs(m.attempts);
          if (m.attempts >= MAX_ATTEMPTS) {
            m.status = 'FAILED';
            this.logger.error(`Message ${m.id} (${m.topic}) abandonné après ${m.attempts} essais : ${m.lastError}`);
          }
        }
        await this.repo.save(m);
      }
    } finally {
      this.running = false;
    }
    return published;
  }

  /** État de l'outbox, pour la supervision. */
  async stats() {
    const rows = await this.repo
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('o.status')
      .getRawMany<{ status: string; count: string }>();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }

  async pending(): Promise<OutboxMessage[]> {
    return this.repo.find({ where: { status: In(['PENDING', 'FAILED']) }, order: { createdAt: 'ASC' } });
  }
}

/** Réception idempotente : le traitement et la mémoire du message se font dans la même transaction. */
@Injectable()
export class Inbox {
  private readonly logger = new Logger('Inbox');
  constructor(
    private readonly db: DataSource,
    @Inject(MESSAGE_BUS) private readonly bus: MessageBus,
  ) {}

  async consume(queue: string, topics: string[], handler: (msg: BusMessage, db: DataSource['manager']) => Promise<void>) {
    if (process.env.DISABLE_CONSUMERS === 'true') return;
    await this.bus
      .subscribe(queue, topics, async (msg) => {
        if (!msg.id) throw new Error('message sans identifiant');
        await this.db.transaction(async (manager) => {
          const seen = await manager.findOne(InboxMessage, { where: { id: msg.id } });
          if (seen) {
            this.logger.warn(`Message ${msg.id} déjà traité : ignoré`);
            return;
          }
          await manager.save(manager.create(InboxMessage, { id: msg.id, topic: msg.topic }));
          await handler(msg, manager);
        });
      })
      .catch((e) => this.logger.error(`Abonnement ${queue} impossible : ${(e as Error).message}`));
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxMessage, InboxMessage])],
  providers: [OutboxRelay, Inbox],
  exports: [OutboxRelay, Inbox],
})
export class IntegrationModule {}
