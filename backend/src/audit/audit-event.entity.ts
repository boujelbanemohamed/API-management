import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Événement d'audit : jamais modifié ni supprimé par l'application. */
@Entity('audit_events')
@Index(['objectType', 'objectId'])
export class AuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  actor: string;

  /** ADMIN, PARTNER ou SYSTEM */
  @Column({ type: 'varchar', length: 20 })
  origin: string;

  @Column({ type: 'varchar', length: 80 })
  action: string;

  @Column({ type: 'varchar', length: 40 })
  objectType: string;

  @Column({ type: 'varchar', length: 36 })
  objectId: string;

  @Column({ type: 'simple-json', nullable: true })
  details: Record<string, unknown> | null;

  /** Horodatage ISO 8601 à la milliseconde (tri chronologique fiable, quelle que soit la base). */
  @Index()
  @Column({ type: 'varchar', length: 30 })
  at: string;
}
