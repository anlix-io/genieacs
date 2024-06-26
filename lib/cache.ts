/**
 * Copyright 2013-2019  GenieACS Inc.
 *
 * This file is part of GenieACS.
 *
 * GenieACS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * GenieACS is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with GenieACS.  If not, see <http://www.gnu.org/licenses/>.
 */


import * as logger from "./logger";
import * as config from "./config";
import * as redisClient from './redis'

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
  //await cacheCollection.replaceOne(
  //  { _id: key },
  //  { value, expire, timestamp },
  //  { upsert: true }
  //);
  await redisClient.setWithExpire(key, value, 
    ttl_s + CLOCK_SKEW_TOLERANCE / 1000);
}

export async function pop(key: string): Promise<string> {
  return redisClient.pop(key);
}

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
  await set(lockName, token, Math.ceil(ttl_ms / 1000))

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
