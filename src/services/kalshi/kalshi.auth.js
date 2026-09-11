import 'server-only';
import { constants, createHash, createPrivateKey, sign } from 'node:crypto';
import { KalshiDataError } from './kalshi.validation';
import { getKalshiReadResource } from './rateLimit/rateLimit.policy';

export function hasKalshiCredentials(environment = process.env) {
  return Boolean(environment.KALSHI_API_KEY_ID && environment.KALSHI_PRIVATE_KEY);
}

export function getKalshiCredentialFingerprint(environment = process.env) {
  if (!hasKalshiCredentials(environment)) return 'public';
  return createHash('sha256')
    .update(environment.KALSHI_API_KEY_ID)
    .update('\0')
    .update(environment.KALSHI_PRIVATE_KEY)
    .digest('hex');
}

export function createKalshiReadHeaders(path, environment = process.env, now = Date.now()) {
  const resource = getKalshiReadResource(path);
  if (!hasKalshiCredentials(environment)) {
    throw new KalshiDataError('Configure server-side Kalshi credentials for BRTI access.', 503);
  }
  // Only the explicit data/limit allowlist can be signed. The method is always GET.
  try {
    const key = createPrivateKey(environment.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid key type.');
    const timestamp = String(now);
    const signature = sign('sha256', Buffer.from(`${timestamp}GET/trade-api/v2${resource.path}`), {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return {
      'KALSHI-ACCESS-KEY': environment.KALSHI_API_KEY_ID,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    };
  } catch {
    throw new KalshiDataError('The server-side Kalshi signing key is invalid.', 503);
  }
}
