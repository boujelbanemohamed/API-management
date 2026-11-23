import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AnyConsoleUser, ConsoleGuard } from './guards';
import { visibleConsoleSections } from './roles';
import { Identity } from './token-verifier';

/** Profil de l'utilisateur de la console et sections de menu qu'il peut voir. */
@Controller('console')
@UseGuards(ConsoleGuard)
export class ConsoleMeController {
  @Get('me')
  @AnyConsoleUser()
  me(@Req() req: { identity?: Identity; actor: string }) {
    const roles = req.identity?.roles ?? ['console-admin'];
    return {
      username: req.actor,
      roles: roles.filter((r) => r.startsWith('console-')),
      sections: visibleConsoleSections(roles),
    };
  }
}
