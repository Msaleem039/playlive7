import { Controller, Get, Post, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { RedisService } from './redis.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('cache')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RedisController {
  constructor(private readonly redisService: RedisService) {}

  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async getCacheStats() {
    return await this.redisService.getCacheStats();
  }

  @Get('cricket/matches')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async getCachedMatches() {
    return await this.redisService.getCachedCricketMatches();
  }

  @Get('cricket/match/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async getCachedMatch(@Param('id') id: number) {
    return await this.redisService.getCachedMatch(id);
  }

  @Get('cricket/competitions')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async getCachedCompetitions() {
    return await this.redisService.getCachedCompetitions();
  }

  @Get('cricket/teams')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.AGENT, UserRole.CLIENT)
  async getCachedTeams() {
    return await this.redisService.getCachedTeams();
  }

  @Delete('cricket/match/:id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async invalidateMatchCache(@Param('id') id: number) {
    await this.redisService.invalidateMatchCache(id);
    return { message: `Cache invalidated for match ${id}` };
  }

  @Delete('cricket/matches')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async clearMatchesCache() {
    await this.redisService.del('cricket:matches:live');
    return { message: 'Live matches cache cleared' };
  }

  @Delete('all')
  @Roles(UserRole.SUPER_ADMIN)
  async clearAllCache() {
    await this.redisService.reset();
    return { message: 'All cache cleared' };
  }

  @Post('warmup')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async warmupCache() {
    // This would trigger cache warming for frequently accessed data
    return { message: 'Cache warmup initiated' };
  }
}
