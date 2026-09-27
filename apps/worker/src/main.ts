import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

/**
 * Headless Nest process: an application context, not an HTTP server.
 * A minimal /health listener is added alongside it by a later pass so the
 * orchestrator has something to probe.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  // Drain in-flight jobs on SIGTERM rather than truncating a payment handler.
  app.enableShutdownHooks();
}

void bootstrap();
