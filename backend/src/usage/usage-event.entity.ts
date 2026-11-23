import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Un appel passé par la passerelle. C'est la table qui fait foi pour la facturation
 * (les journaux techniques ne servent qu'au diagnostic).
 */
@Entity('usage_events')
@Index(['partnerCode', 'apiSlug', 'day'])
export class UsageEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Identifiant de requête posé par APISIX (plugin request-id) : garantit qu'un appel n'est compté qu'une fois. */
  @Column({ type: 'varchar', length: 80, unique: true })
  requestId: string;

  @Column({ type: 'varchar', length: 40 })
  partnerCode: string;

  @Column({ type: 'varchar', length: 60 })
  apiSlug: string;

  @Column({ type: 'int' })
  httpStatus: number;

  @Column({ type: 'int' })
  latencyMs: number;

  @Column({ type: 'boolean' })
  billable: boolean;

  /** Jour de l'appel (AAAA-MM-JJ, heure de Tunis). */
  @Column({ type: 'varchar', length: 10 })
  day: string;

  @Column({ type: 'varchar', length: 40 })
  occurredAt: string;

  @CreateDateColumn()
  receivedAt: Date;
}
