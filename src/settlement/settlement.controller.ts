import { Controller, Get, Query } from '@nestjs/common';
import { SettlementService } from './settlement.service';
import { ManualSettleDto } from './dto/manual-settle.dto';

@Controller('settlement')
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Get('manual')
  async manualSettle(@Query() query: ManualSettleDto) {
    return this.settlement.settleMatch(query.match_id);
  }
}
