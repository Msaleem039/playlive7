import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PositionService } from './position.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@Controller('positions')
@UseGuards(JwtAuthGuard)
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  /**
   * Get all positions for the current user
   * GET /positions
   */
  @Get()
  async getMyPositions(@CurrentUser() user: User) {
    return this.positionService.getPositionsByUser(user.id);
  }

  /**
   * Get positions for a specific match
   * GET /positions/match/:matchId?marketType=MATCH_ODDS
   */
  @Get('match/:matchId')
  async getPositionsByMatch(
    @CurrentUser() user: User,
    @Param('matchId') matchId: string,
    @Query('marketType') marketType?: string,
  ) {
    return this.positionService.getPositionsByMatch(user.id, matchId, marketType);
  }

  /**
   * Get position for a specific selection
   * GET /positions/match/:matchId/market/:marketType/selection/:selectionId
   */
  @Get('match/:matchId/market/:marketType/selection/:selectionId')
  async getPosition(
    @CurrentUser() user: User,
    @Param('matchId') matchId: string,
    @Param('marketType') marketType: string,
    @Param('selectionId') selectionId: number,
  ) {
    return this.positionService.getPosition(user.id, matchId, marketType, Number(selectionId));
  }
}

