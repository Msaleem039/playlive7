import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Override handleRequest to allow requests without token
  handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
    // If there's no token or token is invalid, return null instead of throwing error
    // The service will handle the authentication requirement based on the role
    return user || null;
  }
}



