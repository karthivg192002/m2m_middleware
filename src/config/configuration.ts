export interface AppConfig {
  port: number;
  nodeEnv: string;
  corsOrigins: string[];
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  redis: {
    host: string;
    port: number;
  };
  jwt: {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  intercept: {
    registerPath: string;
    loginPath: string;
    upstreamRefreshPath: string;
    usernameField: string;
    tenantCodeField: string;
    tenantNameField: string;
    apiUrlField: string;
    forwardTenantCodeAs: string | null;
    upstreamTokenPath: string;
    upstreamRefreshTokenPath: string;
  };
  ssrf: {
    allowPrivateApiUrls: boolean;
  };
  admin: {
    email: string;
    passwordHash: string;
  };
  google: {
    clientId: string | null;
  };
}

// Values that ship in .env.example — booting in production with any of these
// still set is almost certainly a misconfiguration, not an intentional choice.
const PLACEHOLDER_SECRETS: Record<string, string> = {
  JWT_SECRET: 'change_me',
  JWT_REFRESH_SECRET: 'another_secret',
  DB_PASSWORD: 'password',
  ADMIN_PASSWORD_HASH: '$2b$12$replace_with_a_real_bcrypt_hash',
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function assertNotPlaceholderInProduction(nodeEnv: string): void {
  if (nodeEnv !== 'production') {
    return;
  }
  const offenders = Object.entries(PLACEHOLDER_SECRETS).filter(
    ([name, placeholder]) => process.env[name] === placeholder,
  );
  if (offenders.length > 0) {
    const names = offenders.map(([name]) => name).join(', ');
    throw new Error(
      `Refusing to start in production with placeholder value(s) for: ${names}. ` +
        'Set real, unique secrets for every deployment.',
    );
  }
  if (process.env.ALLOW_PRIVATE_API_URLS === 'true') {
    throw new Error(
      'Refusing to start in production with ALLOW_PRIVATE_API_URLS=true — this disables the SSRF guard on tenant apiUrl registration.',
    );
  }
}

export default (): AppConfig => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  assertNotPlaceholderInProduction(nodeEnv);

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv,
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    db: {
      host: requireEnv('DB_HOST'),
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      name: requireEnv('DB_NAME'),
      user: requireEnv('DB_USER'),
      password: requireEnv('DB_PASSWORD'),
    },
    redis: {
      host: requireEnv('REDIS_HOST'),
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    },
    jwt: {
      secret: requireEnv('JWT_SECRET'),
      expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
      refreshSecret: requireEnv('JWT_REFRESH_SECRET'),
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    },
    intercept: {
      registerPath: process.env.REGISTER_PATH ?? '/auth/register',
      loginPath: process.env.LOGIN_PATH ?? '/auth/login',
      upstreamRefreshPath: process.env.UPSTREAM_REFRESH_PATH ?? '',
      usernameField: process.env.USERNAME_FIELD ?? 'email',
      tenantCodeField: process.env.TENANT_CODE_FIELD ?? 'tenantCode',
      tenantNameField: process.env.TENANT_NAME_FIELD ?? 'tenantName',
      apiUrlField: process.env.API_URL_FIELD ?? 'apiUrl',
      forwardTenantCodeAs: process.env.FORWARD_TENANT_CODE_AS || null,
      upstreamTokenPath: process.env.UPSTREAM_TOKEN_PATH ?? 'accessToken',
      upstreamRefreshTokenPath:
        process.env.UPSTREAM_REFRESH_TOKEN_PATH ?? 'refreshToken',
    },
    ssrf: {
      allowPrivateApiUrls: process.env.ALLOW_PRIVATE_API_URLS === 'true',
    },
    admin: {
      email: requireEnv('ADMIN_EMAIL'),
      passwordHash: requireEnv('ADMIN_PASSWORD_HASH'),
    },
    google: {
      // Optional: unset means Google Sign-In is disabled (endpoint returns 501).
      clientId: process.env.GOOGLE_CLIENT_ID || null,
    },
  };
};
