import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CricketIdOddsDto {
  @IsOptional()
  @IsString()
  sid?: string;

  @IsOptional()
  @IsString()
  runner?: string;

  @IsOptional()
  @IsNumber()
  back?: number;

  @IsOptional()
  @IsNumber()
  lay?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

