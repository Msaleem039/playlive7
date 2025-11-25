import { Body, Controller, Post } from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { BetsService } from './bets.service';

@Controller('bf_placeBet_api')
export class BetsController {
  constructor(private readonly betsService: BetsService) {}

  @Post()
  placeBet(@Body() dto: PlaceBetDto) {
    return this.betsService.placeBet(dto);
  }
}
