import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config';
import { Identity, TOKEN_VERIFIER, TokenVerifier } from './token-verifier';
import { ConsoleSection, PortalSection, canConsole, canPortal } from './roles';
import { Partner, PartnerStatus } from '../partners/partner.entity';

export const CONSOLE_SECTION = 'console_section';
export const PORTAL_SECTION = 'portal_section';
export const ONLY_ROLES = 'only_roles';

/** Section de la console protégée par ce contrôleur (ou cette méthode). */
export const Section = (section: ConsoleSection) => SetMetadata(CONSOLE_SECTION, section);
/** Section du portail protégée par ce contrôleur (ou cette méthode). */
export const PortalArea = (section: PortalSection) => SetMetadata(PORTAL_SECTION, section);
/** Restreint une action à certains rôles, en plus de la section (ex. décision d'arbitrage). */
/** Accessible à tout utilisateur de la console (ex. son profil et son menu). */
export const AnyConsoleUser = () => SetMetadata('any_console_user', true);
export const OnlyRoles = (...roles: string[]) => SetMetadata(ONLY_ROLES, roles);

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function bearer(request: any): string {
  const header: string | undefined = request.headers['authorization'];
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new UnauthorizedException('Authentification requise');
  return token;
}

const isWrite = (request: any) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method);

async function identify(verifier: TokenVerifier, token: string): Promise<Identity> {
  try {
    return await verifier.verify(token);
  } catch {
    throw new UnauthorizedException('Jeton invalide ou expiré');
  }
}

/**
 * Console SMT : jeton Keycloak du client « console » et rôle autorisé sur la section,
 * ou jeton technique (échanges entre services, scripts d'exploitation, tests).
 */
@Injectable()
export class ConsoleGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = bearer(request);

    if (safeEqual(token, this.config.adminApiToken)) {
      request.actor = request.headers['x-actor'] ?? 'service';
      return true;
    }

    const id = await identify(this.verifier, token);
    if (id.client !== this.config.keycloak.consoleClientId) {
      throw new ForbiddenException('Ce jeton n’est pas un jeton de la console');
    }
    const targets = [context.getHandler(), context.getClass()];
    const section = this.reflector.getAllAndOverride<ConsoleSection>(CONSOLE_SECTION, targets);
    if (this.reflector.getAllAndOverride<boolean>('any_console_user', targets) && id.roles.some((r) => r.startsWith('console-'))) {
      request.actor = id.username;
      request.identity = id;
      return true;
    }
    // Contrôleur sans section déclarée : réservé au jeton technique (refus par défaut).
    if (!section || !canConsole(id.roles, section, isWrite(request))) {
      throw new ForbiddenException('Droits insuffisants pour cette section');
    }
    const only = this.reflector.getAllAndOverride<string[]>(ONLY_ROLES, targets);
    if (only && !id.roles.some((r) => only.includes(r))) {
      throw new ForbiddenException('Action réservée à un autre rôle');
    }
    request.actor = id.username;
    request.identity = id;
    return true;
  }
}

/** Banque connectée au portail, déduite du jeton. Jamais d'un paramètre envoyé par le client. */
export interface BankContext {
  partnerId: string;
  partnerCode: string;
  username: string;
  roles: string[];
  /** Auteur tracé dans l'audit : CODE:utilisateur. */
  actor: string;
}

@Injectable()
export class PortalGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @InjectRepository(Partner) private readonly partners: Repository<Partner>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const id = await identify(this.verifier, bearer(request));
    if (id.client !== this.config.keycloak.portalClientId) {
      throw new ForbiddenException('Ce jeton n’est pas un jeton du portail');
    }
    if (!id.partnerCode) throw new ForbiddenException('Utilisateur non rattaché à une banque');

    const partner = await this.partners.findOne({ where: { code: id.partnerCode.toUpperCase() } });
    if (!partner || partner.status === PartnerStatus.TERMINATED) {
      throw new ForbiddenException('Banque inconnue ou résiliée');
    }
    const targets = [context.getHandler(), context.getClass()];
    const section = this.reflector.getAllAndOverride<PortalSection>(PORTAL_SECTION, targets);
    if (section && !canPortal(id.roles, section, isWrite(request))) {
      throw new ForbiddenException('Droits insuffisants pour cette section');
    }
    if (!id.roles.some((r) => r.startsWith('banque-'))) throw new ForbiddenException('Aucun rôle banque');
    const only = this.reflector.getAllAndOverride<string[]>(ONLY_ROLES, targets);
    if (only && !id.roles.some((r) => only.includes(r))) {
      throw new ForbiddenException('Action réservée à un autre rôle');
    }

    const bank: BankContext = {
      partnerId: partner.id,
      partnerCode: partner.code,
      username: id.username,
      roles: id.roles,
      actor: `${partner.code}:${id.username}`,
    };
    request.bank = bank;
    request.actor = bank.actor;
    return true;
  }
}
