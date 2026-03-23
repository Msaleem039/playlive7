import { Module } from '@nestjs/common';
import { TabBannerController } from './tab-banner.controller';
import { TabBannerService } from './tab-banner.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TabBannerController],
  providers: [TabBannerService],
  exports: [TabBannerService],
})
export class TabBannerModule {}
