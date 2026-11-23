import { ArrayMaxSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, Length, Matches, MaxLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isIP } from 'net';
import { PartnerType } from './partner.entity';

@ValidatorConstraint({ name: 'ipOrCidr' })
export class IpOrCidrList implements ValidatorConstraintInterface {
  validate(values: unknown): boolean {
    return Array.isArray(values) && values.every((v) => typeof v === 'string' && isIpOrCidr(v));
  }
  defaultMessage(): string {
    return 'allowedIps doit contenir des adresses IP ou des plages CIDR valides (ex. 196.203.10.0/28)';
  }
}

export function isIpOrCidr(value: string): boolean {
  const [ip, mask, extra] = value.split('/');
  if (extra !== undefined) return false;
  const version = isIP(ip);
  if (!version) return false;
  if (mask === undefined) return true;
  if (!/^\d{1,3}$/.test(mask)) return false;
  return Number(mask) <= (version === 4 ? 32 : 128);
}

export class CreatePartnerDto {
  /** Code court unique (lettres, chiffres, _), stocké en majuscules. Ex. BNA, ATTIJARI */
  @Matches(/^[A-Za-z0-9_]{2,40}$/, { message: 'code : 2 à 40 caractères parmi lettres, chiffres et _' })
  code: string;

  @IsString()
  @Length(2, 200)
  name: string;

  @IsOptional()
  @IsEnum(PartnerType)
  type?: PartnerType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxId?: string;

  @IsOptional()
  @IsEmail()
  technicalContactEmail?: string;

  @IsOptional()
  @IsEmail()
  billingContactEmail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Validate(IpOrCidrList)
  allowedIps?: string[];
}

export class UpdatePartnerDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @IsOptional()
  @IsEnum(PartnerType)
  type?: PartnerType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  taxId?: string;

  @IsOptional()
  @IsEmail()
  technicalContactEmail?: string;

  @IsOptional()
  @IsEmail()
  billingContactEmail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Validate(IpOrCidrList)
  allowedIps?: string[];
}

export class ReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
