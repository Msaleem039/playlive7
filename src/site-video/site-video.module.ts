import { Module } from '@nestjs/common';
import { SiteVideoService } from './site-video.service';
import { SiteVideoController } from './site-video.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SiteVideoController],
  providers: [SiteVideoService],
  exports: [SiteVideoService],
})
export class SiteVideoModule {}

