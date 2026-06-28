/**
 * helpers.js — shared response envelope + async route wrapper.
 * Every route: success -> {success:true, data, message}; error -> {success:false, error, statusCode}.
 * statusCode 400 for thrown business errors (Thai messages preserved verbatim), 401 for auth/session failures.
 */

function ok(res, data, message) {
  res.json({ success: true, data: data === undefined ? null : data, message: message || null });
}

/** Wraps an async route handler; catches thrown errors and maps them to the envelope. */
function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const statusCode = err.statusCode || 400;
      res.status(statusCode).json({ success: false, error: err.message || String(err), statusCode });
    }
  };
}

/** Pulls the token out of the request body or Authorization header (frontend
 *  sends `token` as the first positional arg to every api_xxx call — we accept
 *  it as a body field `token` or query param to keep all call sites unchanged). */
function getToken(req) {
  return (req.body && req.body.token) || req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
}

module.exports = { ok, wrap, getToken };
