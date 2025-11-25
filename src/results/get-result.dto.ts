import { IsNotEmpty, IsNumber, IsString, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class GetResultDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  event_id: number;

  @IsNotEmpty()
  @IsString()
  event_name: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  market_id: number;

  @IsNotEmpty()
  @IsString()
  market_name: string;

  @IsOptional()
  @IsString()
  market_type?: string;
}
