import { IsNotEmpty, IsString } from 'class-validator';

export class ManualSettleDto {
  @IsString()
  @IsNotEmpty()
  match_id: string;
}


