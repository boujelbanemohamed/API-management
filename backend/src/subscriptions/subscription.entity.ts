import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum SubscriptionStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  EXPIRED = 'EXPIRED',
  REJECTED = 'REJECTED',
  TERMINATED = 'TERMINATED',
}

export enum Environment {
  SANDBOX = 'SANDBOX',
  PRODUCTION = 'PRODUCTION',
}

@Entity('subscriptions')
@Index(['partnerId', 'apiId', 'environment'])
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  partnerId: string;

  @Column({ type: 'varchar', length: 36 })
  apiId: string;

  @Column({ type: 'varchar', length: 36 })
  planId: string;

  @Column({ type: 'varchar', length: 20, default: Environment.PRODUCTION })
  environment: Environment;

  /** AAAA-MM-JJ, inclus. */
  @Column({ type: 'varchar', length: 10 })
  startDate: string;

  /** AAAA-MM-JJ, inclus. */
  @Column({ type: 'varchar', length: 10 })
  endDate: string;

  /** Remplace le quota journalier du plan lorsqu'il est renseigné. */
  @Column({ type: 'int', nullable: true })
  customDailyQuota: number | null;

  @Column({ type: 'varchar', length: 20, default: SubscriptionStatus.PENDING })
  status: SubscriptionStatus;

  /** Changement de plan programmé (date d'effet future). */
  @Column({ type: 'varchar', length: 36, nullable: true })
  scheduledPlanId: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  scheduledPlanFrom: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  contractReference: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
