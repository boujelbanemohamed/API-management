import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OnboardingStep, TestCaseStatus, TestMode } from './onboarding-rules';

@Entity('onboardings')
@Index(['partnerId', 'apiId'])
export class Onboarding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  partnerId: string;

  @Column({ type: 'varchar', length: 36 })
  apiId: string;

  @Column({ type: 'varchar', length: 36 })
  planId: string;

  @Column({ type: 'varchar', length: 20, default: OnboardingStep.REQUEST })
  step: OnboardingStep;

  @Column({ type: 'boolean', default: false })
  cancelled: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  contractReference: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  contractValidatedBy: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  testMode: TestMode | null;

  @Column({ type: 'int', default: 0 })
  jointSessions: number;

  @Column({ type: 'varchar', length: 120, nullable: true })
  bankSignedBy: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  smtSignedBy: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  productionSubscriptionId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('onboarding_test_cases')
@Index(['onboardingId'])
export class OnboardingTestCase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  onboardingId: string;

  @Column({ type: 'varchar', length: 30 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'boolean', default: true })
  mandatory: boolean;

  @Column({ type: 'varchar', length: 20, default: TestCaseStatus.TODO })
  status: TestCaseStatus;

  /** Référence de la preuve : identifiant de trace d'appel ou pièce stockée. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  evidence: string | null;
}

/** Cahier de tests type d'un service : recopié dans chaque nouvelle mise en service (F-MES-09). */
@Entity('test_books')
export class TestBook {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  apiId: string;

  @Column({ type: 'simple-json' })
  cases: { code: string; title: string; mandatory: boolean }[];

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'varchar', length: 120 })
  updatedBy: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
