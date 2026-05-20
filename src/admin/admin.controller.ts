import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';
import { UserRole } from '@prisma/client';
import { MatchVisibilityService } from '../cricketid/match-visibility.service';
import { BetsService } from '../bets/bets.service';
import { AuthService } from '../auth/auth.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(
    private readonly matchVisibilityService: MatchVisibilityService,
    private readonly betsService: BetsService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Super Admin only: obtain a JWT for an Agent or Client without their password.
   * Token payload includes `impersonatedBy` (super admin user id). Use `Authorization: Bearer <accessToken>` as usual.
   */
  @Post('login-as-user/:userId')
  @Roles(UserRole.SUPER_ADMIN)
  async loginAsUser(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: User,
  ) {
    return this.authService.loginAsUser(currentUser, userId);
  }

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

  /**
   * GET /admin/matchodds/stop/:eventId
   * Current block status for one match (same shape as PATCH response).
   */
  @Get('matchodds/stop/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getMatchOddsStopForEvent(@Param('eventId') eventId: string) {
    const eventIds = await this.betsService.getBlockedMatchOddsEvents();
    const normalizedEventId = String(eventId || '').trim();
    const blocked = eventIds.includes(normalizedEventId);
    return {
      success: true,
      totalBlockedEvents: eventIds.length,
      ...this.matchOddsBlockDetail(normalizedEventId, blocked),
    };
  }

  /**
   * GET /admin/matchodds/stop
   * All blocked match-odds events with per-event detail (same fields as PATCH).
   */
  @Get('matchodds/stop')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getStoppedMatchOddsEvents() {
    const eventIds = await this.betsService.getBlockedMatchOddsEvents();
    const items = eventIds.map((id) => this.matchOddsBlockDetail(id, true));
    return {
      success: true,
      status: 'ACTIVE_BLOCKLIST',
      total: eventIds.length,
      totalBlockedEvents: eventIds.length,
      eventIds,
      items,
    };
  }

  /**
   * PATCH /admin/matchodds/stop/:eventId
   * Stop/allow Match Odds betting for a specific match (all clients).
   * Body: { blocked: boolean }
   */
  @Patch('matchodds/stop/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async setMatchOddsStopForEvent(
    @Param('eventId') eventId: string,
    @Body() body: { blocked?: boolean; status?: boolean | string },
  ) {
    const blocked = this.parseBlockedBody(body);
    if (blocked === null) {
      return {
        success: false,
        message: 'Provide blocked (boolean) or status ("true"/"false"/"STOPPED"/"ALLOWED")',
      };
    }

    const result = await this.betsService.setMatchOddsBlockedForEvent(eventId, blocked);
    return {
      success: true,
      ...this.matchOddsBlockDetail(result.eventId, blocked),
      totalBlockedEvents: result.totalBlockedEvents,
    };
  }

  /**
   * GET /admin/fancy/stop/:eventId
   * Current block status for one match (same shape as PATCH response).
   */
  @Get('fancy/stop/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getFancyStopForEvent(@Param('eventId') eventId: string) {
    const eventIds = await this.betsService.getBlockedFancyEvents();
    const normalizedEventId = String(eventId || '').trim();
    const blocked = eventIds.includes(normalizedEventId);
    return {
      success: true,
      totalBlockedEvents: eventIds.length,
      ...this.fancyBlockDetail(normalizedEventId, blocked),
    };
  }

  /**
   * GET /admin/fancy/stop
   * All blocked fancy events with per-event detail (same fields as PATCH).
   */
  @Get('fancy/stop')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async getStoppedFancyEvents() {
    const eventIds = await this.betsService.getBlockedFancyEvents();
    const items = eventIds.map((id) => this.fancyBlockDetail(id, true));
    return {
      success: true,
      status: 'ACTIVE_BLOCKLIST',
      total: eventIds.length,
      totalBlockedEvents: eventIds.length,
      eventIds,
      items,
    };
  }

  /**
   * PATCH /admin/fancy/stop/:eventId
   * Stop/allow Fancy betting for a specific match (all clients).
   * Body: { blocked: boolean } or { status: "STOPPED" | "ALLOWED" }
   */
  @Patch('fancy/stop/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT)
  async setFancyStopForEvent(
    @Param('eventId') eventId: string,
    @Body() body: { blocked?: boolean; status?: boolean | string },
  ) {
    const blocked = this.parseBlockedBody(body);
    if (blocked === null) {
      return {
        success: false,
        message: 'Provide blocked (boolean) or status ("true"/"false"/"STOPPED"/"ALLOWED")',
      };
    }

    const result = await this.betsService.setFancyBlockedForEvent(eventId, blocked);
    return {
      success: true,
      ...this.fancyBlockDetail(result.eventId, blocked),
      totalBlockedEvents: result.totalBlockedEvents,
    };
  }

  /**
   * PATCH /admin/matchodds/accept-delay/:eventId
   * Per-event Match Odds acceptance delay (seconds) only.
   * Body: { "delaySec": 15 } — Match Odds bets for this event wait up to delaySec (capped) after live
   * rate validation before the wallet transaction. Also used as Redis snapshot TTL when strict
   * live odds fail but a just-fetched snapshot is acceptable.
   * Body: { "delaySec": null } — remove override for this eventId.
   */
  @Patch('matchodds/accept-delay/:eventId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async setMatchOddsAcceptDelay(
    @Param('eventId') eventId: string,
    @Body() body: { delaySec?: number | null },
  ) {
    if (body == null || typeof body !== 'object' || !('delaySec' in body)) {
      return {
        success: false,
        message:
          'Body must include delaySec. Use a positive number of seconds, or null to remove. Example: {"delaySec":15}',
      };
    }

    const rawDelay = body.delaySec;
    const delaySec =
      rawDelay === null || rawDelay === undefined
        ? null
        : Number(rawDelay);

    if (delaySec !== null && (!Number.isFinite(delaySec) || delaySec <= 0)) {
      return {
        success: false,
        message: 'delaySec must be a positive number or null',
      };
    }

    const result = await this.betsService.setMatchOddsAcceptDelayOverrideForEvent(
      eventId,
      delaySec,
    );
    return {
      success: true,
      message:
        delaySec === null
          ? `Acceptance delay override removed for eventId ${result.eventId}`
          : `Acceptance delay override set to ${result.delaySec}s for eventId ${result.eventId}`,
      ...result,
    };
  }

  /**
   * GET /admin/matchodds/accept-delay
   * List all per-event Match Odds acceptance delay overrides (seconds).
   */
  @Get('matchodds/accept-delay')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getMatchOddsAcceptDelayOverrides() {
    const overrides = await this.betsService.getMatchOddsAcceptDelayOverrides();
    return {
      success: true,
      total: Object.keys(overrides).length,
      overrides,
    };
  }

  private parseBlockedBody(body: {
    blocked?: boolean;
    status?: boolean | string;
  }): boolean | null {
    if (typeof body?.blocked === 'boolean') {
      return body.blocked;
    }
    if (typeof body?.status === 'boolean') {
      return body.status;
    }
    if (typeof body?.status === 'string') {
      const normalized = body.status.trim().toLowerCase();
      if (normalized === 'true' || normalized === 'stop' || normalized === 'stopped') {
        return true;
      }
      if (normalized === 'false' || normalized === 'allow' || normalized === 'allowed') {
        return false;
      }
    }
    return null;
  }

  private matchOddsBlockDetail(eventId: string, blocked: boolean) {
    return {
      message: blocked
        ? `Match Odds betting stopped for eventId ${eventId}`
        : `Match Odds betting allowed for eventId ${eventId}`,
      status: blocked ? ('STOPPED' as const) : ('ALLOWED' as const),
      action: blocked ? ('STOP' as const) : ('ALLOW' as const),
      isMatchOddsBlocked: blocked,
      isMatchOddsAllowed: !blocked,
      eventId,
      blocked,
    };
  }

  private fancyBlockDetail(eventId: string, blocked: boolean) {
    return {
      message: blocked
        ? `Fancy betting stopped for eventId ${eventId}`
        : `Fancy betting allowed for eventId ${eventId}`,
      status: blocked ? ('STOPPED' as const) : ('ALLOWED' as const),
      action: blocked ? ('STOP' as const) : ('ALLOW' as const),
      isFancyBlocked: blocked,
      isFancyAllowed: !blocked,
      eventId,
      blocked,
    };
  }
}
