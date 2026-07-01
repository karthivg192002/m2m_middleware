import {
  Body,
  Controller,
  Post,
  Get,
  UseGuards,
  UseInterceptors,
  Res,
  HttpCode,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MiddlewareJwtPayload } from './jwt-payload.interface';
import { UpstreamErrorInterceptor } from '../../common/interceptors/upstream-error.interceptor';

// register/login are the middleware's own fixed client-facing contract — the
// client always calls THIS middleware at /auth/register and /auth/login,
// regardless of what path the upstream main service actually uses internally.
// REGISTER_PATH/LOGIN_PATH (env) control only the upstream forwarding target;
// see IMPLEMENTATION_PLAN.md "Registration Flow" / "Login Flow".
//
// @Body() is typed as a plain Record, not a class DTO — this is deliberate.
// NestJS's global ValidationPipe skips whitelisting for non-class (Object)
// metatypes, which is exactly what's needed here: known middleware fields are
// validated manually (see dto/known-*-fields.dto.ts) while the rest of the
// body passes through untouched to the upstream main service.
@Controller()
@UseInterceptors(UpstreamErrorInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('auth/register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async register(
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = await this.authService.register(body);
    res.status(upstream.status).json(upstream.body);
  }

  @Post('auth/login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async login(@Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const result = await this.authService.login(body);
    if ('accessToken' in result) {
      res.status(200).json(result);
      return;
    }
    res.status(result.status).json(result.body);
  }

  @Post('middleware/auth/refresh')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('middleware/auth/logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async logout(
    @CurrentUser() user: MiddlewareJwtPayload,
    @Body() dto: LogoutDto,
  ): Promise<void> {
    await this.authService.logout(user.jti, dto.refreshToken);
  }

  @Get('middleware/auth/upstream-session')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async upstreamSession(
    @CurrentUser() user: MiddlewareJwtPayload,
  ): Promise<{ apiUrl: string; upstreamToken: string }> {
    return this.authService.getUpstreamSession(user.jti);
  }
}
