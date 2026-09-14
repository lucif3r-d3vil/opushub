// Test helper — the throwaway administrator + session cookie that API tests authenticate with.
//
// OpusHub's API requires a session (phase 4), including in tests: the tests exercise the same
// door production uses rather than a bypass flag, so an accidentally-public route fails a test
// instead of shipping. The caller must point OPUSHUB_DATA_DIR at a scratch directory first.
import * as auth from '../server/auth.js';

export const TEST_USER = { username: 'fixture-admin', password: 'fixture-password-42' };

/** Create the test account (idempotent) and return a `Cookie:` header value for it. */
export async function seedSession(user = TEST_USER) {
  if (!auth.getSetupState().hasAccount) await auth.createAdmin(user);
  const session = auth.createSession({ username: user.username, ip: '127.0.0.1' });
  return `${auth.SESSION_COOKIE}=${session.id}`;
}

/** A `fetch`-style headers object for a session cookie. */
export const cookieHeaders = (cookie) => ({ cookie });
