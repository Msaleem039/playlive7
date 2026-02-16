import { IsString, MinLength, MaxLength, IsOptional, IsNumber, Min, Max } from 'class-validator';

export class UpdateClientDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(100)
  password?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionPercentage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxWinLimit?: number;
}

