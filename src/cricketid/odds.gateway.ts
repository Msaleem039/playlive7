import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { CricketIdService } from './cricketid.service';

@WebSocketGateway({
  cors: {
    origin: '*', // Allow all origins in production, or specify your frontend URL
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['*'],
  },
  transports: ['websocket', 'polling'], // Support both transports
})
export class OddsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() 
  public server: Server; // Make public so webhook service can access it
  private readonly logger = new Logger(OddsGateway.name);

  private clientRooms = new Map<string, Set<string>>();
  private roomMetadata = new Map<string, { eventId?: string | number; marketIds?: string }>();

  constructor(private cricketService: CricketIdService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientRooms.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clearClientRooms(client);
    this.clientRooms.delete(client.id);
  }

  @SubscribeMessage('subscribe_match')
  async subscribeMatch(
    @MessageBody() data: { eventId?: string | number; marketIds?: string },
    @ConnectedSocket() client: Socket,
  ) {
    // Support both old format (sid, gmid) and new format (eventId, marketIds)
    const eventId = data.eventId;
    const marketIds = data.marketIds;
    
    if (!eventId && !marketIds) {
      client.emit('odds_error', {
        error: 'Either eventId or marketIds is required',
      });
      return;
    }

    // Use marketIds if provided, otherwise use eventId to get markets first
    const roomName = marketIds ? `markets_${marketIds}` : `event_${eventId}`;
    client.join(roomName);

    // Track which rooms this client is in
    const clientRoomSet = this.clientRooms.get(client.id);
    if (clientRoomSet) {
      clientRoomSet.add(roomName);
    }

    // Store room metadata for cron job to use
    if (!this.roomMetadata.has(roomName)) {
      this.roomMetadata.set(roomName, { eventId, marketIds });
      this.logger.log(`Room ${roomName} registered for cron job updates`);
    }
  }

  @SubscribeMessage('unsubscribe_match')
  leaveMatch(
    @MessageBody() data: { eventId?: string | number; marketIds?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const eventId = data.eventId;
    const marketIds = data.marketIds;
    const roomName = marketIds ? `markets_${marketIds}` : `event_${eventId}`;
    client.leave(roomName);

    // Remove room from client's tracked rooms
    const clientRoomSet = this.clientRooms.get(client.id);
    if (clientRoomSet) {
      clientRoomSet.delete(roomName);
    }

    // Check if room has any remaining clients
    const clients = this.server.sockets.adapter.rooms.get(roomName);

    if (!clients || clients.size === 0) {
      this.roomMetadata.delete(roomName);
      this.logger.log(`Room ${roomName} unregistered (no clients remaining)`);
    }
  }

  private clearClientRooms(client: Socket) {
    const clientRoomSet = this.clientRooms.get(client.id);
    if (!clientRoomSet) return;

    clientRoomSet.forEach((roomName) => {
      // Check if room still has other clients
      const clients = this.server.sockets.adapter.rooms.get(roomName);
      if (!clients || clients.size === 0) {
        this.roomMetadata.delete(roomName);
        this.logger.log(`Room ${roomName} unregistered (client disconnected)`);
      }
    });
  }

  /**
   * Fetch and emit odds for all active rooms
   * Called by cron job every 3-5 seconds
   */
  async fetchAndEmitOddsForAllRooms() {
    const activeRooms = Array.from(this.roomMetadata.entries());
    
    if (activeRooms.length === 0) {
      return;
    }

    // Process all rooms in parallel
    await Promise.allSettled(
      activeRooms.map(async ([roomName, metadata]) => {
        try {
          // Verify room still has clients
          const clients = this.server.sockets.adapter.rooms.get(roomName);
          if (!clients || clients.size === 0) {
            this.roomMetadata.delete(roomName);
            return;
          }

          let result;

          if (metadata.marketIds) {
            // Direct odds fetch if marketIds provided
            result = await this.cricketService.getBetfairOdds(metadata.marketIds);
          } else if (metadata.eventId) {
            // Get markets first, then get odds for all markets
            const markets = await this.cricketService.getMarketList(metadata.eventId);

            // Extract marketIds from markets response
            if (markets && Array.isArray(markets)) {
              const marketIdList = markets
                .map((m: any) => m.marketId)
                .filter((id: any) => id)
                .join(',');

              if (marketIdList) {
                result = await this.cricketService.getBetfairOdds(marketIdList);
              } else {
                result = markets; // Return markets if no marketIds found
              }
            } else {
              result = markets;
            }
          }

          if (result) {
            this.server.to(roomName).emit('odds_update', result);
          }
        } catch (error) {
          this.logger.error(
            `Error fetching odds data for room ${roomName}:`,
            error instanceof Error ? error.message : String(error),
          );
          // Emit error to clients
          this.server.to(roomName).emit('odds_error', {
            error: 'Failed to fetch odds data',
            room: roomName,
          });
        }
      }),
    );
  }
}

