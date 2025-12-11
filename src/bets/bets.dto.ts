import { IsNotEmpty, IsNumber, IsString, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class PlaceBetDto {
  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  selection_id: number;

  @IsNotEmpty()
  @IsString()
  bet_type: string;

  @IsNotEmpty()
  @IsString()
  user_id: string;

  @IsNotEmpty()
  @IsString()
  bet_name: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  bet_rate: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  match_id: number;

  @IsNotEmpty()
  @IsString()
  market_name: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  betvalue: number;

  @IsNotEmpty()
  @IsString()
  market_type: string;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  win_amount: number;

  @IsNotEmpty()
  @Type(() => Number)
  @IsNumber()
  loss_amount: number;

  @IsNotEmpty()
  @IsString()
  gtype: string;

  // New fields for vendor API
  @IsOptional()
  @IsString()
  marketId?: string; // Market ID from vendor API (e.g., "1.250049502")

  @IsOptional()
  @IsString()
  eventId?: string; // Event ID from vendor API (e.g., "34917574")

  @IsOptional()
  @IsString()
  runner_name_2?: string;
}
