import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Repository, Unique, UpdateDateColumn } from 'typeorm';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { BankContext, ConsoleGuard, PortalGuard, Section } from '../auth/guards';
import { Bank } from '../portal/bank.decorator';
import { Actor } from '../common/actor.decorator';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { FilesModule, FilesService, fileDownload, StoredFile } from '../files/files.module';
import { NotificationsService } from '../notifications/notifications.module';
import { Partner } from '../partners/partner.entity';

/** Contenus publiés par SMT (spécifications §13, F-CON-01 et F-CON-02). */
export type ContentKind = 'COMMUNIQUE' | 'EVENEMENT' | 'ENQUETE' | 'DOCUMENT';
export type ContentStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface SurveyQuestion { id: string; label: string; type: 'choice' | 'text'; options?: string[] }

@Entity('contents')
@Index(['kind', 'status'])
export class Content {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 12 }) kind: ContentKind;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'text', default: '' }) body: string;
  /** Communiqué important : affiché sur l'accueil du portail. */
  @Column({ type: 'boolean', default: false }) important: boolean;
  /** Toutes les banques, ou une sélection. */
  @Column({ type: 'varchar', length: 10, default: 'ALL' }) audience: 'ALL' | 'SELECTED';
  @Column({ type: 'simple-json', nullable: true }) partnerIds: string[] | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) eventDate: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) location: string | null;
  /** Bibliothèque : rubrique (procédures, spécifications, contrats types…). */
  @Column({ type: 'varchar', length: 60, nullable: true }) category: string | null;
  /** Bibliothèque : version courante (incrémentée à chaque nouveau fichier). */
  @Column({ type: 'int', default: 0 }) version: number;
  @Column({ type: 'simple-json', nullable: true }) questions: SurveyQuestion[] | null;
  @Column({ type: 'varchar', length: 10, default: 'DRAFT' }) status: ContentStatus;
  @Column({ type: 'varchar', length: 30, nullable: true }) publishedAt: string | null;
  @Column({ type: 'varchar', length: 120 }) createdBy: string;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

@Entity('survey_responses')
@Unique(['contentId', 'partnerId', 'username'])
export class SurveyResponse {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36 }) contentId: string;
  @Column({ type: 'varchar', length: 36 }) partnerId: string;
  @Column({ type: 'varchar', length: 120 }) username: string;
  @Column({ type: 'simple-json' }) answers: Record<string, string>;
  @CreateDateColumn() createdAt: Date;
}

class QuestionDto {
  @Matches(/^[a-z0-9_-]{1,30}$/) id: string;
  @IsString() @MaxLength(200) label: string;
  @IsIn(['choice', 'text']) type: 'choice' | 'text';
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) options?: string[];
}

export class ContentDto {
  @IsIn(['COMMUNIQUE', 'EVENEMENT', 'ENQUETE', 'DOCUMENT']) kind: ContentKind;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsBoolean() important?: boolean;
  @IsOptional() @IsIn(['ALL', 'SELECTED']) audience?: 'ALL' | 'SELECTED';
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) partnerIds?: string[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) eventDate?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => QuestionDto) questions?: QuestionDto[];
}

export class UpdateContentDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsBoolean() important?: boolean;
  @IsOptional() @IsIn(['ALL', 'SELECTED']) audience?: 'ALL' | 'SELECTED';
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) partnerIds?: string[];
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) eventDate?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
}

export class AnswerDto {
  @IsObject() answers: Record<string, string>;
}

@Injectable()
export class ContentsService {
  constructor(
    @InjectRepository(Content) private readonly repo: Repository<Content>,
    @InjectRepository(SurveyResponse) private readonly responses: Repository<SurveyResponse>,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: ContentDto, actor: string) {
    if (dto.kind === 'ENQUETE' && !dto.questions?.length) throw new BusinessRuleError('SURVEY_EMPTY', 'Une enquête doit contenir au moins une question.');
    if (dto.audience === 'SELECTED' && !dto.partnerIds?.length) throw new BusinessRuleError('AUDIENCE_EMPTY', 'Choisissez au moins une banque.');
    const c = await this.repo.save(this.repo.create({ ...dto, body: dto.body ?? '', questions: dto.questions ?? null, partnerIds: dto.partnerIds ?? null, createdBy: actor, status: 'DRAFT' }));
    await this.audit.record({ actor, action: 'content.create', objectType: 'content', objectId: c.id, details: { kind: c.kind, title: c.title } });
    return c;
  }

  async update(id: string, dto: UpdateContentDto, actor: string) {
    const c = await this.get(id);
    Object.assign(c, dto);
    const saved = await this.repo.save(c);
    await this.audit.record({ actor, action: 'content.update', objectType: 'content', objectId: id, details: { ...dto } });
    return saved;
  }

