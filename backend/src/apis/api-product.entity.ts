import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum ApiStatus {
  DRAFT = 'DRAFT', // visible des administrateurs uniquement
  BETA = 'BETA', // sandbox uniquement
  PUBLISHED = 'PUBLISHED',
  DEPRECATED = 'DEPRECATED', // les abonnements en cours continuent, plus de nouveaux
  RETIRED = 'RETIRED', // plus aucune route publiée
}

export enum SecurityLevel {
  TOKEN = 'TOKEN',
  TOKEN_MTLS = 'TOKEN_MTLS',
  TOKEN_MTLS_SIGNATURE = 'TOKEN_MTLS_SIGNATURE',
}

export enum BillingUnit {
  CALL = 'CALL',
  MESSAGE = 'MESSAGE',
  SUCCESSFUL_OPERATION = 'SUCCESSFUL_OPERATION',
  ITEM_CREATED = 'ITEM_CREATED',
  FLAT = 'FLAT',
}

/** Un service exposé aux institutions (une API versionnée). */
@Entity('api_products')
export class ApiProduct {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Identifiant technique unique, sert d'identifiant de route APISIX. Ex. transactions-v1 */
  @Column({ type: 'varchar', length: 60, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 20, default: 'v1' })
  version: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Chemin public exposé aux institutions, ex. /transactions/v1 */
  @Column({ type: 'varchar', length: 200, unique: true })
  publicPath: string;

  /** Chemin correspondant chez le fournisseur, ex. /api/transactions */
  @Column({ type: 'varchar', length: 200 })
  upstreamPath: string;

  @Column({ type: 'varchar', length: 36 })
  providerId: string;

  @Column({ type: 'varchar', length: 20, default: ApiStatus.DRAFT })
  status: ApiStatus;

  @Column({ type: 'varchar', length: 30, default: SecurityLevel.TOKEN_MTLS })
  securityLevel: SecurityLevel;

  @Column({ type: 'varchar', length: 30, default: BillingUnit.CALL })
  billingUnit: BillingUnit;

  /** Facturer aussi les appels en échec (par défaut : seulement les réussis). */
  @Column({ type: 'boolean', default: false })
  billFailedCalls: boolean;

  /** Champs à masquer dans les journaux (ex. pan, otp, idNumber). */
  @Column({ type: 'simple-json', default: '[]' })
  maskedFields: string[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
