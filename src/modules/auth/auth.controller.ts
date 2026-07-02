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
import { extractKnownGoogleFields } from './dto/known-google-fields.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MiddlewareJwtPayload } from './jwt-payload.interface';
import { UpstreamErrorInterceptor } from '../../common/interceptors/upstream-error.interceptor';

// register/login are the middleware's own fixed client-facing contract — the
// client always calls THIS middleware at /api/auth/register and /api/auth/login
// (the "/api" prefix matches this deployment's frontends, which already call
// their main service at /api/auth/*), regardless of what path the upstream
// main service actually uses internally. REGISTER_PATH/LOGIN_PATH (env)
// control only the upstream forwarding target; see IMPLEMENTATION_PLAN.md
// "Registration Flow" / "Login Flow".
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

  @Post('api/auth/register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async register(
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = await this.authService.register(body);
    res.status(upstream.status).json(upstream.body);
  }

  @Post('api/auth/login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  async login(@Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const result = await this.authService.login(body);
    res.status(result.status).json(result.body);
  }

  // Compat alias for frontends already written against the main service's own
  // POST /api/auth/refresh-token contract (response wrapped in { data: {...} },
  // matching sendSuccess() envelopes) — same underlying refresh logic as
  // POST /middleware/auth/refresh below, just reshaped so those clients don't
  // need any code change beyond the base URL. See GOOGLE_SIGNIN_AND_MIDDLEWARE_INTEGRATION.md.
  @Post('api/auth/refresh-token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  async refreshCompat(@Body() dto: RefreshDto): Promise<{ success: true; message: string; data: { accessToken: string; refreshToken: string } }> {
    const session = await this.authService.refresh(dto.refreshToken);
    return { success: true, message: 'Token refreshed successfully', data: session };
  }

  // Verify-only for now — see AuthService.loginWithGoogle() and
  // GOOGLE_SIGNIN_AND_MIDDLEWARE_INTEGRATION.md. Returns 501 until the main
  // service exposes an endpoint to issue a session for a pre-verified identity.
  @Post('api/auth/google')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  async google(@Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const { idToken, tenantCode } = extractKnownGoogleFields(body);
    const result = await this.authService.loginWithGoogle(idToken, tenantCode);
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
