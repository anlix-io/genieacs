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

import * as config from "./config";
import * as redisClient from "./redis";

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
