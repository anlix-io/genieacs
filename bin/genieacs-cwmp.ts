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

import * as config from "../lib/config";
import * as logger from "../lib/logger";
import * as cluster from "../lib/cluster";
import * as server from "../lib/server";
import * as cwmp from "../lib/cwmp";
import * as db from "../lib/db";
import * as redisClient from "../lib/redis"
import * as extensions from "../lib/extensions";
import { version as VERSION } from "../package.json";
import { subscribeToInformParamsFromSpeed069 } from "../lib/speed069";

logger.init("cwmp", VERSION);

const SERVICE_ADDRESS = config.get("CWMP_INTERFACE") as string;
const SERVICE_PORT = config.get("CWMP_PORT") as number;

async function initRedisPubSub(): Promise<void> {
  return redisClient.PubSubClient.connect().then(() => {
    return subscribeToInformParamsFromSpeed069();
  })
};

function exitWorkerGracefully(): void {
  setTimeout(exitWorkerUngracefully, 5000).unref();
  Promise.all([
    db.disconnect(),
    extensions.killAll(),
    cluster.worker.disconnect(),
  ]).catch(exitWorkerUngracefully);
}

function exitWorkerUngracefully(): void {
  extensions.killAll().finally(() => {
    process.exit(1);
  });
}

if (!cluster.worker) {
  const WORKER_COUNT = config.get("CWMP_WORKER_PROCESSES") as number;

  logger.info({
    message: `genieacs-cwmp starting`,
    pid: process.pid,
    version: VERSION,
  });

  cluster.start(WORKER_COUNT, SERVICE_PORT, SERVICE_ADDRESS);

  process.on("SIGINT", () => {
    logger.info({
      message: "Received signal SIGINT, exiting",
      pid: process.pid,
    });

    cluster.stop();
  });

  process.on("SIGTERM", () => {
    logger.info({
      message: "Received signal SIGTERM, exiting",
      pid: process.pid,
    });

    cluster.stop();
  });
} else {
  const key = config.get("CWMP_SSL_KEY") as string;
  const cert = config.get("CWMP_SSL_CERT") as string;

  const options = {
    port: SERVICE_PORT,
    host: SERVICE_ADDRESS,
    ssl: key && cert ? { key, cert } : null,
    onConnection: cwmp.onConnection,
    onClientError: cwmp.onClientError,
    timeout: 30000,
    keepAliveTimeout: 0,
  };

  process.on("uncaughtException", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ERR_IPC_DISCONNECTED") return;
    logger.error({
      message: "Uncaught exception",
      exception: err,
      pid: process.pid,
    });
    server.stop().then(exitWorkerGracefully).catch(exitWorkerUngracefully);
  });

  const initDBPromise = db.connect();
  const initRedisPromise = redisClient.connect();

  const allInitPromises = [initDBPromise, initRedisPromise];
  
  // Only the first worker should subscribe to speed069 inform params
  // Also, only the first container should do that
  if (process.env.GENIEACS_DOCKER_INSTANCE === '1') {
    if (config.get("CWMP_WORKER_PROCESSES") !== 1) {
      logger.warn({
        message: "Multiple CWMP worker processes detected. This is not supported in docker environment.",
        pid: process.pid,
      });
    } else {
      allInitPromises.push(initRedisPubSub())
    }
  }


  const initPromise = Promise.all([initDBPromise, initRedisPromise, initRedisPubSub])
    .then(() => {
      server.start(options, cwmp.listener);
    })
    .catch((err) => {
      setTimeout(() => {
        throw err;
      });
    });

  process.on("SIGINT", () => {
    initPromise.finally(() => {
      server.stop().then(exitWorkerGracefully).catch(exitWorkerUngracefully);
    });
  });

  process.on("SIGTERM", () => {
    initPromise.finally(() => {
      server.stop().then(exitWorkerGracefully).catch(exitWorkerUngracefully);
    });
  });
}
