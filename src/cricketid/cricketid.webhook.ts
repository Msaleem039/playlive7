import { Injectable, Logger } from '@nestjs/common';
import { CricketIdFancyDto } from './dto/fancy.dto';
import { CricketIdMatchDto } from './dto/match.dto';
import { CricketIdOddsDto } from './dto/odds.dto';
import { CricketIdScoreDto } from './dto/score.dto';
import { CricketIdWebhookDto } from './dto/webhook.dto';

@Injectable()
export class CricketIdWebhookService {
  private readonly logger = new Logger(CricketIdWebhookService.name);

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

  private async handleScoreUpdate(score: CricketIdScoreDto): Promise<void> {
    this.logger.debug(`Score update for ${score.match_id}: ${score.score ?? 'N/A'}`);
  }

  private async handleOddsUpdate(odds: CricketIdOddsDto[]): Promise<void> {
    this.logger.debug(`Received ${odds.length} odds updates`);
  }

  private async handleFancyUpdate(fancy: CricketIdFancyDto[]): Promise<void> {
    this.logger.debug(`Received ${fancy.length} fancy updates`);
  }

  private async handleSessionUpdate(session: CricketIdOddsDto[]): Promise<void> {
    this.logger.debug(`Received ${session.length} session updates`);
  }
}

