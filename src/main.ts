import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compression from '@fastify/compress';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
dotenv.config();

async function bootstrap() {
  // OPTIMIZED: Use Fastify adapter for better performance (2-3x faster than Express)
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: process.env.NODE_ENV === 'development',
    }),
  );
  
  // OPTIMIZED: Enable response compression (reduces response size by 70-90%)
  await app.register(compression, {
    encodings: ['gzip', 'deflate'],
  });

  // Enable multipart/form-data support for file uploads
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB max file size
    },
  });
  
  // CORS configuration - environment aware
  // ✅ Use Fastify CORS plugin for better compatibility with Fastify
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : ['*'];

  const isWildcard = allowedOrigins.includes('*');

  const isPlaylive24Host = (hostname: string) =>
    hostname === 'playlive24.com' || hostname.endsWith('.playlive24.com');

  await app.register(cors, {
    origin: isWildcard
      ? true
      : (origin, cb) => {
          if (!origin) {
            return cb(null, true);
          }
          if (allowedOrigins.includes(origin)) {
            return cb(null, true);
          }
          try {
            const originHost = new URL(origin).hostname.toLowerCase();
            // Any *.playlive24.com frontend may call API subdomains (www, aws, api, …)
            const allowsPlayliveFamily = allowedOrigins.some((allowed) => {
              try {
                const allowedHost = new URL(allowed).hostname.toLowerCase();
                return isPlaylive24Host(allowedHost);
              } catch {
                return false;
              }
            });
            if (allowsPlayliveFamily && isPlaylive24Host(originHost)) {
              return cb(null, true);
            }
            const isAllowed = allowedOrigins.some((allowed) => {
              try {
                const allowedHost = new URL(allowed).hostname.toLowerCase();
                return (
                  originHost === allowedHost ||
                  originHost.endsWith('.' + allowedHost)
                );
              } catch {
                return false;
              }
            });
            return cb(null, isAllowed);
          } catch {
            return cb(null, false);
          }
        },
    credentials: !isWildcard, // Can't use credentials with wildcard
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 
      'Authorization', 
      'Accept', 
      'X-Requested-With',
      'Origin',
      'Access-Control-Request-Method',
      'Access-Control-Request-Headers',
      'Content-Length',
    ],
    exposedHeaders: ['Content-Type', 'Authorization'],
    preflight: true,
    strictPreflight: false,
    maxAge: 86400, // 24 hours
  });
  
  // Enable validation pipes globally
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  }));

  // Set security headers using Fastify hooks
  app.getHttpAdapter().getInstance().addHook('onSend', async (request, reply) => {
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
  console.log(`Application is running on: http://localhost:${process.env.PORT ?? 3000}`);
  console.log(`CORS enabled for origins: ${allowedOrigins.join(', ')}`);
  console.log(`Fastify adapter enabled for improved performance`);
}
bootstrap();
