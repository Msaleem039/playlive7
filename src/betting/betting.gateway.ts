import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { createHash } from 'crypto';
import { AggregatorService } from '../cricketid/aggregator.service';

@WebSocketGateway()
export class BettingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BettingGateway.name);
  private readonly lastPayloadHash = new Map<string, string>();

  @WebSocketServer()
  server: Server;

  constructor(private readonly aggregatorService: AggregatorService) {}

  handleConnection(client: Socket) {
    this.logger.debug(`Socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  private normalizeMarketIds(marketIds: string): string {
    return Array.from(
      new Set(
        String(marketIds)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ).join(',');
  }

  private oddsRoom(eventId: string, marketIds: string): string {
    return `odds:${eventId}:${marketIds}`;
  }

  private fancyRoom(eventId: string): string {
    return `bookmaker-fancy:${eventId}`;
  }

  private emitIfChanged(cacheKey: string, room: string, eventName: string, payload: any): boolean {
    const serialized = JSON.stringify(payload ?? null);
    const nextHash = createHash('sha1').update(serialized).digest('hex');
    const prevHash = this.lastPayloadHash.get(cacheKey);
    if (prevHash === nextHash) return false;
    this.lastPayloadHash.set(cacheKey, nextHash);
    this.server.to(room).emit(eventName, payload);
    return true;
  }

  emitOddsIfChanged(eventId: string, marketIds: string, data: any): boolean {
    const normalizedEventId = String(eventId).trim();
    const normalizedMarketIds = this.normalizeMarketIds(marketIds);
    if (!normalizedEventId || !normalizedMarketIds) return false;

    const room = this.oddsRoom(normalizedEventId, normalizedMarketIds);
    return this.emitIfChanged(
      `odds:${normalizedEventId}:${normalizedMarketIds}`,
      room,
      'odds:update',
      {
        eventId: normalizedEventId,
        marketIds: normalizedMarketIds.split(','),
        data,
        updatedAt: Date.now(),
      },
    );
  }

  emitBookmakerFancyIfChanged(eventId: string, data: any): boolean {
    const normalizedEventId = String(eventId).trim();
    if (!normalizedEventId) return false;
    const room = this.fancyRoom(normalizedEventId);
    return this.emitIfChanged(
      `bookmaker-fancy:${normalizedEventId}`,
      room,
      'bookmaker-fancy:update',
      {
        eventId: normalizedEventId,
        data,
        updatedAt: Date.now(),
      },
    );
  }

  @SubscribeMessage('subscribe:odds')
  handleSubscribeOdds(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string; marketIds?: string },
  ) {
    const eventId = String(payload?.eventId ?? '').trim();
    const marketIds = this.normalizeMarketIds(String(payload?.marketIds ?? ''));
    if (!eventId || !marketIds) {
      return { success: false, message: 'eventId and marketIds are required' };
    }
    client.join(this.oddsRoom(eventId, marketIds));
    this.aggregatorService.registerActiveMatch(eventId, marketIds);
    return { success: true, eventId, marketIds: marketIds.split(',') };
  }

  @SubscribeMessage('unsubscribe:odds')
  handleUnsubscribeOdds(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string; marketIds?: string },
  ) {
    const eventId = String(payload?.eventId ?? '').trim();
    const marketIds = this.normalizeMarketIds(String(payload?.marketIds ?? ''));
    if (!eventId || !marketIds) {
      return { success: false, message: 'eventId and marketIds are required' };
    }
    client.leave(this.oddsRoom(eventId, marketIds));
    return { success: true };
  }

  @SubscribeMessage('subscribe:bookmaker-fancy')
  handleSubscribeBookmakerFancy(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string; marketIds?: string },
  ) {
    const eventId = String(payload?.eventId ?? '').trim();
    if (!eventId) {
      return { success: false, message: 'eventId is required' };
    }
    client.join(this.fancyRoom(eventId));
    // If marketIds available, keep active match registration for odds cron too.
    const marketIds = this.normalizeMarketIds(String(payload?.marketIds ?? ''));
    if (marketIds) {
      this.aggregatorService.registerActiveMatch(eventId, marketIds);
    }
    return { success: true, eventId };
  }

  @SubscribeMessage('unsubscribe:bookmaker-fancy')
  handleUnsubscribeBookmakerFancy(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string },
  ) {
    const eventId = String(payload?.eventId ?? '').trim();
    if (!eventId) {
      return { success: false, message: 'eventId is required' };
    }
    client.leave(this.fancyRoom(eventId));
    return { success: true };
  }

  @SubscribeMessage('message')
  handleMessage(client: any, payload: any): string {
    return 'Hello world!';
  }
}
