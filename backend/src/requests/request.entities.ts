import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { RequestStatus, RequestType } from './request-rules';

@Entity('service_requests')
@Index(['partnerId', 'status'])
export class ServiceRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  partnerId: string;

  @Column({ type: 'varchar', length: 20 })
  type: RequestType;

  @Column({ type: 'varchar', length: 200 })
  subject: string;

  /** Contexte prérempli (carte masquée, GAB, commerçant, service…). Jamais de numéro de carte complet. */
  @Column({ type: 'simple-json', nullable: true })
  context: Record<string, string> | null;

  @Column({ type: 'varchar', length: 30, default: RequestStatus.NEW })
  status: RequestStatus;

  @Column({ type: 'varchar', length: 30 })
  team: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  assignee: string | null;

  /** Opération sensible : double validation exigée (F-DEM-06). */
  @Column({ type: 'boolean', default: false })
  sensitive: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  preparedBy: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  validatedBy: string | null;

  @Column({ type: 'varchar', length: 10 })
  openedOn: string;

  @Column({ type: 'int' })
  slaDays: number;

  @Column({ type: 'int', default: 0 })
  suspendedWorkingDays: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  suspendedSince: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  doneOn: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  rejectionReason: string | null;

  /** Système qui traite la demande (COCKPIT) quand elle est acheminée automatiquement. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  routedTo: string | null;

  /** Dernier niveau d'alerte de délai notifié (ALERT, BREACH). */
  @Column({ type: 'varchar', length: 10, nullable: true })
  alertLevel: string | null;

  /** Dernier message du système traitant (ex. information demandée par le Cockpit). */
  @Column({ type: 'varchar', length: 300, nullable: true })
  externalMessage: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/** Fêtes à date variable (Aïd, Mouled…) saisies chaque année. */
@Entity('holidays')
export class Holiday {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  date: string;

  @Column({ type: 'varchar', length: 120 })
  label: string;
}

/** Engagement de service par type de demande (écran « Engagements », F-DEM-08). */
@Entity('service_commitments')
export class ServiceCommitment {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  type: RequestType;

  @Column({ type: 'varchar', length: 30 })
  team: string;

  @Column({ type: 'int' })
  slaDays: number;
}
