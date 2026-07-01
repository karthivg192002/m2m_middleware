import { BadRequestException } from '@nestjs/common';

export interface KnownLoginFields {
  username: string;
  password: string;
}

export function extractKnownLoginFields(
  body: Record<string, unknown>,
  fieldNames: { usernameField: string },
): KnownLoginFields {
  const username = body[fieldNames.usernameField];
  const password = body.password;

  if (typeof username !== 'string' || username.trim().length === 0) {
    throw new BadRequestException(`${fieldNames.usernameField} is required`);
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequestException('password is required');
  }

  return { username: username.trim(), password };
}
