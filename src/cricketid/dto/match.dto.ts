import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CricketIdMatchDto {
  @IsNumber()
  match_id: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  status_note?: string;
}

