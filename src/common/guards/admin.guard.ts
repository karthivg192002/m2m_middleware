import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { Request } from 'express';
import { AppConfig } from '../../config/configuration';

// Bootstrap admin auth: HTTP Basic against a single admin identity whose
// password is stored as a bcrypt hash (never plaintext) in ADMIN_PASSWORD_HASH.
// Rate-limited identically to /auth/login (see ThrottlerGuard on TenantController).
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Basic ')) {
      throw new UnauthorizedException('Admin credentials required');
    }

    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      throw new UnauthorizedException('Malformed admin credentials');
    }

    const email = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    const adminConfig = this.configService.get('admin', { infer: true });

    if (email !== adminConfig.email) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    const matches = await bcrypt.compare(password, adminConfig.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    return true;
  }
}
