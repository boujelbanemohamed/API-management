import { Controller, Get, Global, HttpCode, Inject, Injectable, Logger, Module, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Param, Post, Req, UseGuards } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Column, CreateDateColumn, Entity, EntityManager, Index, IsNull, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { AnyConsoleUser, BankContext, ConsoleGuard, PortalGuard } from '../auth/guards';
import { Bank } from '../portal/bank.decorator';
import { Identity } from '../auth/token-verifier';
import { Partner } from '../partners/partner.entity';

/**
 * Notifications in-app (cloche du portail et de la console).
 * Destinataire : une banque (tous ses utilisateurs) ou une équipe SMT.
 */
export type Team = 'OPERATIONS' | 'INTEGRATION' | 'SECURITY' | 'SUPPORT' | 'LITIGES' | 'ARBITRAGE' | 'FACTURATION';

@Entity('notifications')
@Index(['partnerId', 'readAt'])
@Index(['team', 'readAt'])
export class Notification {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar', length: 36, nullable: true }) partnerId: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true }) team: Team | null;
  @Column({ type: 'varchar', length: 160 }) title: string;
  @Column({ type: 'varchar', length: 400 }) body: string;
  /** Lien relatif dans l'application destinataire (ex. /demandes/…). */
  @Column({ type: 'varchar', length: 200, nullable: true }) link: string | null;
  @CreateDateColumn() createdAt: Date;
  @Column({ type: 'varchar', length: 30, nullable: true }) readAt: string | null;
}

/** Équipes SMT d'un utilisateur de la console, d'après ses rôles. */
const TEAM_OF_ROLE: Record<string, Team[]> = {
  'console-admin': ['OPERATIONS', 'INTEGRATION', 'SECURITY', 'SUPPORT', 'LITIGES', 'ARBITRAGE', 'FACTURATION'],
  'console-agent-operations': ['OPERATIONS'],
  'console-agent-integration': ['INTEGRATION'],
  'console-agent-securite': ['SECURITY'],
  'console-agent-support': ['SUPPORT'],
  'console-agent-litiges': ['LITIGES'],
  'console-arbitre': ['ARBITRAGE'],
  'console-facturation': ['FACTURATION'],
};
export function teamsOf(roles: string[]): Team[] {
  return [...new Set(roles.flatMap((r) => TEAM_OF_ROLE[r] ?? []))];
}

@Injectable()
export class NotificationsService {
  constructor(@InjectRepository(Notification) private readonly repo: Repository<Notification>) {}

  /** Notifie une banque ; `manager` : dans la transaction de l'action qui déclenche la notification. */
  toBank(partnerId: string, title: string, body: string, link?: string, manager?: EntityManager) {
    const m = manager ?? this.repo.manager;
    return m.save(m.create(Notification, { partnerId, team: null, title: title.slice(0, 160), body: body.slice(0, 400), link: link ?? null }));
  }

  toTeam(team: Team, title: string, body: string, link?: string, manager?: EntityManager) {
    const m = manager ?? this.repo.manager;
    return m.save(m.create(Notification, { partnerId: null, team, title: title.slice(0, 160), body: body.slice(0, 400), link: link ?? null }));
  }

  listForBank(partnerId: string) {
    return this.repo.find({ where: { partnerId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  async listForTeams(teams: Team[]) {
    if (teams.length === 0) return [];
    return this.repo.find({ where: teams.map((team) => ({ team })), order: { createdAt: 'DESC' }, take: 50 });
  }

  async markRead(id: string, owns: (n: Notification) => boolean) {
    const n = await this.repo.findOne({ where: { id } });
    if (!n || !owns(n)) throw new NotFoundException('Introuvable');
    if (!n.readAt) {
      n.readAt = new Date().toISOString();
      await this.repo.save(n);
    }
    return n;
  }

  async markAllRead(where: { partnerId?: string; teams?: Team[] }) {
    const now = new Date().toISOString();
    if (where.partnerId) await this.repo.update({ partnerId: where.partnerId, readAt: IsNull() }, { readAt: now });
    for (const team of where.teams ?? []) await this.repo.update({ team, readAt: IsNull() }, { readAt: now });
    return { ok: true };
  }
}

@Controller('portal/notifications')
@UseGuards(PortalGuard)
export class PortalNotificationsController {
  constructor(private readonly n: NotificationsService) {}
  @Get() list(@Bank() bank: BankContext) {
    return this.n.listForBank(bank.partnerId);
  }
  @Post('read-all') @HttpCode(200) readAll(@Bank() bank: BankContext) {
    return this.n.markAllRead({ partnerId: bank.partnerId });
  }
  @Post(':id/read') @HttpCode(200) read(@Bank() bank: BankContext, @Param('id') id: string) {
    return this.n.markRead(id, (x) => x.partnerId === bank.partnerId);
  }
}

@Controller('console/notifications')
@UseGuards(ConsoleGuard)
export class ConsoleNotificationsController {
  constructor(private readonly n: NotificationsService) {}
  private teams(req: { identity?: Identity }) {
    return teamsOf(req.identity?.roles ?? ['console-admin']);
  }
  @Get() @AnyConsoleUser() list(@Req() req: { identity?: Identity }) {
    return this.n.listForTeams(this.teams(req));
  }
  @Post('read-all') @HttpCode(200) @AnyConsoleUser() readAll(@Req() req: { identity?: Identity }) {
    return this.n.markAllRead({ teams: this.teams(req) });
  }
  @Post(':id/read') @HttpCode(200) @AnyConsoleUser() read(@Req() req: { identity?: Identity }, @Param('id') id: string) {
    const teams = this.teams(req);
    return this.n.markRead(id, (x) => !!x.team && teams.includes(x.team));
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Notification, Partner])],
  providers: [NotificationsService],
  controllers: [PortalNotificationsController, ConsoleNotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
