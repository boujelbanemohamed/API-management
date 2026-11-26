import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { DisputeStage } from './dispute-rules';

// ---------- Entités ----------

@Entity('disputes')
@Index(['issuerId', 'stage'])
@Index(['acquirerId', 'stage'])
export class Dispute {
  @PrimaryGeneratedColumn('uuid') id: string;
  /** Banque émettrice (porteur). */
  @Column({ type: 'varchar', length: 36 }) issuerId: string;
  /** Banque acquéreuse (commerçant). */
  @Column({ type: 'varchar', length: 36 }) acquirerId: string;
  @Column({ type: 'varchar', length: 40 }) transactionRef: string;
  /** Jamais de numéro complet : 6 premiers et 4 derniers chiffres. */
  @Column({ type: 'varchar', length: 19 }) maskedPan: string;
  @Column({ type: 'varchar', length: 10 }) transactionDate: string;
  /** Montant en millimes. */
  @Column({ type: 'int' }) transactionAmount: number;
  @Column({ type: 'varchar', length: 3, default: '788' }) currency: string;
  @Column({ type: 'varchar', length: 10 }) reasonCode: string;
  @Column({ type: 'varchar', length: 30, default: DisputeStage.OPENED }) stage: DisputeStage;
  @Column({ type: 'varchar', length: 10, nullable: true }) deadline: string | null;
  @Column({ type: 'int', nullable: true }) disputedAmount: number | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) winner: 'ISSUER' | 'ACQUIRER' | null;
  @Column({ type: 'int', nullable: true }) arbitrationFees: number | null;
  @CreateDateColumn() createdAt: Date;
}

@Entity('dispute_events')
@Index(['disputeId'])
export class DisputeEvent {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) disputeId: string;
  @Column({ type: 'varchar', length: 30 }) action: string;
  @Column({ type: 'varchar', length: 10 }) party: string;
  @Column({ type: 'varchar', length: 120 }) actor: string;
  @Column({ type: 'varchar', length: 10 }) occurredOn: string;
  @Column({ type: 'varchar', length: 30 }) toStage: string;
  @Column({ type: 'varchar', length: 4, nullable: true }) mti: string | null;
  @Column({ type: 'varchar', length: 3, nullable: true }) functionCode: string | null;
  @Column({ type: 'int', nullable: true }) amount: number | null;
  /** Référence de la pièce stockée (analysée par l'antivirus). */
  @Column({ type: 'varchar', length: 300, nullable: true }) documentRef: string | null;
  /** Acheminement du message ISO vers la plateforme Chargeback : PENDING, ACKED, REJECTED ou FAILED. */
  @Column({ type: 'varchar', length: 10, nullable: true }) deliveryStatus: 'PENDING' | 'ACKED' | 'REJECTED' | 'FAILED' | null;
  /** Code action ISO (champ 39) renvoyé par la plateforme. */
  @Column({ type: 'varchar', length: 3, nullable: true }) actionCode: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) deliveryDetail: string | null;
}

