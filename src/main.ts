import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable validation pipes globally
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
  }));

  // CORS configuration - environment aware
  const allowedOrigins = process.env.CORS_ORIGINS 
    ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
    : ['*'];
  
  const corsOptions = {
    origin: allowedOrigins.includes('*') ? true : allowedOrigins,
    credentials: allowedOrigins.includes('*') ? false : true, // Can't use credentials with wildcard
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Type', 'Authorization'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  };

  app.enableCors(corsOptions);

  // Set security headers
  app.use((req, res, next) => {
    // Referrer Policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // X-Content-Type-Options
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // X-Frame-Options
    res.setHeader('X-Frame-Options', 'DENY');
    // X-XSS-Protection
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  await app.listen(process.env.PORT ?? 3000);
  console.log(`Application is running on: http://localhost:${process.env.PORT ?? 3000}`);
  console.log(`CORS enabled for origins: ${allowedOrigins.join(', ')}`);
}
bootstrap();
