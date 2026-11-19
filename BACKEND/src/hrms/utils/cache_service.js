// High-Performance In-Memory / Redis-Ready Caching Wrapper
class CacheService {
  constructor() {
    this.cache = new Map();
    // In a full production Redis environment, you would initialize redisClient here
  }

  /**
   * Get cached data or execute the query and cache the result.
   *
   * @param {string} key - Unique cache key
   * @param {number} ttlSeconds - Time-To-Live in seconds
   * @param {Function} fetchFunction - Async function returning data if cache miss
   * @returns {Promise<any>}
   */
  async getOrSet(key, ttlSeconds, fetchFunction) {
    const now = Date.now();
    if (this.cache.has(key)) {
      const { value, expiry } = this.cache.get(key);
      if (expiry > now) {
        return value;
      } else {
        this.cache.delete(key);
      }
    }

    const data = await fetchFunction();
    this.cache.set(key, {
      value: data,
      expiry: now + ttlSeconds * 1000,
    });

    return data;
  }

  /**
   * Invalidate a specific cache key.
   * @param {string} key
   */
  invalidate(key) {
    this.cache.delete(key);
  }

  /**
   * Clear entire cache.
   */
  clear() {
    this.cache.clear();
  }
}

module.exports = new CacheService();
