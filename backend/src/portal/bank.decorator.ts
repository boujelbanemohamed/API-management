import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BankContext } from '../auth/guards';

/** Banque connectée, posée par PortalGuard. */
export const Bank = createParamDecorator((_d: unknown, ctx: ExecutionContext): BankContext => ctx.switchToHttp().getRequest().bank);
