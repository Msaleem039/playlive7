import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { CricketIdFancyDto } from './dto/fancy.dto';
import { CricketIdMatchDto } from './dto/match.dto';
import { CricketIdOddsDto } from './dto/odds.dto';
import { CricketIdScoreDto } from './dto/score.dto';
import { CricketIdWebhookDto } from './dto/webhook.dto';
import { OddsGateway } from './odds.gateway';

@Injectable()
export class CricketIdWebhookService {
  private readonly logger = new Logger(CricketIdWebhookService.name);

  constructor(
    @Inject(forwardRef(() => OddsGateway))
    private readonly oddsGateway: OddsGateway,
  ) {}

  async handleWebhook(payload: CricketIdWebhookDto): Promise<void> {
    if (payload.match) {
      await this.handleMatchStatus(payload.match);
    }

    if (payload.score) {
      await this.handleScoreUpdate(payload.score);
    }

    if (payload.odds?.length) {
      await this.handleOddsUpdate(payload.odds);
    }

    if (payload.fancy?.length) {
      await this.handleFancyUpdate(payload.fancy);
    }

    if (payload.session?.length) {
      await this.handleSessionUpdate(payload.session);
    }
  }

  private async handleMatchStatus(match: CricketIdMatchDto): Promise<void> {
    this.logger.debug(`Match status received for ${match.match_id}: ${match.status ?? 'unknown'}`);
  }


  private async handleOddsUpdate(odds: CricketIdOddsDto[]): Promise<void> {
    this.logger.debug(`Received ${odds.length} odds updates`);
    
    // Emit to all rooms that match the sid from odds
    odds.forEach((odd) => {
      if (odd.sid) {
        // Emit to all rooms starting with this sid
        this.emitToRoomsBySid(parseInt(odd.sid), { type: 'odds', data: odd });
      }
    });
  }

  private async handleFancyUpdate(fancy: CricketIdFancyDto[]): Promise<void> {
    this.logger.debug(`Received ${fancy.length} fancy updates`);
    
    // Emit fancy updates to all rooms (fancy doesn't have sid/gmid mapping)
    this.emitToAllRooms({ type: 'fancy', data: fancy });
  }

  private async handleSessionUpdate(session: CricketIdOddsDto[]): Promise<void> {
    this.logger.debug(`Received ${session.length} session updates`);
    
    // Emit session updates to relevant rooms
    session.forEach((s) => {
      if (s.sid) {
        this.emitToRoomsBySid(parseInt(s.sid), { type: 'session', data: s });
      }
    });
  }

  private async handleScoreUpdate(score: CricketIdScoreDto): Promise<void> {
    this.logger.debug(`Score update for ${score.match_id}: ${score.score ?? 'N/A'}`);
    
    // Emit score update - we need to find rooms by match_id
    // Since we don't have direct mapping, emit to all rooms and let clients filter
    this.emitToAllRooms({ type: 'score', data: score });
  }

  private emitToRoomsBySid(sid: number, payload: any): void {
    if (!this.oddsGateway || !this.oddsGateway.server) {
      this.logger.warn('OddsGateway server not available');
      return;
    }

    const server = this.oddsGateway.server;
    const rooms = server.sockets.adapter.rooms;
    
    // Find all rooms that start with this sid
    rooms.forEach((_, roomName) => {
      if (typeof roomName === 'string' && roomName.startsWith(`${sid}_`)) {
        server.to(roomName).emit('webhook_update', payload);
        this.logger.debug(`Emitted update to room: ${roomName}`);
      }
    });
  }

  private emitToAllRooms(payload: any): void {
    if (!this.oddsGateway || !this.oddsGateway.server) {
      this.logger.warn('OddsGateway server not available');
      return;
    }

    const server = this.oddsGateway.server;
    server.emit('webhook_update', payload);
    this.logger.debug('Emitted update to all connected clients');
  }
}

