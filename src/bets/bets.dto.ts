import { IsNotEmpty, IsNumber, IsString, IsOptional } from 'class-validator';

export class PlaceBetDto {

  @IsNotEmpty() selection_id: number;
  @IsNotEmpty() bet_type: string;
  @IsNotEmpty() user_id: string;
  @IsNotEmpty() bet_name: string;
  @IsNotEmpty() bet_rate: number;
  @IsNotEmpty() match_id: number;
  @IsNotEmpty() market_name: string;
  @IsNotEmpty() betvalue: number;
  @IsNotEmpty() market_type: string;
  @IsNotEmpty() win_amount: number;
  @IsNotEmpty() loss_amount: number;
  @IsNotEmpty() gtype: string;

  @IsOptional() runner_name_2?: string;
}
