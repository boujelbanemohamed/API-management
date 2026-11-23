import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageEvent } from './usage-event.entity';
import { ApisixLogEntry, UsageService } from './usage.service';
import { ApiProduct } from '../apis/api-product.entity';
import { ConsoleGuard, Section, safeEqual } from '../auth/guards';
import { APP_CONFIG, AppConfig } from '../config';
import { isIsoDate } from '../common/dates';

/** Réservé à la passerelle : jeton dédié, distinct du jeton d'administration. */
@Injectable()
export class UsageIngestGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const header: string | undefined = context.switchToHttp().getRequest().headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token || !safeEqual(token, this.config.usageIngestToken)) throw new UnauthorizedException();
    return true;
  }
}

@Controller('internal/usage')
@UseGuards(UsageIngestGuard)
export class UsageIngestController {
  constructor(private readonly usage: UsageService) {}

  @Post()
  @HttpCode(200)
  ingest(@Body() body: unknown) {
    const entries = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : null;
    if (!entries) throw new BadRequestException('Lot d’événements attendu');
    if (entries.length > 5000) throw new BadRequestException('Lot trop volumineux (5000 événements maximum)');
    return this.usage.ingest(entries as ApisixLogEntry[]);
  }
}

@Controller('usage')
@Section('finance')
@UseGuards(ConsoleGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('summary')
  summary(@Query('from') from: string, @Query('to') to: string, @Query('partner') partner?: string, @Query('api') api?: string) {
    assertRange(from, to);
    return this.usage.summary({ from, to, partnerCode: partner, apiSlug: api });
  }

  @Get('daily')
  daily(@Query('from') from: string, @Query('to') to: string, @Query('partner') partner?: string, @Query('api') api?: string) {
    assertRange(from, to);
    return this.usage.daily({ from, to, partnerCode: partner, apiSlug: api });
  }
}

function assertRange(from: string, to: string): void {
  if (!from || !to || !isIsoDate(from) || !isIsoDate(to) || to < from) {
    throw new BadRequestException('Paramètres from et to requis, au format AAAA-MM-JJ, avec from ≤ to');
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([UsageEvent, ApiProduct])],
  providers: [UsageService, UsageIngestGuard],
  controllers: [UsageIngestController, UsageController],
  exports: [UsageService],
})
export class UsageModule {}
