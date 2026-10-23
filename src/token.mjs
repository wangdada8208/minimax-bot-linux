// @ts-check
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** @param {string} expected @param {string | undefined} got */
export function tokenMatches(expected, got) {
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * Pulls the access token from the header, the cookie, or a one-time query
 * parameter. The query form exists so a browser can open the page once and
 * then keep the cookie.
 * @param {import('node:http').IncomingMessage} request
 * @param {URL} url
 */
export function presentedToken(request, url) {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = request.headers.cookie;
  if (typeof cookie === 'string') {
    const match = /(?:^|;\s*)minimax_bot=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return url.searchParams.get('token') ?? '';
}
