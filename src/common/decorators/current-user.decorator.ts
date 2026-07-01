import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { MiddlewareJwtPayload } from '../../modules/auth/jwt-payload.interface';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MiddlewareJwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as MiddlewareJwtPayload;
  },
);
