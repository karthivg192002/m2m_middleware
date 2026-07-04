import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import { NextFunction, Request, Response } from 'express';
import { AppConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';
import { MiddlewareJwtPayload, SessionRecord } from '../auth/jwt-payload.interface';

@Injectable()
export class ProxyMiddleware implements NestMiddleware {
  // One proxy agent per upstream target, reused across requests, instead of
  // constructing a new http-proxy-middleware instance on every call.
  private readonly proxiesByTarget = new Map<string, RequestHandler>();

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
  ) {}

  private getProxyFor(target: string): RequestHandler {
    const existing = this.proxiesByTarget.get(target);
    if (existing) {
      return existing;
    }
    const proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      xfwd: true, // append this hop to X-Forwarded-For so the main service can see the real client IP, not just this middleware's
      ws: false, // WebSocket/Socket.IO traffic is explicitly out of scope — see IMPLEMENTATION_PLAN.md
      proxyTimeout: 15_000,
      onError: (_err: Error, _req: Request, res: Response) => {
        res.status(502).json({ message: 'Upstream unavailable' });
      },
    });
    this.proxiesByTarget.set(target, proxy);
    return proxy;
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }
    const token = authHeader.slice('Bearer '.length);

    const jwtConfig = this.configService.get('jwt', { infer: true });
    let payload: MiddlewareJwtPayload;
    try {
      payload = this.jwtService.verify<MiddlewareJwtPayload>(token, {
        secret: jwtConfig.secret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const session = await this.redisService.getJson<SessionRecord>(`session:${payload.jti}`);
    if (!session) {
      throw new UnauthorizedException('Session expired or revoked');
    }

    req.headers['authorization'] = `Bearer ${session.upstreamToken}`;
    this.getProxyFor(session.apiUrl)(req, res, next);
  }
}
