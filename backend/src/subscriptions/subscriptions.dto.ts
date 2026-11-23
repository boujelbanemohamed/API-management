import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { Environment } from './subscription.entity';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MSG = 'date au format AAAA-MM-JJ';

export class CreateSubscriptionDto {
  @IsUUID()
  partnerId: string;

  @IsUUID()
  apiId: string;

  @IsUUID()
  planId: string;

  @IsOptional()
  @IsEnum(Environment)
  environment?: Environment;

  /** Par défaut : aujourd'hui. */
  @IsOptional()
  @Matches(DATE, { message: DATE_MSG })
  startDate?: string;

  /** Par défaut : un an après la date de début. */
  @IsOptional()
  @Matches(DATE, { message: DATE_MSG })
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  customDailyQuota?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contractReference?: string;
}

export class RenewSubscriptionDto {
  @Matches(DATE, { message: DATE_MSG })
  endDate: string;
}

export class ChangePlanDto {
  @IsUUID()
  planId: string;

  /** IMMEDIATE : tout de suite ; NEXT_MONTH : le 1er du mois suivant. */
  @IsIn(['IMMEDIATE', 'NEXT_MONTH'])
  effective: 'IMMEDIATE' | 'NEXT_MONTH';
}

export class UpdateQuotaDto {
  /** null pour revenir au quota du plan. */
  @IsOptional()
  @IsInt()
  @Min(1)
  customDailyQuota?: number | null;
}
