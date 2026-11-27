import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum OveragePolicy {
  BLOCK = 'BLOCK', // 429 au-delà du quota
  ALLOW_AND_BILL = 'ALLOW_AND_BILL',
  ALERT_ONLY = 'ALERT_ONLY',
}

export enum ApprovalMode {
  MANUAL = 'MANUAL',
  AUTOMATIC = 'AUTOMATIC',
}

@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 80, unique: true })
  name: string;

  /** Quota journalier par abonnement, dans l'unité du service. */
  @Column({ type: 'int' })
  dailyQuota: number;

  @Column({ type: 'int', nullable: true })
  monthlyQuota: number | null;

  /** Débit maximum en requêtes par seconde. */
  @Column({ type: 'int' })
  rateLimitPerSecond: number;

  @Column({ type: 'varchar', length: 20, default: OveragePolicy.BLOCK })
  overagePolicy: OveragePolicy;

  @Column({ type: 'varchar', length: 20, default: ApprovalMode.MANUAL })
  approval: ApprovalMode;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  /** Tarif (millimes) : abonnement mensuel par service souscrit en production. */
  @Column({ type: 'int', default: 0 })
  monthlyFee: number;

  /** Tarif (millimes) : prix par appel facturable. */
  @Column({ type: 'int', default: 0 })
  pricePerCall: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
