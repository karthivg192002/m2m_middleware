import { BadRequestException } from '@nestjs/common';
import { promises as dns } from 'dns';
import { isIP } from 'net';

// Blocks loopback, private, link-local (incl. cloud metadata 169.254.169.254),
// and other non-globally-routable ranges. apiUrl is persisted per tenant and
// reused for every future login, so this must be enforced at registration time,
// not just validated as a well-formed URL.
function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);

  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true; // "this" network
    if (a >= 224) return true; // multicast/reserved
    return false;
  }

  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 — re-check the embedded IPv4 address
      return isPrivateOrReservedIp(normalized.replace('::ffff:', ''));
    }
    return false;
  }

  return true; // couldn't parse as an IP — treat unknown as unsafe
}

export async function assertPublicHttpsApiUrl(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('apiUrl must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:' && !allowPrivate) {
    throw new BadRequestException('apiUrl must use https://');
  }

  if (allowPrivate) {
    return; // dev-only escape hatch; never allowed in production (see configuration.ts)
  }

  const hostname = parsed.hostname;

  if (hostname === 'localhost') {
    throw new BadRequestException('apiUrl may not point at localhost');
  }

  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses = records.map((record) => record.address);
    } catch {
      throw new BadRequestException(`apiUrl hostname could not be resolved: ${hostname}`);
    }
  }

  if (addresses.length === 0 || addresses.some((address) => isPrivateOrReservedIp(address))) {
    throw new BadRequestException(
      'apiUrl resolves to a private, loopback, or link-local address, which is not allowed',
    );
  }
}
