import { Controller, Get, Patch, Param, Body, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { MatchVisibilityService } from '../cricketid/match-visibility.service';
import { AggregatorService } from '../cricketid/aggregator.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly matchVisibilityService: MatchVisibilityService,
    private readonly aggregatorService: AggregatorService,
  ) {}

  @Get('dashboard')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  getAdminDashboard(@CurrentUser() user: User) {
    return {
      message: `Welcome to admin dashboard, ${user.name}!`,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('super-admin-only')
  @Roles(UserRole.SUPER_ADMIN)
  getSuperAdminOnly(@CurrentUser() user: User) {
    return {
      message: `This is a super admin only endpoint, ${user.name}!`,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /admin/matches
   * Get all matches with their visibility status
   * Returns matches from vendor API merged with visibility settings
   */
  @Get('matches')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async getAllMatches() {
    try {
      // Get all matches from vendor API (bypass cache to get fresh data)
      const cricketData = await this.aggregatorService.getAllCricketMatches();
      const allMatches = [
        ...(cricketData.live || []),
        ...(cricketData.upcoming || []),
      ];

      // Get visibility settings from database
      const visibilityRecords = await this.matchVisibilityService.getAllMatchesWithVisibility();
      const visibilityMap = new Map(
        visibilityRecords.map((v) => [v.eventId, v.isEnabled]),
      );

      // Merge match data with visibility
      const matchesWithVisibility = allMatches.map((match: any) => {
        const eventId = match?.event?.id;
        const eventName = match?.event?.name || 'Unknown Match';
        const eventDate = match?.event?.openDate || null;

        // Get visibility status (default to true if not in DB)
        const isEnabled = visibilityMap.get(eventId) ?? true;

        return {
          eventId,
          name: eventName,
          isEnabled,
          date: eventDate ? new Date(eventDate).toISOString() : null,
        };
      });

      // Remove duplicates by eventId (keep first occurrence)
      const uniqueMatches = Array.from(
        new Map(matchesWithVisibility.map((m) => [m.eventId, m])).values(),
      );

      // Also include matches that are in visibility DB but not in current vendor data
      for (const visibility of visibilityRecords) {
        const exists = uniqueMatches.some((m) => m.eventId === visibility.eventId);
        if (!exists) {
          uniqueMatches.push({
            eventId: visibility.eventId,
            name: 'Match not available in vendor API',
            isEnabled: visibility.isEnabled,
            date: null, // No date available for matches not in vendor API
          });
        }
      }

      return uniqueMatches.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch matches',
        error: 'Internal Server Error',
      };
    }
  }

  /**
   * PATCH /admin/matches/:eventId
   * Toggle match visibility
   * Body: { isEnabled: boolean }
   */
  @Patch('matches/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async updateMatchVisibility(
    @Param('eventId') eventId: string,
    @Body() body: { isEnabled?: boolean },
  ) {
    try {
      // Validate request body exists
      if (!body || typeof body !== 'object') {
        return {
          success: false,
          message: 'Request body is required',
        };
      }

      // Validate isEnabled is provided and is a boolean
      if (typeof body.isEnabled !== 'boolean') {
        return {
          success: false,
          message: 'isEnabled must be a boolean value',
        };
      }

      // Validate eventId
      if (!eventId || eventId.trim() === '') {
        return {
          success: false,
          message: 'eventId is required',
        };
      }

      // Update visibility (upsert handles creation if record doesn't exist)
      // This is safe even if syncMatch() hasn't run yet
      await this.matchVisibilityService.updateVisibility(eventId, body.isEnabled);

      return {
        success: true,
        message: `Match visibility updated for eventId ${eventId}`,
        eventId,
        isEnabled: body.isEnabled,
      };
    } catch (error: any) {
      // Handle Prisma errors (e.g., table doesn't exist)
      if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
        return {
          success: false,
          message: 'Database table "match_visibility" does not exist. Please run the migration first.',
          error: 'Database Schema Error',
          hint: 'Run the SQL in migration_match_visibility.sql in your Supabase SQL Editor',
        };
      }

      // Handle other errors
      const errorMessage = error?.message || String(error) || 'Failed to update match visibility';
      return {
        success: false,
        message: errorMessage,
        error: 'Internal Server Error',
      };
    }
  }
}
