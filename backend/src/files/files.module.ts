import { Body, Controller, Get, HttpException, HttpStatus, Inject, Injectable, Module, NotFoundException, Param, Post, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { IsBase64, IsIn, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { FILE_STORE, FileStore, ScannerUnavailable, StoreUnavailable, VIRUS_SCANNER, VirusScanner } from './storage';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AnyConsoleUser, BankContext, ConsoleGuard, PortalGuard, Section } from '../auth/guards';
import { Actor } from '../common/actor.decorator';
import { Bank } from '../portal/bank.decorator';
import { ServiceRequest } from '../requests/request.entities';
import { Dispute } from '../disputes/dispute.entities';
import { Onboarding } from '../onboarding/onboarding.entities';
import { Partner } from '../partners/partner.entity';

export type OwnerType = 'REQUEST' | 'DISPUTE' | 'ONBOARDING' | 'LIBRARY';
export const OWNER_TYPES: OwnerType[] = ['REQUEST', 'DISPUTE', 'ONBOARDING', 'LIBRARY'];

/** Types de fichiers acceptés : documents et images courants, rien d'exécutable. */
export const ALLOWED_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
export const MAX_BYTES = 3 * 1024 * 1024;

@Entity('stored_files')
@Index(['ownerType', 'ownerId'])
export class StoredFile {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 12 }) ownerType: OwnerType;
  @Column({ type: 'varchar', length: 36 }) ownerId: string;
  /** Banque propriétaire (null : document SMT, par exemple de la bibliothèque). */
  @Column({ type: 'varchar', length: 36, nullable: true }) partnerId: string | null;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 120 }) mime: string;
  @Column({ type: 'int' }) size: number;
  @Column({ type: 'varchar', length: 64 }) sha256: string;
  @Column({ type: 'varchar', length: 200 }) storageKey: string;
  @Column({ type: 'varchar', length: 120 }) uploadedBy: string;
  @CreateDateColumn() createdAt: Date;
}

export class UploadDto {
  @IsIn(OWNER_TYPES) ownerType: OwnerType;
  @IsUUID() ownerId: string;
  @IsString() @MaxLength(200) @Matches(/^[^\\/:*?"<>|\x00-\x1f]+$/, { message: 'nom de fichier invalide' }) name: string;
  @IsIn(Object.keys(ALLOWED_MIME), { message: 'type de fichier non accepté (PDF, PNG, JPEG, TXT, CSV, DOCX, XLSX)' }) mime: string;
  @IsBase64() content: string;
}

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(StoredFile) private readonly repo: Repository<StoredFile>,
    @InjectRepository(ServiceRequest) private readonly requests: Repository<ServiceRequest>,
    @InjectRepository(Dispute) private readonly disputes: Repository<Dispute>,
    @InjectRepository(Onboarding) private readonly onboardings: Repository<Onboarding>,
    @Inject(FILE_STORE) private readonly store: FileStore,
    @Inject(VIRUS_SCANNER) private readonly scanner: VirusScanner,
    private readonly audit: AuditService,
  ) {}

  /** Banques autorisées à voir les fichiers d'un objet (null : toutes, contrôle fait ailleurs, ex. bibliothèque). */
  async partiesOf(ownerType: OwnerType, ownerId: string): Promise<string[] | null> {
    if (ownerType === 'REQUEST') return [(await this.find(this.requests, ownerId)).partnerId];
    if (ownerType === 'ONBOARDING') return [(await this.find(this.onboardings, ownerId)).partnerId];
    if (ownerType === 'DISPUTE') {
      const d = await this.find(this.disputes, ownerId);
      return [d.issuerId, d.acquirerId];
    }
    return null;
  }

  private async find<T extends { partnerId?: string }>(repo: Repository<any>, id: string): Promise<any> {
    const x = await repo.findOne({ where: { id } });
    if (!x) throw new NotFoundException('Introuvable');
    return x;
  }

