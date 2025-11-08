import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.user ?? null;
  },
);
