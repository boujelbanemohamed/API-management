import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Identité de l'auteur de l'action, posée par AdminTokenGuard (journal d'audit). */
export const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest();
  return request.actor ?? 'inconnu';
});
