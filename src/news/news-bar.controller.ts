import {
  Controller,
  Get,
  Put,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NewsBarService } from './news-bar.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateNewsBarDto } from './update-news-bar.dto';

  
  @Controller('news-bar')
  export class NewsBarController {
    constructor(private readonly newsBarService: NewsBarService) {}
  
    // 🌐 PUBLIC API (Client side)
    @Get()
    async getNewsBar() {
      return this.newsBarService.getNewsBar();
    }
  
    // 🔐 ADMIN API
    @Put()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('ADMIN', 'SUPER_ADMIN')
    async updateNewsBar(
      @Body() dto: UpdateNewsBarDto,
      @Req() req: any,
    ) {
      return this.newsBarService.updateNewsBar(
        dto.text,
        req.user.id,
      );
    }
  }
  