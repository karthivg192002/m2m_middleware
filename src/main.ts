import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config/configuration';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService<AppConfig, true>);

  // Must be set before anything reads req.ip (throttler, logging) — trusts
  // exactly N hops of X-Forwarded-For, matching TRUST_PROXY_HOPS.
  app.set('trust proxy', configService.get('trustProxyHops', { infer: true }));

  app.use(helmet());

  const corsOrigins = configService.get('corsOrigins', { infer: true });
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  });

  // Bound ahead of the proxy middleware to cap request size — proxy-abuse/DoS
  // guard. Raise per-route only where genuine file-upload pass-through needs it.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = configService.get('port', { infer: true });
  await app.listen(port);
}

bootstrap();
