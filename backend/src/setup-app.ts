import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ErrorsFilter } from './common/errors.filter';

/** Réglages communs à l'application réelle et aux tests de bout en bout. */
export function setupApp(app: INestApplication): void {
  (app as NestExpressApplication).useBodyParser('json', { limit: '5mb' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ErrorsFilter());
  app.enableShutdownHooks();
}
