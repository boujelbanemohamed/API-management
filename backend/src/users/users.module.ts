import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Module, NotFoundException, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { BusinessRuleError } from '../subscriptions/subscription-rules';
import { BankContext, ConsoleGuard, OnlyRoles, PortalGuard, Section } from '../auth/guards';
import { BankRole, ConsoleRole } from '../auth/roles';
import { Bank } from '../portal/bank.decorator';
import { Identity } from '../auth/token-verifier';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { Partner } from '../partners/partner.entity';

/**
 * Gestion des accès (F-ROL-02) : l'administrateur sécurité d'une banque gère ses utilisateurs,
 * l'administrateur SMT gère ceux de la console. Tout passe par l'API d'administration de Keycloak,
 * avec un compte de service limité à la gestion des utilisateurs.
 */
export interface DirectoryUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  partnerCode: string | null;
  roles: string[];
}

export interface UserDirectory {
  list(scope: { partnerCode: string } | { console: true }): Promise<DirectoryUser[]>;
  get(id: string): Promise<DirectoryUser | null>;
  create(u: Omit<DirectoryUser, 'id' | 'enabled' | 'roles'>, temporaryPassword: string): Promise<string>;
  setRoles(id: string, add: string[], remove: string[]): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}
export const USER_DIRECTORY = Symbol('USER_DIRECTORY');

const BANK_ROLES = Object.values(BankRole) as string[];
const CONSOLE_ROLES = Object.values(ConsoleRole) as string[];

/** Mot de passe temporaire conforme à la politique du royaume (12+ caractères, 4 familles). */
export function temporaryPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%+=?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 16) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export class KeycloakDirectory implements UserDirectory {
  private token?: { value: string; until: number };
  constructor(private readonly cfg: { url: string; realm: string; clientId: string; secret: string }) {}

  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (!this.cfg.secret) throw new DirectoryUnavailable();
    const res = await fetch(`${this.cfg.url}/realms/${this.cfg.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.secret }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) throw new DirectoryUnavailable();
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + (t.expires_in - 20) * 1000 };
    return t.access_token;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const res = await fetch(`${this.cfg.url}/admin/realms/${this.cfg.realm}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${await this.auth()}`, 'Content-Type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) throw new DirectoryUnavailable();
    if (res.status === 409) throw new BusinessRuleError('USER_EXISTS', 'Un utilisateur avec cet identifiant ou cette adresse existe déjà.');
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw new DirectoryUnavailable();
    return res;
  }

  private async toUser(u: any): Promise<DirectoryUser> {
    const roles = (await (await this.call(`/users/${u.id}/role-mappings/realm`)).json()) as { name: string }[];
    return {
      id: u.id, username: u.username, email: u.email ?? '', firstName: u.firstName ?? '', lastName: u.lastName ?? '', enabled: !!u.enabled,
      partnerCode: u.attributes?.partner_code?.[0] ?? null,
      roles: roles.map((r) => r.name).filter((r) => BANK_ROLES.includes(r) || CONSOLE_ROLES.includes(r)),
    };
  }

  async list(scope: { partnerCode: string } | { console: true }) {
    const q = 'partnerCode' in scope ? `?q=partner_code:${encodeURIComponent(scope.partnerCode)}&max=500` : '?max=500&briefRepresentation=false';
    const raw = (await (await this.call(`/users${q}`)).json()) as any[];
    const filtered = raw.filter((u) => !u.username.startsWith('service-account-') && ('partnerCode' in scope ? u.attributes?.partner_code?.[0] === scope.partnerCode : !u.attributes?.partner_code?.length));
    const users = await Promise.all(filtered.map((u) => this.toUser(u)));
    return 'console' in scope ? users.filter((u) => u.roles.some((r) => CONSOLE_ROLES.includes(r))) : users;
  }

  async get(id: string) {
    const res = await this.call(`/users/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    return this.toUser(await res.json());
  }

  async create(u: Omit<DirectoryUser, 'id' | 'enabled' | 'roles'>, password: string) {
    const res = await this.call('/users', {
      method: 'POST',
      body: {
        username: u.username, email: u.email, firstName: u.firstName, lastName: u.lastName, enabled: true, emailVerified: true,
        ...(u.partnerCode ? { attributes: { partner_code: [u.partnerCode] } } : {}),
        credentials: [{ type: 'password', value: password, temporary: true }],
        requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      },
    });
    if (res.status !== 201) throw new BusinessRuleError('USER_INVALID', `Création refusée par l’annuaire (${res.status}).`);
    return res.headers.get('location')!.split('/').pop()!;
  }

  async setRoles(id: string, add: string[], remove: string[]) {
    const reps = async (names: string[]) => Promise.all(names.map(async (n) => (await this.call(`/roles/${encodeURIComponent(n)}`)).json()));
    if (add.length) await this.call(`/users/${id}/role-mappings/realm`, { method: 'POST', body: await reps(add) });
    if (remove.length) await this.call(`/users/${id}/role-mappings/realm`, { method: 'DELETE', body: await reps(remove) });
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.call(`/users/${id}`, { method: 'PUT', body: { enabled } });
  }
}

