
import * as logger from "./logger";
import * as redisClient from './redis'
import * as cache from "./cache";

export async function acquireLock(
  lockName: string,
  ttl_ms: number,
  timeout = 0,
  token = Math.random().toString(36).slice(2)
): Promise<string> {
  let currentToken = await redisClient.get(lockName);
  
  while (currentToken && currentToken!==token) {
    if (timeout>0){
      const t = Date.now();
      const w = 50 + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, w));
      currentToken = await redisClient.get(lockName);
      timeout -= (Date.now() - t);
    } else {
      return null;
    }
  }
  await cache.set(lockName, token, Math.ceil(ttl_ms / 1000))

  return token;
}

export async function releaseLock(
  lockName: string,
  token: string
): Promise<void> {
  const currentToken = await redisClient.get(lockName);
  let deletedCount = 0;
  if (currentToken === token) {
    deletedCount = await redisClient.del(lockName);
    if (
      (typeof deletedCount !== "number") || (deletedCount < 1)
    ) throw new Error(`Lock ${lockName} expired`);
    else return;
  } else {
    logger.warn({
      message:`Lock ${lockName} unexistent or not owned`
    });
    return;
  }
}

export async function lockExists(lockName: string): Promise<boolean> {
  const res = await redisClient.get(lockName);
  return res != null;
}
