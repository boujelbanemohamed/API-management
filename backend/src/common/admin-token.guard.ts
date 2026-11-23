import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Protection provisoire des API d'administration par jeton statique.
 * À remplacer à l'itération suivante par la validation des jetons Keycloak (rôles de la console).
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token || !safeEqual(token, this.config.adminApiToken)) {
      throw new UnauthorizedException('Jeton d’administration invalide');
    }
    request.actor = request.headers['x-actor'] ?? 'admin';
    return true;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
