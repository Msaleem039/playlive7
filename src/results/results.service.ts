import { Injectable, HttpException } from '@nestjs/common';
import axios from 'axios';
import { URLSearchParams } from 'url';
import { GetResultDto } from './get-result.dto';

@Injectable()
export class ResultsService {
  private readonly baseUrl = 'https://api.cricketid.xyz';
  private readonly apiKey = process.env.CRICKET_ID_API_KEY ?? 'dijbfuwd719e12rqhfbjdqdnkqnd11';
  private readonly apiSid = process.env.CRICKET_ID_API_SID ?? '4';

  async getResult(payload: GetResultDto) {
    try {
      const params = new URLSearchParams({
        key: this.apiKey,
        sid: this.apiSid,
      });

      const url = `${this.baseUrl}/get-result?${params.toString()}`;

      const response = await axios.post(
        url,
        payload,
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      return {
        success: true,
        data: response.data
      };

    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: 'Failed to fetch result',
          error: error.response?.data || error.message,
        },
        500
      );
    }
  }
}
