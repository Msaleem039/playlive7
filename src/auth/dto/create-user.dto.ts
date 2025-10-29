import { IsEmail, IsString, MinLength, MaxLength, IsEnum, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsEmail()
  email: string;

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

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercentage?: number;

  // Optional alias to match previous endpoints
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;
}
