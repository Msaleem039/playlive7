import { IsEmail, IsString, MinLength, MaxLength, IsOptional, IsEnum, IsNumber, Min } from 'class-validator';
import { UserRole } from '@prisma/client';

export class RegisterDto {
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

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsNumber()
  @Min(0)
  balance?: number;

  // Optional alias to match previous endpoints
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;
}
