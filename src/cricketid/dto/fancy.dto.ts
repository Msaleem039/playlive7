import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CricketIdFancyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  session?: string;

  @IsOptional()
  @IsNumber()
  rate?: number;

  @IsOptional()
  @IsString()
  line?: string;
}

