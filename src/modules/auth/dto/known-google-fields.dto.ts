import { BadRequestException } from '@nestjs/common';

export interface KnownGoogleFields {
  idToken: string;
  tenantCode: string;
}

// tenantCode is required here (unlike login) because a Google ID token proves
// *identity* (this is really you@gmail.com) but carries no tenant context —
// the client must still say which tenant it's signing into, the same as any
// other multi-tenant entry point into this gateway.
export function extractKnownGoogleFields(body: Record<string, unknown>): KnownGoogleFields {
  const idToken = body.idToken;
  const tenantCode = body.tenantCode;

  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new BadRequestException('idToken is required');
  }
  if (typeof tenantCode !== 'string' || tenantCode.trim().length === 0) {
    throw new BadRequestException('tenantCode is required');
  }

  return { idToken, tenantCode: tenantCode.trim() };
}
