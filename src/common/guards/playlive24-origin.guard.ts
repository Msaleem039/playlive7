import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

/** Public site for bet placement — Origin / Referer must be this host over HTTPS. */
const ALLOWED_HOST = 'playlive24.com';

@Injectable()
export class Playlive24OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const internalToken = req.headers['x-internal-service-token'];
    const expectedInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    if (
      internalToken &&
      expectedInternalToken &&
      String(internalToken) === String(expectedInternalToken)
    ) {
      return true;
    }

    const origin = req.headers['origin'];
    const referer = req.headers['referer'];

    if (this.isAllowedHttpsPlaylive(origin) || this.isAllowedHttpsPlaylive(referer)) {
      return true;
    }

    throw new ForbiddenException({
      success: false,
      error: 'Bet placement is only allowed from allowed hosts',
      code: 'FORBIDDEN_ORIGIN',
    });
  }

  private isAllowedHttpsPlaylive(value: string | string[] | undefined): boolean {
    if (!value || Array.isArray(value)) return false;
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && u.hostname.toLowerCase() === ALLOWED_HOST;
    } catch {
      return false;
    }
  }
}
