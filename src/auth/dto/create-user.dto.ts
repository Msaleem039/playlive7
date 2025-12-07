import { IsString, MinLength, MaxLength, IsEnum, IsOptional, IsNumber, Min, Max, ValidateIf } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  email?: string;

  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsOptional()
  @IsNumber()
  @Min(0)
  balance?: number;

  // share (commissionPercentage) is REQUIRED for ADMIN and AGENT, optional for others
  @ValidateIf((o) => o.role === UserRole.ADMIN || o.role === UserRole.AGENT)
  @IsNumber()
  @Min(1)
  @Max(100)
  commissionPercentage?: number;

  // Optional alias to match previous endpoints
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;
}
