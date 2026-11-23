import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum ProviderKind {
  INTERNAL = 'INTERNAL',
  EXTERNAL = 'EXTERNAL',
}

export enum ProviderStatus {
  OPERATIONAL = 'OPERATIONAL',
  MAINTENANCE = 'MAINTENANCE',
  DISABLED = 'DISABLED',
}

/** Système qui rend réellement le service (ex. « Plateforme 1 »). */
@Entity('providers')
export class Provider {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  name: string;

  @Column({ type: 'varchar', length: 20, default: ProviderKind.INTERNAL })
  kind: ProviderKind;

  /** URL de base de production, ex. https://plateforme1.interne:8443 */
  @Column({ type: 'varchar', length: 300 })
  baseUrl: string;

  /** URL de base de sandbox (simulateur), facultative. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  sandboxBaseUrl: string | null;

  @Column({ type: 'int', default: 5000 })
  timeoutMs: number;

  @Column({ type: 'int', default: 1 })
  retries: number;

  @Column({ type: 'varchar', length: 20, default: ProviderStatus.OPERATIONAL })
  status: ProviderStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
