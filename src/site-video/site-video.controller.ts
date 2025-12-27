import {
  Controller,
  Get,
  Post,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SiteVideoService } from './site-video.service';

@Controller('site-video')
export class SiteVideoController {
  constructor(private readonly service: SiteVideoService) {}

  // 🔁 Create / Update / Replace - Accepts file upload OR videoUrl
  @Post()
  async updateIntro(@Req() request: FastifyRequest) {
    // Check if request is multipart
    if (!request.isMultipart()) {
      // If not multipart, try to get videoUrl from JSON body
      const body = request.body as { videoUrl?: string };
      if (body?.videoUrl) {
        return this.service.upsertIntroVideo(body.videoUrl);
      }
      throw new BadRequestException('Either video file or videoUrl must be provided');
    }

    // Handle multipart/form-data
    const parts = request.parts();
    let file: any = null;
    let videoUrl: string | undefined = undefined;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'videoUrl') {
        // Validate file type
        if (!part.mimetype?.startsWith('video/')) {
          throw new BadRequestException('File must be a video');
        }

        // Read file buffer
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        file = {
          fieldname: part.fieldname,
          filename: part.filename,
          encoding: part.encoding,
          mimetype: part.mimetype,
          buffer: buffer,
          size: buffer.length,
        };
      } else if (part.type === 'field' && part.fieldname === 'videoUrl') {
        videoUrl = part.value as string;
      }
    }

    // If file is uploaded, use file buffer directly (more efficient than base64)
    if (file) {
      return this.service.upsertIntroVideoFromFile(file);
    }

    // If videoUrl is provided, use it directly
    if (videoUrl) {
      return this.service.upsertIntroVideo(videoUrl);
    }

    throw new BadRequestException('Either video file or videoUrl must be provided');
  }

  // 👀 Frontend fetch
  @Get()
  async getIntro() {
    return this.service.getActiveVideo();
  }
}

