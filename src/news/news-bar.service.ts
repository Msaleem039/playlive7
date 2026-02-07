import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NewsBarService {
  constructor(private readonly prisma: PrismaService) {}

  // 🔹 GET news bar text
  async getNewsBar() {
    const setting = await this.prisma.setting.findUnique({
      where: { key: 'NEWS_BAR_TEXT' },
    });

    return {
      text: setting?.value ?? '',
    };
  }

  // 🔹 UPDATE news bar text (Admin only)
  async updateNewsBar(text: string, adminId: string) {
    await this.prisma.setting.upsert({
      where: { key: 'NEWS_BAR_TEXT' },
      update: {
        value: text,
      },
      create: {
        key: 'NEWS_BAR_TEXT',
        value: text,
      },
    });

    return {
      success: true,
      message: 'News bar updated successfully',
    };
  }
}
