import { Body, Controller, Post } from '@nestjs/common';
import { ResultsService } from './results.service';
import { GetResultDto } from './get-result.dto';

@Controller('results')
export class ResultsController {
  constructor(private readonly resultService: ResultsService) {}

  @Post('get-result')
  async getResult(@Body() dto: GetResultDto) {
    return this.resultService.getResult(dto);
  }
}
