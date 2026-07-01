import { Controller, Get } from '@nestjs/common';

@Controller('middleware/health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
