import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { setupApp } from './setup-app';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({ config }), { bodyParser: true });
  setupApp(app);
  await app.listen(config.port);
  console.log(`API Platform back-end prêt sur le port ${config.port} (passerelle ${config.apisix.environment})`);
}

void bootstrap();
