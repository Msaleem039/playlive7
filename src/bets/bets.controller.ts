import { Body, Controller, Post, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { BetsService } from './bets.service';

@Controller('bf_placeBet_api')
export class BetsController {
  private readonly logger = new Logger(BetsController.name);

  constructor(private readonly betsService: BetsService) {}

  @Post()
  async placeBet(@Body() dto: PlaceBetDto) {
    try {
      return await this.betsService.placeBet(dto);
    } catch (error) {
      this.logger.error('Error placing bet:', error);
      
      // If it's already an HttpException, re-throw it
      if (error instanceof HttpException) {
        throw error;
      }

      // Otherwise, wrap it in a proper error response
      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to place bet',
          code: 'BET_PLACEMENT_FAILED',
          details: error instanceof Error ? error.stack : undefined,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
