import { BadRequestException } from '@nestjs/common';

// Field NAMES are env-configurable (USERNAME_FIELD, TENANT_CODE_FIELD, etc.),
// so a fixed class-validator DTO can't describe this shape generically. These
// are plain manual checks against whatever the configured field names resolve
// to on the raw body — the raw body itself is passed through untouched to the
// upstream main service (see IMPLEMENTATION_PLAN.md "Registration Flow"),
// which may require additional fields this middleware knows nothing about.
export interface KnownRegisterFields {
  username: string;
  password: string;
  tenantCode: string;
  tenantName?: string;
  apiUrl?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function extractKnownRegisterFields(
  body: Record<string, unknown>,
  fieldNames: {
    usernameField: string;
    tenantCodeField: string;
    tenantNameField: string;
    apiUrlField: string;
  },
): KnownRegisterFields {
  const username = body[fieldNames.usernameField];
  const password = body.password;
  const tenantCode = body[fieldNames.tenantCodeField];
  const tenantName = body[fieldNames.tenantNameField];
  const apiUrl = body[fieldNames.apiUrlField];

  if (typeof username !== 'string' || !EMAIL_RE.test(username)) {
    throw new BadRequestException(`${fieldNames.usernameField} must be a valid email address`);
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new BadRequestException('password must be a string of at least 8 characters');
  }
  if (typeof tenantCode !== 'string' || tenantCode.trim().length === 0) {
    throw new BadRequestException(`${fieldNames.tenantCodeField} is required`);
  }
  if (tenantName !== undefined && typeof tenantName !== 'string') {
    throw new BadRequestException(`${fieldNames.tenantNameField} must be a string`);
  }
  if (apiUrl !== undefined && typeof apiUrl !== 'string') {
    throw new BadRequestException(`${fieldNames.apiUrlField} must be a string`);
  }

  return {
    username,
    password,
    tenantCode: tenantCode.trim(),
    tenantName: tenantName as string | undefined,
    apiUrl: apiUrl as string | undefined,
  };
}