export class DirectoryUnavailable extends HttpException {
  constructor() {
    super({ code: 'DIRECTORY_UNAVAILABLE', message: 'L’annuaire des utilisateurs est momentanément indisponible.' }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

/** Pour les tests. */
export class InMemoryDirectory implements UserDirectory {
  users: DirectoryUser[] = [];
  async list(scope: { partnerCode: string } | { console: true }) {
    return this.users.filter((u) => ('partnerCode' in scope ? u.partnerCode === scope.partnerCode : !u.partnerCode));
  }
  async get(id: string) {
    return this.users.find((u) => u.id === id) ?? null;
  }
  async create(u: Omit<DirectoryUser, 'id' | 'enabled' | 'roles'>) {
    if (this.users.some((x) => x.username === u.username)) throw new BusinessRuleError('USER_EXISTS', 'Un utilisateur avec cet identifiant ou cette adresse existe déjà.');
    const id = `u${this.users.length + 1}`;
    this.users.push({ ...u, id, enabled: true, roles: [] });
    return id;
  }
  async setRoles(id: string, add: string[], remove: string[]) {
    const u = (await this.get(id))!;
    u.roles = [...new Set([...u.roles.filter((r) => !remove.includes(r)), ...add])];
  }
  async setEnabled(id: string, enabled: boolean) {
    (await this.get(id))!.enabled = enabled;
  }
}

export class CreateUserDto {
  @Matches(/^[a-z0-9._-]{3,60}$/, { message: 'identifiant : minuscules, chiffres, point, tiret (3 à 60)' }) username: string;
  @IsEmail() email: string;
  @IsString() @MaxLength(60) firstName: string;
  @IsString() @MaxLength(60) lastName: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles: string[];
}

export class RolesDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) roles: string[];
}

interface Scope {
  partnerCode: string | null;
  allowed: string[];
  adminRole: string;
  self: string;
  actor: string;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_DIRECTORY) private readonly dir: UserDirectory,
    private readonly audit: AuditService,
  ) {}

  list(s: Scope) {
    return this.dir.list(s.partnerCode ? { partnerCode: s.partnerCode } : { console: true });
  }

  private async target(id: string, s: Scope) {
    const u = await this.dir.get(id);
    // Un utilisateur d'une autre banque (ou de la console) n'existe pas pour cet administrateur.
    if (!u || u.partnerCode !== s.partnerCode) throw new NotFoundException('Introuvable');
    return u;
  }

  private checkRoles(roles: string[], s: Scope) {
    const bad = roles.filter((r) => !s.allowed.includes(r));
    if (bad.length) throw new BusinessRuleError('ROLE_NOT_ALLOWED', `Rôle non attribuable : ${bad.join(', ')}.`);
  }

  async create(dto: CreateUserDto, s: Scope) {
    this.checkRoles(dto.roles, s);
    const password = temporaryPassword();
    const id = await this.dir.create({ username: dto.username, email: dto.email, firstName: dto.firstName, lastName: dto.lastName, partnerCode: s.partnerCode }, password);
    await this.dir.setRoles(id, dto.roles, []);
    await this.audit.record({ actor: s.actor, action: 'user.create', objectType: 'user', objectId: id, details: { username: dto.username, roles: dto.roles, bank: s.partnerCode } });
    // Mot de passe temporaire affiché une seule fois ; changement et double authentification exigés à la première connexion.
    return { id, username: dto.username, temporaryPassword: password };
  }

  async setRoles(id: string, dto: RolesDto, s: Scope) {
    this.checkRoles(dto.roles, s);
    const u = await this.target(id, s);
    if (u.username === s.self && !dto.roles.includes(s.adminRole)) {
      throw new BusinessRuleError('SELF_ADMIN_REMOVAL', 'Vous ne pouvez pas retirer votre propre rôle d’administrateur.');
    }
    const current = u.roles.filter((r) => s.allowed.includes(r));
    await this.dir.setRoles(id, dto.roles.filter((r) => !current.includes(r)), current.filter((r) => !dto.roles.includes(r)));
    await this.audit.record({ actor: s.actor, action: 'user.roles', objectType: 'user', objectId: id, details: { from: current, to: dto.roles } });
    return this.dir.get(id);
  }

  async setEnabled(id: string, enabled: boolean, s: Scope) {
    const u = await this.target(id, s);
    if (u.username === s.self) throw new BusinessRuleError('SELF_DISABLE', 'Vous ne pouvez pas désactiver votre propre compte.');
    await this.dir.setEnabled(id, enabled);
    await this.audit.record({ actor: s.actor, action: enabled ? 'user.enable' : 'user.disable', objectType: 'user', objectId: id, details: { username: u.username } });
    return { ...u, enabled };
  }
}

