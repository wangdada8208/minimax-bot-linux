import assert from 'node:assert/strict';
import test from 'node:test';
import { presentedToken, tokenMatches } from '../src/token.mjs';

test('accepts the token from a bearer header, cookie, or query', () => {
  const url = new URL('http://bot.local/bot?token=from-query');
  assert.equal(presentedToken({ headers: { authorization: 'Bearer from-header' } }, url), 'from-header');
  assert.equal(presentedToken({ headers: { cookie: 'other=1; minimax_bot=from-cookie' } }, url), 'from-cookie');
  assert.equal(presentedToken({ headers: {} }, url), 'from-query');
});

test('compares tokens without treating a different length as equal', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('abc', ''), false);
});
