import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CricketIdFancyDto } from './fancy.dto';
import { CricketIdMatchDto } from './match.dto';
import { CricketIdOddsDto } from './odds.dto';
import { CricketIdScoreDto } from './score.dto';

export class CricketIdWebhookDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CricketIdMatchDto)
  match?: CricketIdMatchDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CricketIdOddsDto)
  odds?: CricketIdOddsDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CricketIdFancyDto)
  fancy?: CricketIdFancyDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CricketIdOddsDto)
  session?: CricketIdOddsDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CricketIdScoreDto)
  score?: CricketIdScoreDto;

  @IsOptional()
  @IsString()
  eventType?: string;
}

