import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MatchVisibilityService {
  private readonly logger = new Logger(MatchVisibilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sync match visibility - create if not exists with isEnabled = true
   * Called when vendor data comes in
   * Uses upsert to safely handle concurrent requests
   */
  async syncMatch(eventId: string): Promise<void> {
    try {
      // TypeScript workaround: Prisma client types may not be immediately recognized
      const prisma = this.prisma as any;
      await prisma.matchVisibility.upsert({
        where: { eventId },
        update: {}, // No update needed if exists
        create: { eventId, isEnabled: true },
      });
      this.logger.debug(`Synced MatchVisibility for eventId: ${eventId}`);
    } catch (error) {
      this.logger.error(`Error syncing match visibility for eventId ${eventId}:`, error);
      // Don't throw - allow the flow to continue even if visibility sync fails
    }
  }

  /**
   * Batch sync multiple matches - prevents connection pool exhaustion
   * Uses a single transaction to insert/update multiple records efficiently
   */
  async syncMatchesBatch(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) {
      return;
    }

    try {
      const prisma = this.prisma as any;
      
      // Use transaction to batch all upserts efficiently
      await prisma.$transaction(
        eventIds.map((eventId) =>
          prisma.matchVisibility.upsert({
            where: { eventId },
            update: {}, // No update needed if exists
            create: { eventId, isEnabled: true },
          })
        ),
        {
          maxWait: 10000, // 10 seconds max wait
          timeout: 30000, // 30 seconds timeout
        }
      );
      
      this.logger.debug(`Batch synced ${eventIds.length} MatchVisibility records`);
    } catch (error) {
      this.logger.error(`Error batch syncing match visibility for ${eventIds.length} matches:`, error);
      // Don't throw - allow the flow to continue even if batch sync fails
    }
  }

  /**
   * Check if a match is enabled (visible)
   */
  async isMatchEnabled(eventId: string): Promise<boolean> {
    try {
      // TypeScript workaround: Prisma client types may not be immediately recognized
      const prisma = this.prisma as any;
      const visibility = await prisma.matchVisibility.findUnique({
        where: { eventId },
      });

      // If not found, default to enabled (for backward compatibility)
      return visibility?.isEnabled ?? true;
    } catch (error) {
      this.logger.error(`Error checking match visibility for eventId ${eventId}:`, error);
      // Default to enabled on error
      return true;
    }
  }

  /**
   * Get visibility status for multiple eventIds
   * Returns a Map<eventId, isEnabled>
   */
  async getVisibilityMap(eventIds: string[]): Promise<Map<string, boolean>> {
    const visibilityMap = new Map<string, boolean>();

    if (eventIds.length === 0) {
      return visibilityMap;
    }

    try {
      // TypeScript workaround: Prisma client types may not be immediately recognized
      const prisma = this.prisma as any;
      const visibilities = await prisma.matchVisibility.findMany({
        where: {
          eventId: { in: eventIds },
        },
      });

      // Create a map of eventId -> isEnabled
      for (const v of visibilities) {
        visibilityMap.set(v.eventId, v.isEnabled);
      }

      // For eventIds not found in DB, default to enabled
      for (const eventId of eventIds) {
        if (!visibilityMap.has(eventId)) {
          visibilityMap.set(eventId, true);
        }
      }
    } catch (error) {
      this.logger.error(`Error getting visibility map:`, error);
      // On error, default all to enabled
      for (const eventId of eventIds) {
        visibilityMap.set(eventId, true);
      }
    }

    return visibilityMap;
  }

  /**
   * Get all matches with their visibility status
   * Used by admin panel
   */
  async getAllMatchesWithVisibility(): Promise<
    Array<{ eventId: string; isEnabled: boolean; createdAt: Date; updatedAt: Date }>
  > {
    try {
      // TypeScript workaround: Prisma client types may not be immediately recognized
      const prisma = this.prisma as any;
      return await prisma.matchVisibility.findMany({
        orderBy: { updatedAt: 'desc' },
        select: {
          eventId: true,
          isEnabled: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      this.logger.error(`Error getting all matches with visibility:`, error);
      throw error;
    }
  }

  /**
   * Update match visibility (admin only)
   * Uses upsert to safely handle cases where record doesn't exist yet
   * This prevents errors if admin toggles visibility before syncMatch() runs
   */
  async updateVisibility(eventId: string, isEnabled: boolean): Promise<void> {
    try {
      // TypeScript workaround: Prisma client types may not be immediately recognized
      const prisma = this.prisma as any;
      await prisma.matchVisibility.upsert({
        where: { eventId },
        update: { isEnabled },
        create: { eventId, isEnabled },
      });
      this.logger.log(`Updated visibility for eventId ${eventId}: isEnabled=${isEnabled}`);
    } catch (error) {
      this.logger.error(`Error updating visibility for eventId ${eventId}:`, error);
      throw error;
    }
  }

  /**
   * Filter matches by visibility
   * Returns only matches that are enabled (isEnabled === true)
   * 
   * Behavior:
   * - Matches without eventId are excluded
   * - Matches with eventId not in visibilityMap are excluded
   * - Only matches with visibilityMap.get(eventId) === true are included
   * 
   * Note: If visibilityMap was built during an error, it defaults all to true,
   * so all matches would be included. This is acceptable for graceful degradation.
   */
  filterMatchesByVisibility<T extends { event?: { id?: string } }>(
    matches: T[],
    visibilityMap: Map<string, boolean>,
  ): T[] {
    return matches.filter((match) => {
      const eventId = match?.event?.id;
      if (!eventId) {
        return false; // Exclude matches without eventId
      }
      // Only include matches explicitly set to true
      // undefined or false values are excluded
      return visibilityMap.get(eventId) === true;
    });
  }
}

