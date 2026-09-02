import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_ALLOWED_HOSTS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'streamable.com',
  'twitch.tv',
  'dailymotion.com',
];

export interface RemoteVideoUrlPolicy {
  allowedHosts?: string[];
  resolveDns?: boolean;
}

/**
 * Validate a remote video URL before a worker passes it to a downloader.
 *
 * The default policy is intentionally an allowlist. A dotted hostname is not
 * evidence that a host is safe: accepting arbitrary domains creates an SSRF
 * primitive and permits unbounded downloader workloads. Operators can add
 * known domains with MOCAP_ALLOWED_URL_HOSTS (comma-separated).
 */
export async function validateRemoteVideoUrl(
  input: string,
  options: RemoteVideoUrlPolicy = {},
): Promise<URL> {
  const url = parseRemoteVideoUrl(input);
  const allowedHosts = options.allowedHosts ?? configuredAllowedHosts();
  if (!allowedHosts.some(host => hostMatches(url.hostname, host))) {
    throw new Error(`Unsupported video host: ${url.hostname}`);
  }

  const address = url.hostname;
  if (isPrivateAddress(address)) {
    throw new Error('Video URL resolves to a private or reserved network address.');
  }

  if (options.resolveDns !== false && !isIP(address)) {
    let records: { address: string; family: number }[];
    try {
      records = await lookup(address, { all: true, verbatim: true }) as { address: string; family: number }[];
    } catch {
      throw new Error('Video host could not be resolved.');
    }
    if (records.length === 0 || records.some(record => isPrivateAddress(record.address))) {
      throw new Error('Video URL resolves to a private or reserved network address.');
    }
  }
  return url;
}

/** Synchronous syntax and policy checks for callers that cannot await DNS. */
export function parseRemoteVideoUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Invalid video URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS video URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('Video URLs must not contain embedded credentials.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Video URL must use the standard HTTP or HTTPS port.');
  }
  if (!url.hostname || url.hostname.endsWith('.')) {
    throw new Error('Video URL has an invalid hostname.');
  }
  return url;
}

export function configuredAllowedHosts(): string[] {
  const configured = process.env.MOCAP_ALLOWED_URL_HOSTS
    ?.split(',')
    .map(host => host.trim().toLowerCase().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  return configured && configured.length > 0 ? configured : DEFAULT_ALLOWED_HOSTS;
}

function hostMatches(hostname: string, allowedHost: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const allowed = allowedHost.toLowerCase().replace(/^www\./, '').replace(/^\.+|\.+$/g, '');
  return host === allowed || host.endsWith(`.${allowed}`);
}

/** Reject RFC1918, loopback, link-local, documentation, multicast, and IPv6 local ranges. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const value = ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
    const inRange = (start: number, end: number) => value >= start && value <= end;
    return inRange(0x00000000, 0x00ffffff) // 0.0.0.0/8
      || inRange(0x0a000000, 0x0affffff) // 10.0.0.0/8
      || inRange(0x64400000, 0x647fffff) // 100.64.0.0/10
      || inRange(0x7f000000, 0x7fffffff) // 127.0.0.0/8
      || inRange(0xa9fe0000, 0xa9feffff) // 169.254.0.0/16
      || inRange(0xac100000, 0xac1fffff) // 172.16.0.0/12
      || inRange(0xc0000000, 0xc00000ff) // 192.0.0.0/24
      || inRange(0xc0000200, 0xc00002ff) // 192.0.2.0/24
      || inRange(0xc0a80000, 0xc0a8ffff) // 192.168.0.0/16
      || inRange(0xc6120000, 0xc613ffff) // 198.18.0.0/15
      || inRange(0xc6336400, 0xc63364ff) // 198.51.100.0/24
      || inRange(0xcb007100, 0xcb0071ff) // 203.0.113.0/24
      || octets[0] >= 224; // multicast/reserved
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/);
    if (mappedIpv4) return isPrivateAddress(mappedIpv4[1]);
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('2001:db8')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:172.16.')
      || normalized.startsWith('::ffff:192.168.');
  }
  return false;
}