@Controller('portal/users')
@UseGuards(PortalGuard)
@OnlyRoles(BankRole.ADMIN_SECURITE)
export class PortalUsersController {
  constructor(private readonly users: UsersService) {}
  private scope(b: BankContext): Scope {
    return { partnerCode: b.partnerCode, allowed: BANK_ROLES, adminRole: BankRole.ADMIN_SECURITE, self: b.username, actor: b.actor };
  }
  @Get() list(@Bank() b: BankContext) {
    return this.users.list(this.scope(b));
  }
  @Post() create(@Bank() b: BankContext, @Body() dto: CreateUserDto) {
    return this.users.create(dto, this.scope(b));
  }
  @Put(':id/roles') roles(@Bank() b: BankContext, @Param('id') id: string, @Body() dto: RolesDto) {
    return this.users.setRoles(id, dto, this.scope(b));
  }
  @Post(':id/disable') @HttpCode(200) disable(@Bank() b: BankContext, @Param('id') id: string) {
    return this.users.setEnabled(id, false, this.scope(b));
  }
  @Post(':id/enable') @HttpCode(200) enable(@Bank() b: BankContext, @Param('id') id: string) {
    return this.users.setEnabled(id, true, this.scope(b));
  }
}

@Controller('console/users')
@UseGuards(ConsoleGuard)
@Section('administration')
export class ConsoleUsersController {
  constructor(private readonly users: UsersService) {}
  private scope(req: { identity?: Identity; actor: string }): Scope {
    return { partnerCode: null, allowed: CONSOLE_ROLES, adminRole: ConsoleRole.ADMIN, self: req.identity?.username ?? req.actor, actor: req.actor };
  }
  @Get() list(@Req() req: any) {
    return this.users.list(this.scope(req));
  }
  @Post() create(@Req() req: any, @Body() dto: CreateUserDto) {
    return this.users.create(dto, this.scope(req));
  }
  @Put(':id/roles') roles(@Req() req: any, @Param('id') id: string, @Body() dto: RolesDto) {
    return this.users.setRoles(id, dto, this.scope(req));
  }
  @Post(':id/disable') @HttpCode(200) disable(@Req() req: any, @Param('id') id: string) {
    return this.users.setEnabled(id, false, this.scope(req));
  }
  @Post(':id/enable') @HttpCode(200) enable(@Req() req: any, @Param('id') id: string) {
    return this.users.setEnabled(id, true, this.scope(req));
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Partner]), AuditModule],
  providers: [UsersService],
  controllers: [PortalUsersController, ConsoleUsersController],
})
export class UsersModule {}

export function userDirectoryProvider(config: AppConfig, override?: UserDirectory) {
  return {
    provide: USER_DIRECTORY,
    useFactory: () =>
      override ??
      new KeycloakDirectory({
        url: config.keycloak.adminUrl ?? 'http://keycloak:8080',
        realm: 'smt',
        clientId: config.keycloak.adminClientId ?? 'backend-admin',
        secret: config.keycloak.adminClientSecret ?? '',
      }),
  };
}
