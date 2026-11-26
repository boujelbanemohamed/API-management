import { Column, CreateDateColumn, Entity, EntityManager, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Schéma « outbox » : le message est écrit dans la même transaction que l'action métier,
 * puis publié par le relais. Aucune action validée sans son message, aucun message sans action.
 */
@Entity('outbox_messages')
@Index(['status', 'nextAttemptAt'])
export class OutboxMessage {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 60 }) topic: string;
  @Column({ type: 'simple-json' }) payload: Record<string, unknown>;
  /** PENDING → PUBLISHED, ou FAILED après trop d'échecs (alerte d'exploitation). */
  @Column({ type: 'varchar', length: 12, default: 'PENDING' }) status: 'PENDING' | 'PUBLISHED' | 'FAILED';
  @Column({ type: 'int', default: 0 }) attempts: number;
  @Column({ type: 'bigint', default: 0 }) nextAttemptAt: number;
  @Column({ type: 'varchar', length: 300, nullable: true }) lastError: string | null;
  @CreateDateColumn() createdAt: Date;
  @Column({ type: 'bigint', nullable: true }) publishedAt: number | null;
}

/** Messages déjà traités (réception idempotente) : un message rejoué est ignoré. */
@Entity('inbox_messages')
export class InboxMessage {
  @PrimaryColumn({ type: 'varchar', length: 120 }) id: string;
  @Column({ type: 'varchar', length: 60 }) topic: string;
  @CreateDateColumn() processedAt: Date;
}

/** Ajoute un message à publier, dans la transaction de l'appelant. */
export function enqueue(manager: EntityManager, topic: string, payload: Record<string, unknown>): Promise<OutboxMessage> {
  return manager.save(manager.create(OutboxMessage, { topic, payload, status: 'PENDING', attempts: 0, nextAttemptAt: 0 }));
}

export const MAX_ATTEMPTS = 20;

/** Délai avant le prochain essai : 1 s, 2 s, 4 s… plafonné à 5 minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, attempts - 1));
}
