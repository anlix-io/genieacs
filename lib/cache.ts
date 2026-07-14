import * as config from "./config.ts";
import * as redisClient from "./redis.ts";

const CLOCK_SKEW_TOLERANCE = 30000;
const MAX_CACHE_TTL = +config.get("MAX_CACHE_TTL");

export async function get(key: string): Promise<string> {
  return redisClient.get(key);
}

export async function del(key: string): Promise<void> {
  await redisClient.del(key);
}

export async function set(
  key: string,
  value: string,
  ttl_s: number = MAX_CACHE_TTL
): Promise<void> {
  //const timestamp = new Date();
  //const expire = new Date(
  //  timestamp.getTime() + CLOCK_SKEW_TOLERANCE + ttl * 1000
  //);
  //await collections.cache.replaceOne(
  //  { _id: key },
  //  { value, expire, timestamp },
  //  { upsert: true }
  //);
  await redisClient.setWithExpire(
    key,
    value,
    ttl_s + CLOCK_SKEW_TOLERANCE / 1000
  );
}

export async function pop(key: string): Promise<string> {
  return redisClient.pop(key);
}
