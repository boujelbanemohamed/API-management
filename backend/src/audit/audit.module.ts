import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEvent } from './audit-event.entity';
import { AuditService } from './audit.service';
import { AdminTokenGuard } from '../common/admin-token.guard';

@Controller('audit')
@UseGuards(AdminTokenGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  search(
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('actor') actor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.search({ objectType, objectId, actor, limit: limit ? Number(limit) : undefined });
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent])],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