  /** Analyse antivirus puis stockage ; un fichier infecté ou non analysable n'est jamais conservé. */
  async upload(dto: UploadDto, actor: string, bank?: BankContext): Promise<StoredFile> {
    const parties = await this.partiesOf(dto.ownerType, dto.ownerId);
    if (bank) {
      if (dto.ownerType === 'LIBRARY' || !parties?.includes(bank.partnerId)) throw new NotFoundException('Introuvable');
    }
    const content = Buffer.from(dto.content, 'base64');
    if (content.length === 0) throw new BusinessRuleError('FILE_EMPTY', 'Le fichier est vide.');
    if (content.length > MAX_BYTES) throw new BusinessRuleError('FILE_TOO_LARGE', 'Fichier trop volumineux (3 Mo au maximum).');
    let verdict;
    try {
      verdict = await this.scanner.scan(content);
    } catch (e) {
      if (e instanceof ScannerUnavailable) throw new HttpException({ code: 'FILE_SCAN_UNAVAILABLE', message: 'L’antivirus est momentanément indisponible : le fichier n’a pas été enregistré. Réessayez plus tard.' }, HttpStatus.SERVICE_UNAVAILABLE);
      throw e;
    }
    if (!verdict.clean) {
      await this.audit.record({ actor, action: 'file.infected', objectType: dto.ownerType.toLowerCase(), objectId: dto.ownerId, details: { name: dto.name, signature: verdict.signature } });
      throw new BusinessRuleError('FILE_INFECTED', `Fichier refusé : l’antivirus a détecté une menace (${verdict.signature}).`);
    }
    const id = randomUUID();
    const storageKey = `${dto.ownerType.toLowerCase()}/${dto.ownerId}/${id}.${ALLOWED_MIME[dto.mime]}`;
    try {
      await this.store.put(storageKey, content, dto.mime);
    } catch (e) {
      if (e instanceof StoreUnavailable) throw new HttpException({ code: 'FILE_STORE_UNAVAILABLE', message: 'Le stockage des fichiers est momentanément indisponible.' }, HttpStatus.SERVICE_UNAVAILABLE);
      throw e;
    }
    const partnerId = bank?.partnerId ?? (dto.ownerType === 'REQUEST' || dto.ownerType === 'ONBOARDING' ? parties![0] : null);
    const file = await this.repo.save(
      this.repo.create({ id, ownerType: dto.ownerType, ownerId: dto.ownerId, partnerId, name: dto.name, mime: dto.mime, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), storageKey, uploadedBy: actor }),
    );
    await this.audit.record({ actor, action: 'file.upload', objectType: dto.ownerType.toLowerCase(), objectId: dto.ownerId, details: { fileId: id, name: dto.name, size: content.length } });
    return file;
  }

  async list(ownerType: OwnerType, ownerId: string, bank?: BankContext) {
    if (bank) await this.assertCanSee(ownerType, ownerId, bank);
    return this.repo.find({ where: { ownerType, ownerId }, order: { createdAt: 'ASC' } });
  }

  async meta(id: string) {
    const f = await this.repo.findOne({ where: { id } });
    if (!f) throw new NotFoundException('Introuvable');
    return f;
  }

  async assertCanSee(ownerType: OwnerType, ownerId: string, bank: BankContext, libraryCheck?: (contentId: string) => Promise<boolean>) {
    if (ownerType === 'LIBRARY') {
      if (!libraryCheck || !(await libraryCheck(ownerId))) throw new NotFoundException('Introuvable');
      return;
    }
    const parties = await this.partiesOf(ownerType, ownerId);
    if (!parties?.includes(bank.partnerId)) throw new NotFoundException('Introuvable');
  }

  async content(f: StoredFile): Promise<Buffer> {
    try {
      return await this.store.get(f.storageKey);
    } catch {
      throw new HttpException({ code: 'FILE_STORE_UNAVAILABLE', message: 'Le stockage des fichiers est momentanément indisponible.' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  /** Vérifie qu'un justificatif cité appartient bien à l'objet (ex. pièce d'un litige). */
  async assertBelongs(fileId: string, ownerType: OwnerType, ownerId: string) {
    const f = await this.repo.findOne({ where: { id: fileId } });
    if (!f || f.ownerType !== ownerType || f.ownerId !== ownerId) {
      throw new BusinessRuleError('DOCUMENT_UNKNOWN', 'Le justificatif cité n’est pas une pièce de ce dossier.');
    }
  }
}

/** Téléchargement : toujours en pièce jointe, avec le type déclaré et sans interprétation par le navigateur. */
function download(res: any, f: StoredFile, content: Buffer) {
  res.set({
    'Content-Type': f.mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  return new StreamableFile(content);
}

@Controller('files')
@UseGuards(ConsoleGuard)
export class ConsoleFilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @Section('demandes')
  upload(@Body() dto: UploadDto, @Actor() actor: string) {
    return this.files.upload(dto, actor);
  }

  @Get()
  @AnyConsoleUser()
  list(@Query('ownerType') ownerType: OwnerType, @Query('ownerId') ownerId: string) {
    if (!OWNER_TYPES.includes(ownerType) || !ownerId) throw new NotFoundException('Introuvable');
    return this.files.list(ownerType, ownerId);
  }

  @Get(':id/content')
  @AnyConsoleUser()
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: any) {
    const f = await this.files.meta(id);
    return download(res, f, await this.files.content(f));
  }
}

@Controller('portal/files')
@UseGuards(PortalGuard)
export class PortalFilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  upload(@Bank() bank: BankContext, @Body() dto: UploadDto) {
    return this.files.upload(dto, bank.actor, bank);
  }

  @Get()
  list(@Bank() bank: BankContext, @Query('ownerType') ownerType: OwnerType, @Query('ownerId') ownerId: string) {
    if (!OWNER_TYPES.includes(ownerType) || ownerType === 'LIBRARY' || !ownerId) throw new NotFoundException('Introuvable');
    return this.files.list(ownerType, ownerId, bank);
  }

  @Get(':id/content')
  async get(@Bank() bank: BankContext, @Param('id') id: string, @Res({ passthrough: true }) res: any) {
    const f = await this.files.meta(id).catch(() => null);
    if (!f || f.ownerType === 'LIBRARY') throw new NotFoundException('Introuvable');
    await this.files.assertCanSee(f.ownerType, f.ownerId, bank);
    return download(res, f, await this.files.content(f));
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([StoredFile, ServiceRequest, Dispute, Onboarding, Partner]), AuditModule],
  providers: [FilesService],
  controllers: [ConsoleFilesController, PortalFilesController],
  exports: [FilesService],
})
export class FilesModule {}

export { download as fileDownload };
