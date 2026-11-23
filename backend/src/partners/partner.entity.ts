import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum PartnerStatus {
  PENDING = 'PENDING', // En validation
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  TERMINATED = 'TERMINATED', // Résilié
}

export enum PartnerType {
  BANK = 'BANK',
  PAYMENT_INSTITUTION = 'PAYMENT_INSTITUTION',
  MICROFINANCE = 'MICROFINANCE',
  OTHER = 'OTHER',
}

@Entity('partners')
export class Partner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Code unique, sert aussi de nom de consumer dans APISIX (lettres, chiffres, _). */
  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 30, default: PartnerType.BANK })
  type: PartnerType;

  @Column({ type: 'varchar', length: 40, nullable: true })
  taxId: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  technicalContactEmail: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  billingContactEmail: string | null;

  @Column({ type: 'varchar', length: 20, default: PartnerStatus.PENDING })
  status: PartnerStatus;

  /** Empreinte SHA-256 de la clé d'API (la clé en clair n'est jamais stockée). */
  @Column({ type: 'varchar', length: 64, nullable: true })
  apiKeyHash: string | null;

  /** Date de création de la clé d'API en cours (rotation). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  apiKeyCreatedAt: string | null;

  /** Adresses IP ou plages CIDR autorisées. Vide = pas de restriction (sandbox uniquement). */
  @Column({ type: 'simple-json', default: '[]' })
  allowedIps: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
