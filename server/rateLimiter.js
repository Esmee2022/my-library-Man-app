/**
 * Rate Limiter Middleware
 * Protects endpoints like /api/auth/login and /api/auth/2fa from brute-force attempts.
 */

class RateLimiter {
  constructor(windowMs = 60 * 1000, maxRequests = 10, message = 'Too many requests, please try again later.') {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.message = message;
    this.hits = new Map();

    // Clean expired windows every 2 minutes
    setInterval(() => this.cleanup(), 2 * 60 * 1000).unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.hits.entries()) {
      if (now - record.startTime > this.windowMs) {
        this.hits.delete(key);
      }
    }
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
      const now = Date.now();

      let record = this.hits.get(ip);
      if (!record || now - record.startTime > this.windowMs) {
        record = { count: 1, startTime: now };
        this.hits.set(ip, record);
        return next();
      }

      record.count += 1;
      if (record.count > this.maxRequests) {
        const retryAfter = Math.ceil((record.startTime + this.windowMs - now) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
          error: this.message,
          retryAfterSeconds: retryAfter
        });
      }

      next();
    };
  }
}

// 10 login attempts per 1 minute window per IP
const loginLimiter = new RateLimiter(60 * 1000, 10, 'Too many login attempts. Please wait a minute.').middleware();

// 10 2FA attempts per 1 minute window per IP
const totpLimiter = new RateLimiter(60 * 1000, 10, 'Too many 2FA verification attempts. Please wait a minute.').middleware();

// 60 requests per 1 minute for general API
const apiLimiter = new RateLimiter(60 * 1000, 60, 'Too many requests. Please slow down.').middleware();

module.exports = {
  RateLimiter,
  loginLimiter,
  totpLimiter,
  apiLimiter
};
