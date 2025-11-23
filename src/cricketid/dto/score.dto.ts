import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CricketIdScoreDto {
  @IsNumber()
  match_id: number;

  @IsOptional()
  @IsString()
  batting_team?: string;

  @IsOptional()
  @IsString()
  bowling_team?: string;

  @IsOptional()
  @IsString()
  score?: string;

  @IsOptional()
  @IsString()
  overs?: string;

  @IsOptional()
  @IsNumber()
  wickets?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

