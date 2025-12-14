import { Controller } from '@nestjs/common';
import { SettlementService } from './settlement.service';

@Controller('settlement')
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  // Public settlement endpoints can be added here if needed
  // Admin endpoints are in settlement-admin.controller.ts
}
