import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import cloudinary from '../config/cloudinary.config';

@Injectable()
export class SiteVideoService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertIntroVideo(videoInput: string) {
    const existing = await (this.prisma as any).siteVideo.findUnique({
      where: { key: 'SITE_INTRO' },
    });

    let finalVideoUrl = videoInput;

    // 🔥 Delete old Cloudinary video
    if (existing?.videoUrl && this.isCloudinary(existing.videoUrl)) {
      await this.deleteCloudinaryVideo(existing.videoUrl);
    }

    // 🚀 Upload new video if needed (for URL strings)
    if (!this.isCloudinary(videoInput)) {
      const upload = await cloudinary.uploader.upload(videoInput, {
        resource_type: 'video',
        folder: 'site/intro',
        chunk_size: 6_000_000,
        timeout: 60000, // 60 seconds timeout
      });

      finalVideoUrl = upload.secure_url;
    }

    // 🔁 UPSERT (single row guaranteed)
    return (this.prisma as any).siteVideo.upsert({
      where: { key: 'SITE_INTRO' },
      update: {
        videoUrl: finalVideoUrl,
        isActive: true,
      },
      create: {
        key: 'SITE_INTRO',
        videoUrl: finalVideoUrl,
        isActive: true,
      },
    });
  }

  async upsertIntroVideoFromFile(file: any) {
    const existing = await (this.prisma as any).siteVideo.findUnique({
      where: { key: 'SITE_INTRO' },
    });

    // 🔥 Delete old Cloudinary video
    if (existing?.videoUrl && this.isCloudinary(existing.videoUrl)) {
      await this.deleteCloudinaryVideo(existing.videoUrl);
    }

    // 🚀 Upload file directly to Cloudinary (more efficient than base64)
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: 'site/intro',
          chunk_size: 6_000_000,
          timeout: 120000, // 2 minutes timeout for large files
        },
        async (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          if (!result) {
            reject(new Error('Upload failed: No result from Cloudinary'));
            return;
          }

          // 🔁 UPSERT (single row guaranteed)
          try {
            const saved = await (this.prisma as any).siteVideo.upsert({
              where: { key: 'SITE_INTRO' },
              update: {
                videoUrl: result.secure_url,
                isActive: true,
              },
              create: {
                key: 'SITE_INTRO',
                videoUrl: result.secure_url,
                isActive: true,
              },
            });
            resolve(saved);
          } catch (dbError) {
            reject(dbError);
          }
        },
      );

      // Pipe file buffer to upload stream
      uploadStream.end(file.buffer);
    });
  }

  async getActiveVideo() {
    return (this.prisma as any).siteVideo.findFirst({
      where: { key: 'SITE_INTRO', isActive: true },
    });
  }

  // ================= HELPERS =================

  private isCloudinary(url: string) {
    return url.includes('res.cloudinary.com');
  }

  private async deleteCloudinaryVideo(url: string) {
    const publicId = this.extractPublicId(url);
    if (!publicId) return;

    await cloudinary.uploader.destroy(publicId, {
      resource_type: 'video',
    });
  }

  private extractPublicId(url: string): string {
    const parts = url.split('/');
    const file = parts.pop()?.split('.')[0];
    const uploadIndex = parts.indexOf('upload');
    return parts.slice(uploadIndex + 1).join('/') + '/' + file;
  }
}