  async get(id: string) {
    const c = await this.repo.findOne({ where: { id } });
    if (!c) throw new NotFoundException('Introuvable');
    return c;
  }

  list(kind?: ContentKind) {
    return this.repo.find({ where: kind ? { kind } : {}, order: { createdAt: 'DESC' } });
  }

  /** Publication : notifie les banques concernées. Un document doit avoir son fichier. */
  async publish(id: string, actor: string) {
    const c = await this.get(id);
    if (c.kind === 'DOCUMENT' && c.version === 0) throw new BusinessRuleError('DOCUMENT_WITHOUT_FILE', 'Joignez le fichier du document avant de le publier.');
    c.status = 'PUBLISHED';
    c.publishedAt = new Date().toISOString();
    await this.repo.save(c);
    const targets = c.audience === 'SELECTED' ? (c.partnerIds ?? []) : (await this.partners.find()).filter((p) => p.status === 'ACTIVE').map((p) => p.id);
    const label = { COMMUNIQUE: 'Nouveau communiqué', EVENEMENT: 'Nouvel événement', ENQUETE: 'Nouvelle enquête', DOCUMENT: 'Nouveau document' }[c.kind];
    const link = c.kind === 'DOCUMENT' ? '/bibliotheque' : `/contenus/${c.id}`;
    for (const p of targets) await this.notifications.toBank(p, label, c.title, link);
    await this.audit.record({ actor, action: 'content.publish', objectType: 'content', objectId: id, details: { audience: targets.length } });
    return c;
  }

  async archive(id: string, actor: string) {
    const c = await this.get(id);
    c.status = 'ARCHIVED';
    await this.audit.record({ actor, action: 'content.archive', objectType: 'content', objectId: id, details: {} });
    return this.repo.save(c);
  }

  /** Nouveau fichier d'un document de la bibliothèque : nouvelle version. */
  async attach(id: string, file: { name: string; mime: string; content: string }, actor: string) {
    const c = await this.get(id);
    if (c.kind !== 'DOCUMENT') throw new BusinessRuleError('NOT_A_DOCUMENT', 'Seuls les documents de la bibliothèque ont un fichier.');
    const f = await this.files.upload({ ownerType: 'LIBRARY', ownerId: id, ...file }, actor);
    c.version += 1;
    await this.repo.save(c);
    return { ...c, file: f };
  }

  visibleTo(c: Content, partnerId: string) {
    return c.status === 'PUBLISHED' && (c.audience === 'ALL' || (c.partnerIds ?? []).includes(partnerId));
  }

  async forBank(bank: BankContext, kind?: ContentKind) {
    const all = await this.repo.find({ where: { status: 'PUBLISHED', ...(kind ? { kind } : {}) }, order: { publishedAt: 'DESC' } });
    const visible = all.filter((c) => this.visibleTo(c, bank.partnerId));
    const answered = new Set((await this.responses.find({ where: { partnerId: bank.partnerId, username: bank.username } })).map((r) => r.contentId));
    return visible.map(({ partnerIds: _p, createdBy: _c, ...c }) => ({ ...c, answered: answered.has(c.id) }));
  }

  async oneForBank(id: string, bank: BankContext) {
    const c = await this.get(id);
    if (!this.visibleTo(c, bank.partnerId)) throw new NotFoundException('Introuvable');
    const { partnerIds: _p, createdBy: _c, ...rest } = c;
    const files = c.kind === 'DOCUMENT' ? (await this.files.list('LIBRARY', id)).map(({ id: fid, name, mime, size, createdAt }) => ({ id: fid, name, mime, size, createdAt })) : [];
    return { ...rest, files };
  }

  async answer(id: string, dto: AnswerDto, bank: BankContext) {
    const c = await this.get(id);
    if (!this.visibleTo(c, bank.partnerId) || c.kind !== 'ENQUETE') throw new NotFoundException('Introuvable');
    const questions = c.questions ?? [];
    for (const q of questions) {
      const a = dto.answers[q.id];
      if (a === undefined || String(a).trim() === '') throw new BusinessRuleError('ANSWER_MISSING', `Réponse manquante : « ${q.label} ».`);
      if (q.type === 'choice' && !(q.options ?? []).includes(a)) throw new BusinessRuleError('ANSWER_INVALID', `Réponse non proposée pour « ${q.label} ».`);
    }
    const unknown = Object.keys(dto.answers).filter((k) => !questions.some((q) => q.id === k));
    if (unknown.length) throw new BusinessRuleError('ANSWER_INVALID', 'Réponse à une question inconnue.');
    const exists = await this.responses.findOne({ where: { contentId: id, partnerId: bank.partnerId, username: bank.username } });
    if (exists) throw new BusinessRuleError('ALREADY_ANSWERED', 'Vous avez déjà répondu à cette enquête.');
    const answers = Object.fromEntries(questions.map((q) => [q.id, String(dto.answers[q.id]).slice(0, 1000)]));
    return this.responses.save(this.responses.create({ contentId: id, partnerId: bank.partnerId, username: bank.username, answers }));
  }

