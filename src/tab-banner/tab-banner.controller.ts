import {
  Controller,
  Get,
  Post,
  Param,
  Req,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { TabBannerService } from './tab-banner.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('admin/site/tab-banners')
export class TabBannerController {
  constructor(private readonly service: TabBannerService) {}

  /** Public: all tab banners (cricket / soccer / tennis). Null if not set. */
  @Get()
  async getAll() {
    return this.service.getAllBanners();
  }

  /** Public: one tab — cricket | soccer | tennis */
  @Get(':tab')
  async getOne(@Param('tab') tab: string) {
    return this.service.getBanner(tab);
  }

  /**
   * Admin: upload / replace banner for **one** tab only (multipart file or imageUrl).
   * PATCH semantics: only the `:tab` row changes.
   */
  @Post(':tab')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async uploadDirect(@Param('tab') tab: string, @Req() request: FastifyRequest) {
    return this.handleUpload(tab, request);
  }

  @Post(':tab/upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async upload(@Param('tab') tab: string, @Req() request: FastifyRequest) {
    return this.handleUpload(tab, request);
  }

  private async handleUpload(tab: string, request: FastifyRequest) {
    if (!request.isMultipart()) {
      const body = request.body as { imageUrl?: string };
      if (body?.imageUrl?.trim()) {
        return this.service.upsertBannerFromUrl(tab, body.imageUrl);
      }
      throw new BadRequestException('Send multipart with field "image" or JSON body { "imageUrl": "..." }');
    }

    const parts = request.parts();
    let file: {
      buffer: Buffer;
      mimetype?: string;
    } | null = null;
    let imageUrl: string | undefined;

    for await (const part of parts) {
      if (part.type === 'file' && (part.fieldname === 'image' || part.fieldname === 'banner')) {
        if (part.mimetype && !part.mimetype.startsWith('image/')) {
          throw new BadRequestException('File must be an image');
        }
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        file = { buffer, mimetype: part.mimetype };
      } else if (part.type === 'field' && part.fieldname === 'imageUrl') {
        imageUrl = part.value as string;
      }
    }

    if (file) {
      return this.service.upsertBannerFromFile(tab, file);
    }
    if (imageUrl?.trim()) {
      return this.service.upsertBannerFromUrl(tab, imageUrl);
    }

    throw new BadRequestException('Provide image file (field "image") or imageUrl');
  }
}
