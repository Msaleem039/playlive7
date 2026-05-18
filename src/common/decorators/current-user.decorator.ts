import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtAuthUser } from '../../auth/types/jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): JwtAuthUser | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.user ?? null;
  },
);
