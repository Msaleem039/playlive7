import { IsNotEmpty, IsString, IsNumber } from 'class-validator';

export class ManualSettleDto {
  @IsString()
  @IsNotEmpty()
  match_id: string;
}

export class ManualSettleBySettlementIdDto {
  @IsString()
  @IsNotEmpty()
  settlement_id: string;
}

export class ManualSettleWithResultDto {
  @IsString()
  @IsNotEmpty()
  settlement_id: string;

  @IsString()
  @IsNotEmpty()
  winner: string; // The winner/result to use for settlement
}

export class ReverseSettlementDto {
  @IsString()
  @IsNotEmpty()
  settlement_id: string;
}

export class SettleSingleSessionBetDto {
  @IsString()
  @IsNotEmpty()
  match_id: string;

  @IsNumber()
  selection_id: number;

  @IsString()
  @IsNotEmpty()
  gtype: string;

  @IsString()
  @IsNotEmpty()
  bet_name: string;

  @IsNumber()
  winner_id: number;
}
