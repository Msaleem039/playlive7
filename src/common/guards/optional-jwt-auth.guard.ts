import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(OptionalJwtAuthGuard.name);

  // Override handleRequest to allow requests without token
  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    // If there's an error or info, log it in debug mode only (optional guard shouldn't spam logs)
    if (err || info) {
      const errorMessage = err?.message || info?.message || String(info);
      
      // Only log actual errors, not missing tokens (which is expected for optional guard)
      if (errorMessage && !errorMessage.includes('No auth token')) {
        this.logger.debug(`Optional JWT validation issue for ${request.url}: ${errorMessage}`);
      }
    }

    // If there's no token or token is invalid, return null instead of throwing error
    // The service will handle the authentication requirement based on the role
    return user || null;
  }
}



