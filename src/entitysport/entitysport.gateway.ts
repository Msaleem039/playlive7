import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*', // Configure this to your frontend's origin in production
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/entitysport', // Namespace for EntitySport live updates
})
export class EntitySportGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EntitySportGateway.name);
  private connectedClients = new Map<string, Socket>();

  /**
   * Initialize the WebSocket server
   */
  afterInit(server: Server) {
    this.logger.log('🚀 EntitySport WebSocket Gateway initialized');
    this.server = server;
  }

  /**
   * Handle new client connections
   */
  handleConnection(client: Socket) {
    const clientId = client.id;
    this.connectedClients.set(clientId, client);
    
    this.logger.log(`✅ Client connected: ${clientId}`);
    this.logger.log(`📊 Total connected clients: ${this.connectedClients.size}`);

    // Send welcome message to the client
    client.emit('connected', {
      message: 'Connected to EntitySport Live Updates',
      clientId,
      timestamp: new Date().toISOString(),
      totalClients: this.connectedClients.size,
    });

    // Send current connection status
    client.emit('connectionStatus', {
      status: 'connected',
      clientId,
      serverTime: new Date().toISOString(),
    });
  }

  /**
   * Handle client disconnections
   */
  handleDisconnect(client: Socket) {
    const clientId = client.id;
    this.connectedClients.delete(clientId);
    
    this.logger.log(`❌ Client disconnected: ${clientId}`);
    this.logger.log(`📊 Total connected clients: ${this.connectedClients.size}`);
  }

  /**
   * Handle client subscription to specific cricket events
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { event: string; matchId?: string }
  ) {
    const { event, matchId } = data;
    this.logger.log(`📡 Client ${client.id} subscribed to: ${event}${matchId ? ` for match ${matchId}` : ''}`);
    
    // Join specific rooms for targeted updates
    if (matchId) {
      client.join(`match-${matchId}`);
    }
    
    client.join(event);
    
    // Send confirmation
    client.emit('subscriptionConfirmed', {
      event,
      matchId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle client unsubscription from events
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { event: string; matchId?: string }
  ) {
    const { event, matchId } = data;
    this.logger.log(`📡 Client ${client.id} unsubscribed from: ${event}${matchId ? ` for match ${matchId}` : ''}`);
    
    // Leave specific rooms
    if (matchId) {
      client.leave(`match-${matchId}`);
    }
    
    client.leave(event);
    
    // Send confirmation
    client.emit('unsubscriptionConfirmed', {
      event,
      matchId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Handle ping/pong for connection health
   */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', {
      timestamp: new Date().toISOString(),
      serverTime: Date.now(),
    });
  }

  /**
   * Get connection statistics
   */
  @SubscribeMessage('getStats')
  handleGetStats(@ConnectedSocket() client: Socket) {
    const stats = {
      totalClients: this.connectedClients.size,
      serverTime: new Date().toISOString(),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
    
    client.emit('stats', stats);
  }

  /**
   * Broadcast live update to all connected clients
   * This method is called by EntitySportService when new data arrives
   */
  broadcastLiveUpdate(eventName: string, data: any) {
    try {
      // Broadcast to all clients in the specific event room
      this.server.to(eventName).emit('liveUpdate', {
        event: eventName,
        data,
        timestamp: new Date().toISOString(),
      });

      // Also broadcast to all connected clients
      this.server.emit('liveUpdate', {
        event: eventName,
        data,
        timestamp: new Date().toISOString(),
      });

      // Special handling for real-time WebSocket data
      if (eventName === 'entitySportRealtimeData') {
        this.server.emit('realtimeUpdate', {
          event: 'entitySportRealtimeData',
          data,
          timestamp: new Date().toISOString(),
          source: 'websocket'
        });
      }

      this.logger.debug(`📡 Broadcasted ${eventName} to ${this.connectedClients.size} clients`);
    } catch (error) {
      this.logger.error(`❌ Failed to broadcast ${eventName}:`, error);
    }
  }

  /**
   * Broadcast to specific match room
   */
  broadcastToMatch(matchId: string, eventName: string, data: any) {
    try {
      this.server.to(`match-${matchId}`).emit('liveUpdate', {
        event: eventName,
        data,
        matchId,
        timestamp: new Date().toISOString(),
      });

      this.logger.debug(`📡 Broadcasted ${eventName} to match ${matchId} room`);
    } catch (error) {
      this.logger.error(`❌ Failed to broadcast to match ${matchId}:`, error);
    }
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, event: string, data: any) {
    const client = this.connectedClients.get(clientId);
    if (client) {
      client.emit(event, data);
      this.logger.debug(`📤 Sent ${event} to client ${clientId}`);
    } else {
      this.logger.warn(`⚠️ Client ${clientId} not found`);
    }
  }

  /**
   * Get all connected clients info
   */
  getConnectedClients() {
    return Array.from(this.connectedClients.keys());
  }

  /**
   * Get connection count
   */
  getConnectionCount() {
    return this.connectedClients.size;
  }

  /**
   * Broadcast server message to all clients
   */
  broadcastServerMessage(message: string, type: 'info' | 'warning' | 'error' = 'info') {
    this.server.emit('serverMessage', {
      message,
      type,
      timestamp: new Date().toISOString(),
    });
  }
}

