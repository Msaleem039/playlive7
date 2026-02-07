import { Module } from '@nestjs/common';
import { NewsBarController } from './news-bar.controller';
import { NewsBarService } from './news-bar.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [NewsBarController],
  providers: [NewsBarService],
  exports: [NewsBarService],
})
export class NewsModule {}

