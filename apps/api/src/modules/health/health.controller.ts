import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { HealthResponse } from "@akai/contracts";
import { Public } from "../../common/decorators/public.decorator";
import { HealthService } from "./health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * LIVENESS. Answers "is this process running?" and nothing else.
   *
   * Deliberately checks NO dependencies. If liveness probed the database, a
   * brief database blip would make the orchestrator kill and restart every API
   * pod — turning a recoverable dependency outage into a full outage with a
   * thundering-herd reconnect on the other side.
   */
  @Public()
  @Get("live")
  @ApiOperation({ summary: "Liveness probe — process is up. Checks no dependencies." })
  live(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * READINESS. Answers "should traffic be routed here?" and therefore DOES
   * check real dependencies. Returns 200 with `status: "error"` rather than a
   * non-200, so the probe result is machine-readable either way; the
   * orchestrator is configured to treat a non-"ok" body as not-ready.
   */
  @Public()
  @Get("ready")
  @ApiOperation({ summary: "Readiness probe — dependencies reachable" })
  async ready(): Promise<HealthResponse> {
    return this.health.readiness();
  }
}
