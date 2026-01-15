import { Injectable, ExecutionContext, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { UnauthorizedException } from '@nestjs/common';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    
    // Check for internal service token (for service-to-service calls)
    const internalToken = request.headers['x-internal-service-token'];
    const expectedInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    
    if (internalToken && expectedInternalToken && internalToken === expectedInternalToken) {
      // Internal service call - bypass JWT validation
      this.logger.debug('Internal service call detected - bypassing JWT validation');
      return true;
    }

    // Check if request is from localhost/internal (for cron jobs and background services)
    const isInternalRequest = 
      request.ip === '127.0.0.1' || 
      request.ip === '::1' || 
      request.ip === '::ffff:127.0.0.1' ||
      request.hostname === 'localhost' ||
      request.headers['x-forwarded-for']?.includes('127.0.0.1');

    // For internal requests without token, check if it's a known internal endpoint
    const isInternalEndpoint = request.url?.startsWith('/cricketid/') || 
                               request.url?.startsWith('/health') ||
                               request.url?.startsWith('/metrics');

    if (isInternalRequest && isInternalEndpoint && !request.headers.authorization) {
      this.logger.debug(`Internal request to ${request.url} without JWT - allowing (internal endpoint)`);
      return true;
    }

    // Standard JWT validation
    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();

    // If there's an error or info, log it with context
    if (err || info) {
      const errorMessage = err?.message || info?.message || String(info);
      const errorName = err?.name || info?.name || 'Unknown';
      
      // Log token errors with context (but not sensitive data)
      if (errorMessage.includes('expired')) {
        this.logger.warn(`JWT token expired for request to ${request.url}`);
      } else if (errorMessage.includes('malformed') || errorMessage.includes('invalid')) {
        this.logger.warn(`JWT token malformed/invalid for request to ${request.url}`);
      } else if (errorMessage.includes('No auth token')) {
        this.logger.debug(`No JWT token provided for request to ${request.url}`);
      } else {
        this.logger.warn(`JWT validation error (${errorName}): ${errorMessage} for request to ${request.url}`);
      }
    }

    // If user is present, authentication succeeded
    if (user) {
      return user;
    }

    // No user and no specific error - token missing or invalid
    if (!err && !info) {
      throw new UnauthorizedException('Authentication required');
    }

    // Re-throw the error from passport
    throw err || new UnauthorizedException('Invalid or expired token');
  }
}
