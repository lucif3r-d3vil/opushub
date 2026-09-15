// Structured error model — every failure state the UI renders has a stable `code`.
//
//   docker_unavailable   the engine cannot be reached (socket missing / daemon down)
//   provider_timeout     a provider did not answer within its budget
//   access_denied        OpusHub lacks permission for the provider
//   not_available        the provider does not expose this information
//   not_checked          no probe was attempted (no URL, or probing disabled for this source)
//   bad_gateway          a probe reached something that is not the expected service
//
// Responses carry { status, code, reason } — `reason` is public-safe prose, `code` is what the
// UI switches on. Generic \"Failed to fetch\" states are a client fallback, never the API's answer.
export const ERROR_CODES = {
  docker_unavailable: 'OpusHub cannot currently communicate with Docker.',
  provider_timeout: 'The provider did not respond within the allowed time.',
  access_denied: 'OpusHub cannot access the required provider.',
  not_available: 'This information is not currently exposed by this provider.',
  not_checked: 'No check was performed.',
  bad_gateway: 'The check reached something unexpected.',
};

/** { status, code, reason } — the shape every degraded response shares. */
export function publicError(code, reason = null) {
  const known = ERROR_CODES[code] ? code : 'not_available';
  return { status: 'unavailable', code: known, reason: reason || ERROR_CODES[known] };
}