  /** Résultats d'une enquête : décompte par option, réponses libres avec la banque. */
  async results(id: string) {
    const c = await this.get(id);
    const rs = await this.responses.find({ where: { contentId: id } });
    const partners = new Map((await this.partners.find()).map((p) => [p.id, p.code]));
    return {
      total: rs.length,
      questions: (c.questions ?? []).map((q) => ({
        ...q,
        counts: q.type === 'choice' ? Object.fromEntries((q.options ?? []).map((o) => [o, rs.filter((r) => r.answers[q.id] === o).length])) : undefined,
        texts: q.type === 'text' ? rs.map((r) => ({ bank: partners.get(r.partnerId) ?? '?', text: r.answers[q.id] })) : undefined,
      })),
    };
  }

  async libraryFile(fileId: string, bank: BankContext): Promise<StoredFile> {
    const f = await this.files.meta(fileId).catch(() => null);
    if (!f || f.ownerType !== 'LIBRARY') throw new NotFoundException('Introuvable');
    await this.files.assertCanSee('LIBRARY', f.ownerId, bank, async (contentId) => this.visibleTo(await this.get(contentId), bank.partnerId));
    return f;
  }

  fileContent(f: StoredFile) {
    return this.files.content(f);
  }

  /** Recherche plein texte simple (assistant IA, recherche du portail). */
  async search(bank: BankContext | null, words: string[], limit = 5) {
    const all = await this.repo.find({ where: { status: 'PUBLISHED' } });
    const visible = bank ? all.filter((c) => this.visibleTo(c, bank.partnerId)) : all;
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const ws = words.map(norm).filter((w) => w.length >= 3);
    return visible
      .map((c) => ({ c, score: ws.reduce((s, w) => s + (norm(c.title).includes(w) ? 3 : 0) + (norm(c.body).split(w).length - 1), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.c);
  }
}

@Controller('contents')
@UseGuards(ConsoleGuard)
@Section('administration')
export class ConsoleContentsController {
  constructor(private readonly s: ContentsService) {}
  @Get() list(@Query('kind') kind?: ContentKind) {
    return this.s.list(kind);
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.s.get(id);
  }
  @Post() create(@Body() dto: ContentDto, @Actor() actor: string) {
    return this.s.create(dto, actor);
  }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateContentDto, @Actor() actor: string) {
    return this.s.update(id, dto, actor);
  }
  @Post(':id/publish') @HttpCode(200) publish(@Param('id') id: string, @Actor() actor: string) {
    return this.s.publish(id, actor);
  }
  @Post(':id/archive') @HttpCode(200) archive(@Param('id') id: string, @Actor() actor: string) {
    return this.s.archive(id, actor);
  }
  @Post(':id/file') attach(@Param('id') id: string, @Body() body: { name: string; mime: string; content: string }, @Actor() actor: string) {
    return this.s.attach(id, body, actor);
  }
  @Get(':id/results') results(@Param('id') id: string) {
    return this.s.results(id);
  }
}

@Controller('portal/contents')
@UseGuards(PortalGuard)
export class PortalContentsController {
  constructor(private readonly s: ContentsService) {}
  @Get() list(@Bank() bank: BankContext, @Query('kind') kind?: ContentKind) {
    return this.s.forBank(bank, kind && ['COMMUNIQUE', 'EVENEMENT', 'ENQUETE', 'DOCUMENT'].includes(kind) ? kind : undefined);
  }
  @Get('files/:fileId') async file(@Bank() bank: BankContext, @Param('fileId') fileId: string, @Res({ passthrough: true }) res: any) {
    const f = await this.s.libraryFile(fileId, bank);
    return fileDownload(res, f, await this.s.fileContent(f));
  }
  @Get(':id') get(@Bank() bank: BankContext, @Param('id') id: string) {
    return this.s.oneForBank(id, bank);
  }
  @Post(':id/responses') answer(@Bank() bank: BankContext, @Param('id') id: string, @Body() dto: AnswerDto) {
    return this.s.answer(id, dto, bank);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Content, SurveyResponse, Partner]), AuditModule, FilesModule],
  providers: [ContentsService],
  controllers: [ConsoleContentsController, PortalContentsController],
  exports: [ContentsService],
})
export class ContentsModule {}

