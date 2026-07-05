import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { Repository } from 'typeorm';
import { AppConfig } from '../../config/configuration';
import { TenantMaster } from '../../database/entities/tenant-master.entity';
import { UserTenantMapping } from '../../database/entities/user-tenant-mapping.entity';
import { RedisService } from '../../redis/redis.service';
import { TenantOriginRegistryService } from '../../common/services/tenant-origin-registry.service';
import { assertPublicHttpsApiUrl } from '../../common/utils/ssrf-guard';
import { getByDotPath, setByDotPath } from '../../common/utils/dot-path';
import { parseDurationToSeconds } from '../../common/utils/duration';
import {
  extractKnownRegisterFields,
} from './dto/known-register-fields.dto';
import { extractKnownLoginFields } from './dto/known-login-fields.dto';
import { extractKnownGoogleFields } from './dto/known-google-fields.dto';
import {
  MiddlewareJwtPayload,
  RefreshJwtPayload,
  RefreshRecord,
  SessionRecord,
} from './jwt-payload.interface';

export interface UpstreamResponse {
  status: number;
  body: unknown;
}

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class AuthService {
  private readonly googleClient = new OAuth2Client();

  constructor(
    @InjectRepository(TenantMaster)
    private readonly tenantRepo: Repository<TenantMaster>,
    @InjectRepository(UserTenantMapping)
    private readonly mappingRepo: Repository<UserTenantMapping>,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly jwtService: JwtService,
    private readonly redisService: RedisService,
    private readonly originRegistry: TenantOriginRegistryService,
  ) {}

  private async postJson(url: string, body: unknown): Promise<UpstreamResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsedBody: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }
    return { status: response.status, body: parsedBody };
  }

  private async findOrCreateTenant(
    tenantCode: string,
    tenantName: string | undefined,
    apiUrl: string | undefined,
    frontendUrl: string | undefined,
  ): Promise<TenantMaster> {
    const existing = await this.tenantRepo.findOne({ where: { tenantCode } });
    if (existing) {
      return existing;
    }

    if (!tenantName || !apiUrl) {
      throw new BadRequestException(
        'tenantName and apiUrl are required when registering the first user of a new tenant',
      );
    }

    const ssrfConfig = this.configService.get('ssrf', { infer: true });
    await assertPublicHttpsApiUrl(apiUrl, ssrfConfig.allowPrivateApiUrls);

    try {
      const tenant = await this.tenantRepo.save(
        this.tenantRepo.create({ tenantName, tenantCode, apiUrl, frontendUrl: frontendUrl ?? null }),
      );
      if (frontendUrl) this.originRegistry.add(frontendUrl);
      return tenant;
    } catch (error) {
      const isUniqueViolation =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === UNIQUE_VIOLATION;
      if (isUniqueViolation) {
        // Lost a race to another concurrent registration for the same tenantCode.
        const winner = await this.tenantRepo.findOne({ where: { tenantCode } });
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  // Preserves the upstream response envelope (e.g. { success, message, data:
  // { user, accessToken } }) so clients written against the main service's own
  // response shape keep working unmodified — only the token value(s) at the
  // configured dot-path(s) are overwritten with the middleware's own session
  // tokens. Deep-cloned since upstream.body may be reused by the caller.
  private swapTokensIntoUpstreamBody(
    upstreamBody: unknown,
    intercept: AppConfig['intercept'],
    session: { accessToken: string; refreshToken: string },
  ): unknown {
    const body: Record<string, unknown> =
      upstreamBody !== null && typeof upstreamBody === 'object' && !Array.isArray(upstreamBody)
        ? (JSON.parse(JSON.stringify(upstreamBody)) as Record<string, unknown>)
        : {};
    setByDotPath(body, intercept.upstreamTokenPath, session.accessToken);
    if (intercept.upstreamRefreshTokenPath) {
      setByDotPath(body, intercept.upstreamRefreshTokenPath, session.refreshToken);
    }
    return body;
  }

  private buildForwardedBody(
    rawBody: Record<string, unknown>,
    tenantCode: string,
  ): Record<string, unknown> {
    const intercept = this.configService.get('intercept', { infer: true });
    const forwarded = { ...rawBody };
    delete forwarded[intercept.tenantNameField];
    delete forwarded[intercept.apiUrlField];
    delete forwarded[intercept.frontendUrlField];
    delete forwarded[intercept.tenantCodeField];

    if (intercept.forwardTenantCodeAs) {
      forwarded[intercept.forwardTenantCodeAs] = tenantCode;
    }

    return forwarded;
  }

  async register(rawBody: Record<string, unknown>): Promise<UpstreamResponse> {
    const intercept = this.configService.get('intercept', { infer: true });
    const fields = extractKnownRegisterFields(rawBody, intercept);

    const tenant = await this.findOrCreateTenant(
      fields.tenantCode,
      fields.tenantName,
      fields.apiUrl,
      fields.frontendUrl,
    );

    await this.mappingRepo
      .createQueryBuilder()
      .insert()
      .into(UserTenantMapping)
      .values({ username: fields.username, tenantId: tenant.id })
      .orIgnore()
      .execute();

    const forwardedBody = this.buildForwardedBody(rawBody, tenant.tenantCode);
    const upstream = await this.postJson(`${tenant.apiUrl}${intercept.registerPath}`, forwardedBody);

    if (upstream.status < 200 || upstream.status >= 300) {
      return upstream;
    }

    // Some main services auto-log-in on register and return tokens in the same
    // response (see IMPLEMENTATION_PLAN.md "Registration Flow"). Those are the
    // main service's OWN tokens, not a middleware session — swap them for one,
    // exactly as login() does, so the client never ends up holding a raw
    // upstream token it can't use against the proxy. If the main service
    // doesn't return tokens on register, there's nothing to swap; return the
    // response as-is (original documented behavior).
    const upstreamToken = getByDotPath(upstream.body, intercept.upstreamTokenPath);
    if (typeof upstreamToken !== 'string' || upstreamToken.length === 0) {
      return upstream;
    }

    const mapping = await this.mappingRepo.findOne({ where: { username: fields.username } });
    if (!mapping) {
      // Unreachable in practice — the row was just inserted (or already
      // existed) above — but fail safe rather than null-deref.
      return upstream;
    }

    const upstreamRefreshToken = getByDotPath(upstream.body, intercept.upstreamRefreshTokenPath);
    const session = await this.issueSession(
      mapping,
      tenant,
      upstreamToken,
      typeof upstreamRefreshToken === 'string' ? upstreamRefreshToken : undefined,
    );
    return { status: upstream.status, body: this.swapTokensIntoUpstreamBody(upstream.body, intercept, session) };
  }

  async login(rawBody: Record<string, unknown>): Promise<UpstreamResponse> {
    const intercept = this.configService.get('intercept', { infer: true });
    const fields = extractKnownLoginFields(rawBody, intercept);

    const mapping = await this.mappingRepo.findOne({
      where: { username: fields.username, isActive: true },
      relations: ['tenant'],
    });

    if (!mapping || !mapping.tenant.isActive) {
      throw new UnauthorizedException('User not registered via this gateway');
    }

    const forwardedBody: Record<string, unknown> = {
      [intercept.usernameField]: fields.username,
      password: fields.password,
    };
    if (intercept.forwardTenantCodeAs) {
      forwardedBody[intercept.forwardTenantCodeAs] = mapping.tenant.tenantCode;
    }

    const upstream = await this.postJson(
      `${mapping.tenant.apiUrl}${intercept.loginPath}`,
      forwardedBody,
    );

    if (upstream.status < 200 || upstream.status >= 300) {
      // Surface the main service's own auth failure (wrong password, locked
      // account, etc.) to the client as-is rather than masking it as a 401.
      return upstream;
    }

    const upstreamToken = getByDotPath(upstream.body, intercept.upstreamTokenPath);
    if (typeof upstreamToken !== 'string' || upstreamToken.length === 0) {
      throw new Error(
        `Upstream login response did not contain a token at path "${intercept.upstreamTokenPath}"`,
      );
    }
    const upstreamRefreshToken = getByDotPath(upstream.body, intercept.upstreamRefreshTokenPath);

    const session = await this.issueSession(
      mapping,
      mapping.tenant,
      upstreamToken,
      typeof upstreamRefreshToken === 'string' ? upstreamRefreshToken : undefined,
    );
    return { status: 200, body: this.swapTokensIntoUpstreamBody(upstream.body, intercept, session) };
  }

  // Verifies a Google ID token, resolves it to a tenant, forwards it to the
  // main service's own POST {apiUrl}{GOOGLE_PATH} (which independently
  // re-verifies the token — this middleware's verification alone isn't
  // trusted as an auth bypass into the main service), and mints a middleware
  // session exactly like login()/register() do. The mapping is upserted here
  // (not just looked up) because this may be the first time this middleware
  // has ever seen this email — a user who has only ever signed in with
  // Google has no prior /api/auth/register call to have created it.
  async loginWithGoogle(rawBody: Record<string, unknown>): Promise<UpstreamResponse> {
    const intercept = this.configService.get('intercept', { infer: true });
    const fields = extractKnownGoogleFields(rawBody, intercept);

    const google = this.configService.get('google', { infer: true });
    if (!google.clientId) {
      throw new BadRequestException(
        'Google Sign-In is not configured on this deployment (GOOGLE_CLIENT_ID unset).',
      );
    }

    let email: string;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: fields.idToken,
        audience: google.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email || payload.email_verified !== true) {
        throw new UnauthorizedException('Google account has no verified email');
      }
      email = payload.email;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid Google ID token');
    }

    const tenant = await this.tenantRepo.findOne({
      where: { tenantCode: fields.tenantCode, isActive: true },
    });
    if (!tenant) {
      throw new BadRequestException(`Unknown or inactive tenant "${fields.tenantCode}"`);
    }

    await this.mappingRepo
      .createQueryBuilder()
      .insert()
      .into(UserTenantMapping)
      .values({ username: email, tenantId: tenant.id })
      .orIgnore()
      .execute();

    const forwardedBody: Record<string, unknown> = { idToken: fields.idToken };
    if (intercept.forwardTenantCodeAs) {
      forwardedBody[intercept.forwardTenantCodeAs] = tenant.tenantCode;
    }

    const upstream = await this.postJson(`${tenant.apiUrl}${intercept.googlePath}`, forwardedBody);

    if (upstream.status < 200 || upstream.status >= 300) {
      // Surface the main service's own rejection (invalid token, pending
      // approval, suspended account, etc.) as-is rather than masking it.
      return upstream;
    }

    const upstreamToken = getByDotPath(upstream.body, intercept.upstreamTokenPath);
    if (typeof upstreamToken !== 'string' || upstreamToken.length === 0) {
      throw new Error(
        `Upstream Google login response did not contain a token at path "${intercept.upstreamTokenPath}"`,
      );
    }

    const mapping = await this.mappingRepo.findOne({ where: { username: email } });
    if (!mapping) {
      // Unreachable in practice — the row was just inserted (or already
      // existed) above — but fail safe rather than null-deref.
      return upstream;
    }

    const upstreamRefreshToken = getByDotPath(upstream.body, intercept.upstreamRefreshTokenPath);
    const session = await this.issueSession(
      mapping,
      tenant,
      upstreamToken,
      typeof upstreamRefreshToken === 'string' ? upstreamRefreshToken : undefined,
    );
    return { status: 200, body: this.swapTokensIntoUpstreamBody(upstream.body, intercept, session) };
  }

  private async issueSession(
    mapping: UserTenantMapping,
    tenant: TenantMaster,
    upstreamToken: string,
    upstreamRefreshToken: string | undefined,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const jwtConfig = this.configService.get('jwt', { infer: true });
    const jti = randomUUID();
    const refreshJti = randomUUID();

    const accessPayload: MiddlewareJwtPayload = {
      sub: mapping.id,
      username: mapping.username,
      tenantId: tenant.id,
      apiUrl: tenant.apiUrl,
      jti,
    };
    const refreshPayload: RefreshJwtPayload = { sub: mapping.id, refreshJti };

    const accessToken = this.jwtService.sign(accessPayload, {
      secret: jwtConfig.secret,
      expiresIn: jwtConfig.expiresIn,
      algorithm: 'HS256',
    });
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: jwtConfig.refreshSecret,
      expiresIn: jwtConfig.refreshExpiresIn,
      algorithm: 'HS256',
    });

    const session: SessionRecord = { apiUrl: tenant.apiUrl, upstreamToken };
    const refreshRecord: RefreshRecord = {
      userId: mapping.id,
      tenantId: tenant.id,
      upstreamRefreshToken,
    };

    await this.redisService.setJson(
      `session:${jti}`,
      session,
      parseDurationToSeconds(jwtConfig.expiresIn),
    );
    await this.redisService.setJson(
      `refresh:${refreshJti}`,
      refreshRecord,
      parseDurationToSeconds(jwtConfig.refreshExpiresIn),
    );

    return { accessToken, refreshToken };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const jwtConfig = this.configService.get('jwt', { infer: true });
    const intercept = this.configService.get('intercept', { infer: true });

    let payload: RefreshJwtPayload;
    try {
      payload = this.jwtService.verify<RefreshJwtPayload>(refreshToken, {
        secret: jwtConfig.refreshSecret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const record = await this.redisService.getJson<RefreshRecord>(
      `refresh:${payload.refreshJti}`,
    );
    if (!record) {
      throw new UnauthorizedException('Refresh session expired or revoked');
    }

    const mapping = await this.mappingRepo.findOne({
      where: { id: record.userId, isActive: true },
      relations: ['tenant'],
    });
    if (!mapping || !mapping.tenant.isActive) {
      throw new UnauthorizedException('User or tenant no longer active');
    }

    let upstreamToken: string;
    let upstreamRefreshToken = record.upstreamRefreshToken;

    if (intercept.upstreamRefreshPath && record.upstreamRefreshToken) {
      const upstream = await this.postJson(
        `${mapping.tenant.apiUrl}${intercept.upstreamRefreshPath}`,
        { refreshToken: record.upstreamRefreshToken },
      );
      if (upstream.status < 200 || upstream.status >= 300) {
        throw new UnauthorizedException('Upstream refresh rejected — please log in again');
      }
      const newToken = getByDotPath(upstream.body, intercept.upstreamTokenPath);
      if (typeof newToken !== 'string' || newToken.length === 0) {
        throw new Error(
          `Upstream refresh response did not contain a token at path "${intercept.upstreamTokenPath}"`,
        );
      }
      upstreamToken = newToken;
      const rotatedRefresh = getByDotPath(upstream.body, intercept.upstreamRefreshTokenPath);
      if (typeof rotatedRefresh === 'string' && rotatedRefresh.length > 0) {
        upstreamRefreshToken = rotatedRefresh;
      }
    } else {
      throw new UnauthorizedException(
        'This deployment has no upstream refresh mechanism configured — please log in again',
      );
    }

    // Rotate: drop the old refresh session before issuing a new one.
    await this.redisService.del(`refresh:${payload.refreshJti}`);

    return this.issueSession(mapping, mapping.tenant, upstreamToken, upstreamRefreshToken);
  }

  async logout(jti: string, refreshToken?: string): Promise<void> {
    const keys = [`session:${jti}`];

    if (refreshToken) {
      const jwtConfig = this.configService.get('jwt', { infer: true });
      try {
        const payload = this.jwtService.verify<RefreshJwtPayload>(refreshToken, {
          secret: jwtConfig.refreshSecret,
          algorithms: ['HS256'],
        });
        keys.push(`refresh:${payload.refreshJti}`);
      } catch {
        // Already invalid/expired — nothing to revoke, don't fail logout over it.
      }
    }

    await this.redisService.del(...keys);
  }

  async getUpstreamSession(jti: string): Promise<SessionRecord> {
    const session = await this.redisService.getJson<SessionRecord>(`session:${jti}`);
    if (!session) {
      throw new UnauthorizedException('Session expired or revoked');
    }
    return session;
  }
}
