import {
  BadGatewayException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';

// Any error that isn't already a deliberate HttpException (validation errors,
// 401s, etc.) is assumed to be a failure talking to the tenant's main service —
// network failure, DNS failure, connection refused. We must not leak that raw
// error (stack trace, internal hostname, connection details) to the client.
@Injectable()
export class UpstreamErrorInterceptor implements NestInterceptor {
  private readonly logger = new Logger('UpstreamError');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof HttpException) {
          return throwError(() => error);
        }
        this.logger.error('Upstream call failed', error instanceof Error ? error.stack : error);
        return throwError(() => new BadGatewayException('Upstream unavailable'));
      }),
    );
  }
}
