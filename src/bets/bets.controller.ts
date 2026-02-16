import {
  Body,
  Controller,
  Post,
  Get,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { PlaceBetDto } from './bets.dto';
import { BetsService } from './bets.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('bf_placeBet_api')
export class BetsController {
  private readonly logger = new Logger(BetsController.name);

  constructor(private readonly betsService: BetsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
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

  /**
   * Get position details for a market
   * GET /bf_placeBet_api/positions?userId={userId}&marketId={marketId}&selections={selection1,selection2,selection3}
   * 
   * Returns calculated positions (P/L projections) for each selection based on user's pending bets
   * 
   * Example:
   * GET /bf_placeBet_api/positions?userId=user123&marketId=market456&selections=1,2,3
   * 
   * Response:
   * {
   *   "1": 150,   // If selection 1 wins, user gains 150
   *   "2": -100,  // If selection 2 wins, user loses 100
   *   "3": -50    // If selection 3 wins, user loses 50
   * }
   */
  @Get('positions')
  async getMarketPositions(
    @Query('userId') userId: string,
    @Query('marketId') marketId: string,
    @Query('selections') selectionsParam: string,
  ) {
    if (!userId) {
      throw new HttpException(
        {
          success: false,
          error: 'userId query parameter is required',
          code: 'MISSING_USER_ID',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!marketId) {
      throw new HttpException(
        {
          success: false,
          error: 'marketId query parameter is required',
          code: 'MISSING_MARKET_ID',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!selectionsParam) {
      throw new HttpException(
        {
          success: false,
          error: 'selections query parameter is required (comma-separated selection IDs)',
          code: 'MISSING_SELECTIONS',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Parse comma-separated selections
      const marketSelections = selectionsParam.split(',').map((s) => s.trim()).filter(Boolean);

      if (marketSelections.length === 0) {
        throw new HttpException(
          {
            success: false,
            error: 'At least one selection ID is required',
            code: 'INVALID_SELECTIONS',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      const authoritativePositions = await this.betsService.getMarketPositions(
        userId,
        marketId,
        marketSelections,
      );

      return {
        success: true,
        data: {
          userId,
          marketId,
          marketSelections,
          authoritativePositions,
        },
      };
    } catch (error) {
      this.logger.error('Error getting market positions:', error);

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get market positions',
          code: 'POSITION_CALCULATION_FAILED',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
