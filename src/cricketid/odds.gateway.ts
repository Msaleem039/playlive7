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

@WebSocketGateway({ cors: true })
export class OddsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(OddsGateway.name);

  private intervals = new Map<string, NodeJS.Timeout>();
  private clientRooms = new Map<string, Set<string>>();

  constructor(private cricketService: CricketIdService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientRooms.set(client.id, new Set());
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clearClientIntervals(client);
    this.clientRooms.delete(client.id);
  }

  @SubscribeMessage('subscribe_match')
  async subscribeMatch(
    @MessageBody() data: { sid: number; gmid: number },
    @ConnectedSocket() client: Socket,
  ) {
    const roomName = `${data.sid}_${data.gmid}`;
    client.join(roomName);

    // Track which rooms this client is in
    const clientRoomSet = this.clientRooms.get(client.id);
    if (clientRoomSet) {
      clientRoomSet.add(roomName);
    }

    // If interval already exists for this room, don't create another one
    if (this.intervals.has(roomName)) {
      this.logger.debug(`Interval already exists for room: ${roomName}`);
      return;
    }

    // Create interval to poll API every 2-3 seconds
    const interval = setInterval(async () => {
      try {
        const result = await this.cricketService.getPrivateData(data.sid, data.gmid);
        this.server.to(roomName).emit('odds_update', result);
      } catch (error) {
        this.logger.error(
          `Error fetching private data for room ${roomName}:`,
          error instanceof Error ? error.message : String(error),
        );
        // Optionally emit error to clients
        this.server.to(roomName).emit('odds_error', {
          error: 'Failed to fetch odds data',
          room: roomName,
        });
      }
    }, 2500); // 2.5 seconds (between 2-3 seconds)

    this.intervals.set(roomName, interval);
    this.logger.log(`Started polling for room: ${roomName}`);
  }

  @SubscribeMessage('unsubscribe_match')
  leaveMatch(
    @MessageBody() data: { sid: number; gmid: number },
    @ConnectedSocket() client: Socket,
  ) {
    const roomName = `${data.sid}_${data.gmid}`;
    client.leave(roomName);

    // Remove room from client's tracked rooms
    const clientRoomSet = this.clientRooms.get(client.id);
    if (clientRoomSet) {
      clientRoomSet.delete(roomName);
    }

    // Check if room has any remaining clients
    const clients = this.server.sockets.adapter.rooms.get(roomName);

    if (!clients || clients.size === 0) {
      this.clearIntervalForRoom(roomName);
    }
  }

  private clearClientIntervals(client: Socket) {
    const clientRoomSet = this.clientRooms.get(client.id);
    if (!clientRoomSet) return;

    clientRoomSet.forEach((roomName) => {
      // Check if room still has other clients
      const clients = this.server.sockets.adapter.rooms.get(roomName);
      if (!clients || clients.size === 0) {
        this.clearIntervalForRoom(roomName);
      }
    });
  }

  private clearIntervalForRoom(roomName: string) {
    const interval = this.intervals.get(roomName);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(roomName);
      this.logger.log(`Stopped polling for room: ${roomName}`);
    }
  }
}

