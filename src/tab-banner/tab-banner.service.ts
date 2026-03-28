import { BadRequestException, Injectable } from '@nestjs/common';
import { SportTab } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import cloudinary from '../config/cloudinary.config';

const TAB_FOLDER: Record<SportTab, string> = {
  [SportTab.CRICKET]: 'cricket',
  [SportTab.SOCCER]: 'soccer',
  [SportTab.TENNIS]: 'tennis',
};

/** Max upload size for tab banner images (multipart buffer). */
const MAX_BANNER_IMAGE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class TabBannerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public: all three tabs — missing tabs are null (no banner set yet). */
  async getAllBanners() {
    const rows = await this.prisma.tabBanner.findMany({
      orderBy: { tab: 'asc' },
    });
    const byTab = new Map(rows.map((r) => [r.tab, r]));
    return {
      cricket: byTab.get(SportTab.CRICKET) ?? null,
      soccer: byTab.get(SportTab.SOCCER) ?? null,
      tennis: byTab.get(SportTab.TENNIS) ?? null,
    };
  }

  async getBanner(tabParam: string) {
    const tab = this.parseTab(tabParam);
    const row = await this.prisma.tabBanner.findUnique({ where: { tab } });
    return row;
  }

  /**
   * Admin: set / replace banner for one tab only. Other tabs unchanged.
   * Accepts Cloudinary URL, remote image URL, or raw file buffer upload.
   */
  async upsertBannerFromUrl(tabParam: string, imageInput: string) {
    const tab = this.parseTab(tabParam);
    const existing = await this.prisma.tabBanner.findUnique({ where: { tab } });

    if (existing?.imageUrl && this.isCloudinary(existing.imageUrl)) {
      await this.deleteCloudinaryImage(existing.imageUrl);
    }

    let finalUrl = imageInput.trim();
    if (!this.isCloudinary(finalUrl)) {
      const upload = await cloudinary.uploader.upload(finalUrl, {
        resource_type: 'image',
        folder: `site/tab-banners/${TAB_FOLDER[tab]}`,
      });
      finalUrl = upload.secure_url;
    }

    return this.prisma.tabBanner.upsert({
      where: { tab },
      create: { tab, imageUrl: finalUrl },
      update: { imageUrl: finalUrl },
    });
  }

  async upsertBannerFromFile(tabParam: string, file: { buffer: Buffer; mimetype?: string }) {
    const tab = this.parseTab(tabParam);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }
    if (file.buffer.length > MAX_BANNER_IMAGE_BYTES) {
      throw new BadRequestException(
        `Image must be at most ${MAX_BANNER_IMAGE_BYTES / (1024 * 1024)} MB`,
      );
    }
    const mime = (file.mimetype || '').toLowerCase();
    if (mime && !mime.startsWith('image/')) {
      throw new BadRequestException('File must be an image');
    }

    const existing = await this.prisma.tabBanner.findUnique({ where: { tab } });
    if (existing?.imageUrl && this.isCloudinary(existing.imageUrl)) {
      await this.deleteCloudinaryImage(existing.imageUrl);
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: `site/tab-banners/${TAB_FOLDER[tab]}`,
        },
        async (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          if (!result?.secure_url) {
            reject(new Error('Upload failed: no URL from Cloudinary'));
            return;
          }
          try {
            const saved = await this.prisma.tabBanner.upsert({
              where: { tab },
              create: { tab, imageUrl: result.secure_url },
              update: { imageUrl: result.secure_url },
            });
            resolve(saved);
          } catch (e) {
            reject(e);
          }
        },
      );
      uploadStream.end(file.buffer);
    });
  }

  parseTab(raw: string): SportTab {
    const s = (raw || '').trim().toUpperCase();
    if (s === 'CRICKET') return SportTab.CRICKET;
    if (s === 'SOCCER' || s === 'FOOTBALL') return SportTab.SOCCER;
    if (s === 'TENNIS') return SportTab.TENNIS;
    throw new BadRequestException(
      `Invalid tab "${raw}". Use cricket, soccer, or tennis.`,
    );
  }

  private isCloudinary(url: string) {
    return url.includes('res.cloudinary.com');
  }

  private async deleteCloudinaryImage(url: string) {
    const publicId = this.extractPublicId(url);
    if (!publicId) return;
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    } catch {
      // best-effort cleanup
    }
  }

  /** Public id from a Cloudinary delivery URL (same shape as site-video). */
  private extractPublicId(url: string): string | null {
    const parts = url.split('/');
    const file = parts.pop()?.split('.')[0];
    const uploadIndex = parts.indexOf('upload');
    if (uploadIndex === -1 || !file) return null;
    return parts.slice(uploadIndex + 1).join('/') + '/' + file;
  }
}
