import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

@Controller('betfair')
export class BetfairController {
  @Get('data')
  async getBetfairData() {
    try {
      // Call the restricted external API
      const response = await axios.get('https://api.akapps.live/api/MarketModels/GetBetfareRets');

      // Return the data to your frontend
      return response.data;
    } catch (error) {
      console.error('Error fetching Betfair API:', error.message);
      throw new HttpException('Failed to fetch Betfair data', HttpStatus.BAD_REQUEST);
    }
  }
}
