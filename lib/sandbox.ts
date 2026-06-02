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

/**
 * - What are revisions?
 * Every time that genie steps into a declare that must send it to the CPE, it
 * throws a COMMIT symbol to make the functions in the session.ts do the RPCs
 * and requests to the CPE. Then it starts the script again with the revision +
 * 1. And now, when it steps into the same declare, it checks the previous
 * revision to get the field values and doesn't send the get again to the CPE.
 *
 * It only throws COMMIT when it surpasses the maxRevision (the one that
 * increases every time the script re-runs).
 * 
 * So, if 1 declare is not executed in the current "revision", the next declares
 * will use old revisions to get their values and won't throw COMMIT as
 * expected.
 */

import * as vm from "vm";
import seedrandom from "seedrandom";
import * as device from "./device";
import * as extensions from "./extensions";
import * as logger from "./logger";
import * as scheduling from "./scheduling";
import Path from "./common/path";
import { Fault, SessionContext, ScriptResult } from "./types";
import { metricsExporter } from "./metrics";
import request from "request";
import { IterationMapCache } from "./iteration-map";

// Used for throwing to exit user script and commit
const COMMIT = Symbol();

// Used to execute extensions and restart
const EXT = Symbol();

// Used to skip provision if initilization conditions are not met
const SKIP = Symbol();

// Used to upgrade a device's firmware
const UPGRADE = Symbol();

const UNDEFINED = undefined;

const context = vm.createContext();

const FORCE_CUSTOM_SCRIPT_LOGGING =
  process.env.FLM_FORCE_CUSTOM_SCRIPT_LOGGING === 'true';
const FLASHMAN_PORT = process.env.FLM_WEB_PORT || 8000;
const FLASHMAN_URL =
  'http://'+(process.env.FLM_WEB_HOST || 'localhost') + `:${FLASHMAN_PORT}`;

let state: any;

const runningExtensions = new WeakMap<
  SessionContext,
  Map<string, Promise<Fault>>
>();
function runExtension(sessionContext, key, extCall): Promise<Fault> {
  let re = runningExtensions.get(sessionContext);
  if (!re) {
    re = new Map<string, Promise<Fault>>();
    runningExtensions.set(sessionContext, re);
  }

  let prom = re.get(key);
  if (!prom) {
    re.set(
      key,
      (prom = new Promise((resolve, reject) => {
        extensions
          .run(extCall)
          .then(({ fault, value }) => {
            re.delete(key);
            if (!fault) sessionContext.extensionsCache[key] = value;
            resolve(fault);
          })
          .catch(reject);
      }))
    );
  }

  return prom;
}

class SandboxDate {
  public constructor(
    ...argumentList: [
      number?,
      number?,
      number?,
      number?,
      number?,
      number?,
      number?
    ]
  ) {
    if (argumentList.length) return new Date(...argumentList);

    return new Date(state.sessionContext.timestamp);
  }

  public static now(intervalOrCron, variance): number {
    let t = state.sessionContext.timestamp;

    if (typeof intervalOrCron === "number") {
      if (variance == null) variance = intervalOrCron;

      let offset = 0;
      if (variance)
        offset = scheduling.variance(state.sessionContext.deviceId, variance);

      t = scheduling.interval(t, intervalOrCron, offset);
    } else if (typeof intervalOrCron === "string") {
      let offset = 0;
      if (variance)
        offset = scheduling.variance(state.sessionContext.deviceId, variance);
      const cron = scheduling.parseCron(intervalOrCron);
      t = scheduling.cron(t, cron, offset)[0];
    } else if (intervalOrCron) {
      throw new Error("Invalid Date.now() argument");
    }

    return t;
  }

  public static parse(dateString: string): number {
    return Date.parse(dateString);
  }

  public static UTC(
    ...args: [number, number?, number?, number?, number?, number?, number?]
  ): number {
    return Date.UTC(...args);
  }
}

function random(): number {
  if (!state.rng) state.rng = seedrandom(state.sessionContext.deviceId);

  return state.rng();
}

random.seed = function (s) {
  state.rng = seedrandom(s);
};

class ParameterWrapper {
  public constructor(path: Path, attributes, unpacked?, unpackedRevision?) {
    for (const attrName of attributes) {
      Object.defineProperty(this, attrName, {
        get: function () {
          if (state.uncommitted) commit();

          if (state.revision !== unpackedRevision) {
            unpackedRevision = state.revision;
            unpacked = device.unpack(
              state.sessionContext.deviceData,
              path,
              state.revision
            );
          }

          if (!unpacked.length) return UNDEFINED;

          const attr = state.sessionContext.deviceData.attributes.get(
            unpacked[0],
            state.revision
          )[attrName];

          if (!attr) return UNDEFINED;

          return attr[1];
        },
      });
    }

    Object.defineProperty(this, "path", {
      get: function () {
        if (state.uncommitted) commit();

        if (state.revision !== unpackedRevision) {
          unpackedRevision = state.revision;
          unpacked = device.unpack(
            state.sessionContext.deviceData,
            path,
            state.revision
          );
        }

        if (!unpacked.length) return UNDEFINED;

        return unpacked[0].toString();
      },
    });

    Object.defineProperty(this, "size", {
      get: function () {
        if (state.uncommitted) commit();

        if (state.revision !== unpackedRevision) {
          unpackedRevision = state.revision;
          unpacked = device.unpack(
            state.sessionContext.deviceData,
            path,
            state.revision
          );
        }

        if (!unpacked.length) return UNDEFINED;

        return unpacked.length;
      },
    });

    this[Symbol.iterator] = function* () {
      if (state.uncommitted) commit();

      if (state.revision !== unpackedRevision) {
        unpackedRevision = state.revision;
        unpacked = device.unpack(
          state.sessionContext.deviceData,
          path,
          state.revision
        );
      }

      for (const p of unpacked)
        yield new ParameterWrapper(p, attributes, [p], state.revision);
    };
  }
}

function declare(
  path: string,
  timestamps: { [attr: string]: number },
  values: { [attr: string]: any }
): ParameterWrapper {
  state.uncommitted = true;
  if (!timestamps) timestamps = {};

  if (!values) values = {};

  const parsedPath = Path.parse(path);

  const declaration = {
    path: parsedPath,
    pathGet: 1,
    pathSet: null,
    attrGet: null,
    attrSet: null,
    defer: true,
  };

  const attrs = new Set();

  for (const [attrName, attrValue] of Object.entries(values)) {
    if (attrName === "path") {
      declaration.pathSet = attrValue;
    } else {
      attrs.add(attrName);
      if (!declaration.attrGet) declaration.attrGet = {};
      if (!declaration.attrSet) declaration.attrSet = {};
      declaration.attrGet[attrName] = 1;
      if (attrName === "value" && !Array.isArray(values.value))
        declaration.attrSet.value = [values.value];
      else declaration.attrSet[attrName] = values[attrName];
    }
  }

  for (const [attrName, attrTimestamp] of Object.entries(timestamps)) {
    if (!(attrTimestamp >= 1)) continue;
    if (attrName === "path") {
      declaration.pathGet = attrTimestamp;
    } else {
      attrs.add(attrName);
      if (!declaration.attrGet) declaration.attrGet = {};
      declaration.attrGet[attrName] = attrTimestamp;
    }
  }

  state.declarations.push(declaration);

  return new ParameterWrapper(parsedPath, attrs);
}

function clear(path: string, timestamp: number, attributes?): void {
  state.uncommitted = true;

  if (state.revision === state.maxRevision)
    state.clear.push([Path.parse(path), timestamp, attributes]);
}

function commit(): void {
  ++state.revision;
  state.uncommitted = false;

  if (state.revision === state.maxRevision + 1) {
    for (const d of state.declarations) d.defer = false;
    throw COMMIT;
  } else if (state.revision > state.maxRevision + 1) {
    throw new Error(
      "Declare function should not be called from within a try/catch block"
    );
  }
}

function ext(...args: unknown[]): any {
  ++state.extCounter;
  const extCall = args.map(String);
  const key = `${state.revision}: ${JSON.stringify(extCall)}`;

  if (key in state.sessionContext.extensionsCache)
    return state.sessionContext.extensionsCache[key];

  state.extensions[key] = extCall;
  throw EXT;
}

function log(msg: string, meta: Record<string, unknown>): void {
  if(logger.LOG_INFO_DATA) {
    if (state.revision === state.maxRevision && state.extCounter >= 0) {
      const details = Object.assign({}, meta, {
        sessionContext: state.sessionContext,
        message: `Script: ${msg}`,
      });

      delete details["hostname"];
      delete details["pid"];
      delete details["name"];
      delete details["version"];
      delete details["deviceId"];
      delete details["remoteAddress"];

      logger.accessInfo(details);
    }
  }
}

interface alertSchema {
  mac: string;
  genieID: string;
  oui: string;
  modelClass: string;
  modelName: string;
  isIGDModel: string;
  acsURL: string;
  connectionRequestURL: string;
  metric: {
    message: string,
    reason: string,
  };
}

function alert(schema: alertSchema):void {
  if (logger.LOG_WARN_DATA) {
    if (state.revision === state.maxRevision && state.extCounter >= 0) {
      const prefixArray: string[] = [];
      for (const [key, value] of Object.entries(schema)) {
        if (typeof value === 'string')
          prefixArray.push(`${key}: ${value}`);
      }
      const prefix = prefixArray.join(', ');
      const details = Object.assign({}, {
        sessionContext: state.sessionContext,
        message: `[${
          schema.metric.reason}] ${
          prefix} -> ${
          schema.metric.message}`,
      });
      logger.warn(details);
      metricsExporter.failedProvisions.labels({
        is_igd: schema.isIGDModel ?? 'unknown',
        reason: schema.metric.reason ?? 'unknown',
        model: schema.modelName ?? 'unknown',
      }).inc();
    }
  }
}

/**
 * Flashman-Log!! Not the word "flog"!!
 * Send the provided message to Flashman for logging. This function will only
 * log if the sandbox is initialized and either in debug mode or if the
 * environment variable FORCE_CUSTOM_SCRIPT_LOGGING is set to true.
 *
 * @param {Array<any>} args - The arguments to log. Each argument will be
 * stringified and concatenated.
 */
export function flog(...args: any[]): void {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("flog: Sandbox not initialized");

  // If no arguments were provided, do not log
  if (args.length === 0) return;

  // If not in debug mode, do not log
  if (
    !state.sessionContext.customScriptInfo?.isDebug &&
    !FORCE_CUSTOM_SCRIPT_LOGGING
  ) return;

  console.log(...args);

  if (!state.sessionContext.customScriptInfo?.lastMessageId)
    state.sessionContext.customScriptInfo.lastMessageId = 1;
  else state.sessionContext.customScriptInfo.lastMessageId++;

  // Prepare the message to log
  const message = '[ INFO  ] ' + args
    .map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : arg)
    .join(" ");

  // If the message array does not exists yet, create it
  if (!state.sessionContext.customScriptInfo?.messages)
    state.sessionContext.customScriptInfo.messages = [];

  // Push the message to the array
  state.sessionContext.customScriptInfo.messages.push({
    id: state.sessionContext.customScriptInfo.lastMessageId,
    timestamp: new Date().toISOString(),
    type: 'log',
    message
  });
}

/**
 * Flashman-Error!! Not the word "ferrou"!!
 * Send the provided message to Flashman for logging. This function will only
 * log if the sandbox is initialized and either in debug mode or if the
 * environment variable FORCE_CUSTOM_SCRIPT_LOGGING is set to true.
 *
 * @param {Array<any>} args - The arguments to log. Each argument will be
 * stringified and concatenated.
 */
export function ferror(...args: any[]): void {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("ferror: Sandbox not initialized");

  // If no arguments were provided, do not log
  if (args.length === 0) return;

  // If not in debug mode, do not log
  if (
    !state.sessionContext.customScriptInfo?.isDebug &&
    !FORCE_CUSTOM_SCRIPT_LOGGING
  ) return;

  if (!state.sessionContext.customScriptInfo?.lastMessageId)
    state.sessionContext.customScriptInfo.lastMessageId = 1;
  else state.sessionContext.customScriptInfo.lastMessageId++;

  // Prepare the message to log
  const message = '[ ERROR ] ' + args
    .map((arg) => typeof arg === 'object' ? JSON.stringify(arg) : arg)
    .join(" ");

  // If the message array does not exists yet, create it
  if (!state.sessionContext.customScriptInfo?.messages)
    state.sessionContext.customScriptInfo.messages = [];

  // Push the message to the array
  state.sessionContext.customScriptInfo.messages.push({
    id: state.sessionContext.customScriptInfo.lastMessageId,
    timestamp: new Date().toISOString(),
    type: 'error',
    message
  });
}

/**
 * Send the logs to flashman all at once.
 */
function sendFlashmanLogs(): void {
  // If there is no message to send or no script tag, return early
  if (
    !state.sessionContext.customScriptInfo?.scriptTag ||
    !state.sessionContext?.customScriptInfo?.messages ||
    state.sessionContext.customScriptInfo.messages.length === 0
  ) return;

  // Send the message to Flashman
  request({
    url: `${FLASHMAN_URL}/acs/acs-id/` +
      `${encodeURIComponent(state.sessionContext.deviceId)}/script/` +
      `${encodeURIComponent(state.sessionContext.customScriptInfo?.scriptTag)}` +
      `/log`,
    method: 'POST',
    headers: {
      'X-Anlix-Sec': process.env.FLM_COMPANY_SECRET,
    },
    json: state.sessionContext.customScriptInfo.messages,
  }).on('response', (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      log(
        'Failed to log error script to Flashman. ' +
        `Status code: ${response.statusCode}` +
        `Response body: ${JSON.stringify(response.body)}`,
        {}
      );
    }
  }).on('error', (err: unknown) => {
    // If there is an error sending the log to Flashman, log it to the console
    log('Failed to send error log to Flashman: ' + JSON.stringify(err), {});
  });
}

enum ActionType {
  ADD_OBJECT = "addObject",
  DELETE_OBJECT = "deleteObject",
  SET_VALUE = "setValue",
}

function audit(actionType: ActionType, path: string, value?: any): void {
  // Send the request to Flashman for auditing
  request({
    url: `${FLASHMAN_URL}/acs/acs-id/` +
      `${encodeURIComponent(state.sessionContext.deviceId)}/script/` +
      `${encodeURIComponent(state.sessionContext.customScriptInfo?.scriptTag)}` +
      `/audit`,
    method: 'POST',
    headers: {
      'X-Anlix-Sec': process.env.FLM_COMPANY_SECRET,
    },
    json: {
      timestamp: new Date().toISOString(),
      type: actionType,
      path: path,
      value: value,
    },
  }).on('response', (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      log(
        'Failed to audit script to Flashman. ' +
        `Status code: ${response.statusCode}` +
        `Response body: ${JSON.stringify(response.body)}`,
        {}
      );
    }
  }).on('error', (err: unknown) => {
    // If there is an error sending the audit to Flashman, log it to the console
    log(
      'Failed to send audit to Flashman: ' + JSON.stringify(err) +
        ` for action ${actionType} on path ${path} with value ${value}`,
      {},
    );
  });
}

/**
 * Gets the value of a parameter at the specified path directly from the device
 * data at the last revision, bypassing the ParameterWrapper getters and their
 * reliance on state.revision. If the value is not found, it forces a COMMIT to
 * make genieacs fetch the parameter and re-run the script on the next
 * iteration.
 *
 * @param {string} path - The path of the parameter to get.
 */
function getLastRevisionValueOrCommit(
  path: string,
  where: 'value' | 'size' = 'value',
): boolean | number | string | undefined {
  // Read the value directly at the highest revision available instead of
  // relying on the ParameterWrapper getter (which reads at state.revision).
  //
  // Why this matters: every script re-run resets state.revision to 0, and
  // commit() only advances it by 1 per call. When the user calls getValue()
  // after init() — which on subsequent runs returns early without performing
  // the commits it normally does — state.revision stays very low (e.g. 1),
  // while data fetched in earlier iterations lives at higher revisions
  // (e.g. 3 or 4). VersionedMap.get(path, 1) would then return NONEXISTENT
  // because revisions[1] was filled with NONEXISTENT when the value was
  // first set at revision 3+. Reading at maxRevision sees the latest data
  // regardless of how many commits the current run made.
  const executionCache = state.sessionContext.customScriptInfo.executionCache;
  const readRevision = Math.max(state.maxRevision, state.revision);
  const parsedPath = Path.parse(path);
  const deviceData = state.sessionContext.deviceData;
  const unpacked = device.unpack(deviceData, parsedPath, readRevision);
  if (unpacked.length && where === 'value') {
    const attrs = deviceData.attributes.get(unpacked[0], readRevision);
    const valueAttr = attrs?.value?.[1];
    const time = attrs?.value?.[0] ?? executionCache.getObjectTimestamp(path);

    // Save the timestamp
    executionCache.saveObjectTimestamp(
      path,
      time ?? SandboxDate.now(null, null),
    );

    // Only return the value if it has a timestamp and it's as new as possible
    if (
      valueAttr != null && time && time >= SandboxDate.now(null, null)
    ) return valueAttr[0] as boolean | number | string;
  } else if (where === 'size') {
    // Get the size
    const parsedBasePath = Path.parse(path);
    const unpackedBase = device.unpack(
      deviceData,
      parsedBasePath,
      readRevision,
    );
    const size = unpackedBase.length;

    // Get the time we got this path, remove the * or [...] as they might not
    // exist and thus return an empty path
    const upperPath = path
      .replace(/\.[*[].*$/, '')
      .replace(/\.$/, '');
    const parsedUpperPath = Path.parse(upperPath);
    const unpackedUpper = device.unpack(
      deviceData,
      parsedUpperPath,
      readRevision,
    );
    const attrs = deviceData.attributes.get(unpackedUpper[0], readRevision);
    const time = attrs?.object?.[0] ?? executionCache.getObjectTimestamp(path);

    // Save the timestamp
    // This can save the infinite loop caused by always trying to commit a path
    // that doesn't exist
    executionCache.saveObjectTimestamp(
      path,
      time ?? SandboxDate.now(null, null),
    );

    console.log('attrs:', attrs);
    console.log('time:', time);
    console.log('SandboxDate.now():', SandboxDate.now(null, null));
    console.log('unpackedBase:', unpackedBase);
    console.log('unpackedBase.length:', unpackedBase.length);

    if (time && time >= SandboxDate.now(null, null)) return size;
  }    

  // The value isn't in deviceData yet. Force genieacs to fetch the
  // parameter and re-run the script on the next iteration by throwing
  // COMMIT. We jump state.revision up to maxRevision so the next commit()
  // trips the `revision === maxRevision + 1` condition and actually throws.
  state.revision = state.maxRevision;
  commit(); // throws COMMIT because of the state.revision we just set

  // Unreachable
  return UNDEFINED;
}

/**
 * Gets the value of a parameter at the specified path.
 *
 * @param {string} path - The path of the parameter to get.
 *
 * @return {boolean|number|string|undefined} The value of the parameter, or
 * undefined if not found.
 *
 * @throws {Error} If the sandbox is not initialized.
 */
export function getValue(path: string): boolean | number | string | undefined {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("getValue: Sandbox not initialized");

  // If the path is not a string, return an error
  if (typeof path !== "string") {
    ferror(`getValue() called with a non-string path: ${path}`);
    return UNDEFINED;
  }

  // Trim whitespace from the path
  path = path.trim();

  // If the path is empty, return an error
  if (path.length === 0) {
    ferror("getValue() called with an empty path.");
    return UNDEFINED;
  }

  // If the path has trailing dot, remove it
  if (path.endsWith(".")) path = path.slice(0, -1);

  // If we have this field in cache, return early
  const executionCache = state.sessionContext.customScriptInfo.executionCache;
  const cachedValue = executionCache.getValue(path);
  if (cachedValue !== undefined) return cachedValue;

  // Get the value
  declare(
    path,
    { value: SandboxDate.now(null, null), path: SandboxDate.now(null, null) },
    {},
  );

  // Try getting the parameter
  const parameter = getLastRevisionValueOrCommit(path);

  // Save the value to next iterations
  if (parameter !== UNDEFINED) executionCache.saveValue(path, parameter);

  return parameter;
}

/**
 * Sets the value of a parameter at the specified path.
 *
 * @param {string} path - The path of the parameter to set.
 * @param {boolean|number|string} value - The value to set.
 * @return {boolean} True if the value was set successfully, false otherwise.
 */
export function setValue(
  path: string,
  value: boolean | number | string
): boolean {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("setValue: Sandbox not initialized");

  // If the path is not a string, return an error
  if (typeof path !== "string") {
    ferror(`setValue() called with a non-string path: ${path}`);
    return false;
  }

  // Trim whitespace from the path
  path = path.trim();

  // If the path is empty, return an error
  if (path.length === 0) {
    ferror("setValue() called with an empty path.");
    return false;
  }

  // If the path has trailing dot, remove it
  if (path.endsWith(".")) path = path.slice(0, -1);

  // Check if the value is of valid type
  if (
    typeof value !== "boolean" &&
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    ferror(`setValue() called with an invalid value type: ${typeof value}.`);
    return false;
  }

  // Try getting the setted value
  const executionCache = state.sessionContext.customScriptInfo.executionCache;
  const cachedValue = executionCache.getSettedValue(path);
  if (cachedValue !== undefined && cachedValue === value) return true;

  // Save the setted value to next iterations
  executionCache.setValue(path, value);

  // Audit this setValue action before sending
  audit(ActionType.SET_VALUE, path, value);

  // Set the value
  declare(path, {}, { value: value });

  // Force committing the changes
  state.revision = state.maxRevision;
  commit();

  return true;
}

/**
 * Adds objects at the specified path.
 *
 * @param {string} path - The path where the object should be added.
 * @return {number|undefined} The new size of the objects at the path, or
 * undefined if the operation failed.
 */
export function addObject(
  path: string,
): number | undefined {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("addObject: Sandbox not initialized");

  // If the path is not a string, return an error
  if (typeof path !== "string") {
    ferror(`addObject() called with a non-string path: ${path}`);
    return UNDEFINED;
  }

  // Trim whitespace from the path
  path = path.trim();

  // If the path is empty, return an error
  if (path.length === 0) {
    ferror("addObject() called with an empty path.");
    return UNDEFINED;
  }

  // If the path does not end with a * or [...], return an error
  if (
    !path.endsWith("*") &&
    !(/(?:\[\]|\[(\w+):(\w+)(,(\w+):(\w+))*\])$/).test(path)
  ) {
    ferror(
      'addObject() called with a path that does not end with "*"' +
        `or [...]: ${path}.`,
    );
    return UNDEFINED;
  }

  // If we already have a cached size for this path, use it to avoid unnecessary
  // declares and COMMITs
  const executionCache = state.sessionContext.customScriptInfo.executionCache;
  const cachedValue = executionCache.getAddObjectValue(path);
  if (cachedValue !== undefined) return cachedValue;

  // Get the amount of objects already present at the path
  declare(
    path,
    { path: SandboxDate.now(null, null) },
    {},
  ) as { size?: number };
  const parameter =
    executionCache.getObjectSize(path) ??
    getLastRevisionValueOrCommit(path, 'size');
  const currentSize = parameter ?? 0;

  // If currentSize is undefined, return an error
  if (typeof currentSize !== 'number') {
    ferror(
      'Unable to determine the current size of objects at path:' +
       ` ${path}.`,
    );
    return UNDEFINED;
  }

  // The new size will be current size plus 1 that we are creating
  const newSize = currentSize + 1;

  // Save the value to next iterations
  if (parameter !== UNDEFINED) executionCache.addObject(path, newSize);

  // Audit this addition
  audit(ActionType.ADD_OBJECT, path, newSize);

  // Create the new object
  declare(
    path,
    { path: SandboxDate.now(null, null) },
    { path: newSize },
  ) as { path?: string };

  // Force committing the changes
  state.revision = state.maxRevision;
  commit();

  return newSize;
}

/**
 * Deletes the last object at the specified path.
 *
 * @param {string} path - The path where the object should be deleted.
 * @param {number} [size] - The new size of the objects at the path after
 * deletion. If not provided, it will be calculated as current size minus one.
 * @return {boolean} True if the object was deleted successfully, false
 * otherwise.
 */
export function deleteObject(
  path: string,
  size?: number,
): boolean {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("deleteObject: Sandbox not initialized");

  // If the path is not a string, return an error
  if (typeof path !== "string") {
    ferror(`deleteObject() called with a non-string path: ${path}`);
    return false;
  }

  // Trim whitespace from the path
  path = path.trim();

  // If the path is empty, return an error
  if (path.length === 0) {
    ferror("deleteObject() called with an empty path.");
    return false;
  }

  if (
    typeof size === "number" &&
    (!Number.isFinite(size) || !Number.isInteger(size) || size < 0)
  ) {
    ferror(`deleteObject() called with an invalid size: ${size}`);
    return false;
  }

  // If we already have a cached size for this path, use it to avoid unnecessary
  // declares and COMMITs
  const executionCache = state.sessionContext.customScriptInfo.executionCache;
  const cachedValue = executionCache.getDeleteObjectValue(path);
  if (cachedValue !== undefined) return true;


  // Get the amount of objects already present at the path
  declare(
    path,
    { path: SandboxDate.now(null, null) },
    {},
  ) as { size?: number };
  const parameter =
    executionCache.getObjectSize(path) ??
    getLastRevisionValueOrCommit(path, 'size');
  const currentSize = parameter ?? 1;

  // If currentSize is undefined, return an error
  if (typeof currentSize !== 'number') {
    ferror(
      'Unable to determine the current size of objects at path:' +
       ` ${path}.`,
    );
    return false;
  }

  // Check if the provided size is greater than the current size, if so, return
  // an error
  if (typeof size === "number" && size > currentSize) {
    ferror(
      `deleteObject() called with a size greater than the current size: ${size}`,
    );
    return false;
  }

  // The new size will be provided one or the current size minus 1 that we are
  // deleting
  const newSize = typeof size === "number" ?
    currentSize - size :
    currentSize - 1;

  // If the size is < 0, return
  if (newSize < 0) {
    ferror(
      `deleteObject() called resulting in a negative size: ${newSize}.` +
        ` Current size was: ${currentSize}`,
    );
    return false;
  }

  // Save the value to next iterations
  if (parameter !== UNDEFINED) executionCache.deleteObject(path, newSize);

  // Audit this deletion
  audit(ActionType.DELETE_OBJECT, path, newSize);

  // Delete the last object
  console.log('Declaring deleteObject with path:', path, 'and newSize:', newSize);
  declare(
    path,
    { path: SandboxDate.now(null, null) },
    { path: newSize },
  ) as { path?: string };

  // Force committing the changes
  state.revision = state.maxRevision;
  commit();

  return true;
}

/**
 * Get which firmware to update from Flashman and update the device accordingly.
 *
 * @param {string} version - The version to update the firmware to.
 * @throws {Error} If the sandbox is not initialized.
 * @throws {Error} If there is an error fetching firmware information from
 * flashman.
 * @throws {Error} If the firmware version for the device is not found in
 * Flashman.
 * @throws {UPGRADE} To skip the provision and execute the firmware upgrade
 * command on the device. 
 */
export function updateFirmware(version: string): void {
  // If not initialized, throw an error
  if (!state.sessionContext.customScriptInfo?.initialized)
    throw new Error("updateFirmware: Sandbox not initialized");

  const acsId = state.sessionContext.deviceId;
  const productClass = (declare('DeviceID.ProductClass', {value: 1}, {}) as {
    value?: [boolean | number | string, string];
  })?.value?.[0];

  if (!productClass) {
    ferror(
      `Unable to determine the product class of the device ${acsId}. ` +
        `Cannot proceed with firmware update.`
    );
    throw new Error(
      `Unable to determine the product class of the device ${acsId}. ` +
        `Cannot proceed with firmware update.`
    );
  }

  // If the version is not a string or an empty string, return an error
  if (typeof version !== "string" || version.trim().length === 0) {
    ferror(`updateFirmware() called with an invalid version: ${version}`);
    throw new Error(
      `updateFirmware() called with an invalid version: ${version}`,
    );
  }

  // Use ext(...) synchronously so declares execute in this session before we
  // throw UPGRADE
  const hashIndex = SandboxDate.now(null, null).toString() + acsId;
  const fmResp: any = ext(
    'flashman-api',
    'getFirmwareFile',
    JSON.stringify({ productClass: productClass, version: version, acsId }),
    hashIndex,
  );

  // Validate extension response
  if (!fmResp) {
    ferror(
      `Error updating firmware information from Flashman: no response`,
    );
    throw new Error(
      `Error updating firmware information from Flashman: no response`,
    );
  }

  if (!fmResp.success) {
    ferror(
      'Failed to fetch firmware information from Flashman. ' +
        `Response: ${JSON.stringify(fmResp)}`
    );
    throw new Error(
      'Failed to fetch firmware information from Flashman. ' +
        `Response: ${JSON.stringify(fmResp)}`
    );
  }

  if (!fmResp.filename) {
    ferror(
      `Firmware version ${version} for device ${acsId} not found in Flashman.`
    );
    throw new Error(
      `Firmware version ${version} for device ${acsId} not found in Flashman.`
    );
  }

  // Send the firmware update command to the device
  flog(
    'Initiating firmware update to version', version,
    'with firmware file', fmResp.filename,
    'for device', acsId + '.',
    'Exiting script to execute firmware upgrade command on the device.'
  );
  audit(ActionType.SET_VALUE, 'version', version);
  declare(
    'Downloads.[FileType:1 Firmware Upgrade Image]',
    {path: 1},
    {path: 1},
  );
  declare(
    'Downloads.[FileType:1 Firmware Upgrade Image].FileName',
    {value: 1},
    {value: fmResp.filename},
  );
  declare(
    'Downloads.[FileType:1 Firmware Upgrade Image].Download',
    {value: 1},
    {value: SandboxDate.now(null, null)},
  );

  // Force committing the changes
  state.revision = state.maxRevision;
  commit();

  throw UPGRADE;
}

/**
 * Sends a request to Flashman to inform that a script with the provided tag has
 * been run.
 *
 * @param {string} scriptTag - The tag of the script that has been run
 * (scriptId). 
 * @param {{fault?: Fault, started?: boolean}} runInfo - If any fault happened
 * and if the script just started running
 * @returns {Promise<void>} A promise that resolves when the request is
 * successful, or rejects with an error if the request fails.
 */
function sendScriptRunInfoToFlashman(
  scriptTag: string,
  runInfo: {fault?: Fault, started?: boolean} = {},
): void {
  request({
    url: `${FLASHMAN_URL}/acs/acs-id/` +
      `${encodeURIComponent(state.sessionContext.deviceId)}/script/` +
      `${encodeURIComponent(scriptTag)}/run`,
    method: 'POST',
    headers: {
      'X-Anlix-Sec': process.env.FLM_COMPANY_SECRET,
    },
    json: {
      mac: state.sessionContext.customScriptInfo?.mac ?? '',
      success: !runInfo?.fault,
      started: runInfo?.started ?? false,
      timestamp: new Date().toISOString(),
      error: runInfo?.fault?.message ?? null,
    },
  }).on('response', (response) => {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      log(
        'Failed to send script run info to Flashman. ' +
        `Status code: ${response.statusCode}`,
        {}
      );
    }
  }).on('error', (err: unknown) => {
    log(
      `Error sending script run info to Flashman: ${(err as Error).message}`,
      {}
    );
  });
}

/**
 * Gets the MAC address of the device. This function should call the EXT
 * function to retrieve the MAC address field from Flashman.
 */
function getMACAddress(): string | null {
  const genieIDDeclare = declare('DeviceID.ID', {value: 1}, {}) as {
    value?: [boolean | number | string, string];
  };
  const ouiDeclare = declare('DeviceID.OUI', {value: 1}, {}) as {
    value?: [boolean | number | string, string];
  };
  const modelClassDeclare = declare(
    'DeviceID.ProductClass',
    {value: 1},
    {},
  ) as {
    value?: [boolean | number | string, string];
  };

  // Detect TR-098 or TR-181 data model based on database value
  const isIGDModel = (declare(
    'InternetGatewayDevice.ManagementServer.URL',
    {value: 1},
    {},
  ) as {
    value?: [boolean | number | string, string];
  }).value;
  const prefix = (isIGDModel) ? 'InternetGatewayDevice' : 'Device';

  const modelNameDeclare = declare(
    prefix + '.DeviceInfo.ModelName',
    {value: 1},
    {},
  ) as {
    value?: [boolean | number | string, string];
  };
  const firmwareVersionDeclare = declare(
    prefix + '.DeviceInfo.SoftwareVersion',
    {value: 1},
    {},
  ) as {
    value?: [boolean | number | string, string];
  };
  const hardwareVersionDeclare = declare(
    prefix + '.DeviceInfo.HardwareVersion',
    {value: 1},
    {},
  ) as {
    value?: [boolean | number | string, string];
  };
  const trType = isIGDModel ? 'tr098' : 'tr181';

  const genieID = genieIDDeclare.value?.[0];
  const oui = ouiDeclare.value?.[0];
  const modelClass = modelClassDeclare.value?.[0];
  const modelName = modelNameDeclare.value?.[0];
  const firmwareVersion = firmwareVersionDeclare.value?.[0];
  const hardwareVersion = hardwareVersionDeclare.value?.[0];

  const hashIndex = SandboxDate.now(null, null).toString() + genieID;

  const flashmanArguments = {
    oui: oui,
    model: modelClass,
    modelName: modelName,
    firmwareVersion: firmwareVersion,
    hardwareVersion: hardwareVersion,
    trType: trType,
    acs_id: genieID,
  };

  // Call the EXT function to get the MAC address field from Flashman
  const macFieldResponse = ext(
    'flashman-api',
    'getMACField',
    JSON.stringify(flashmanArguments),
    hashIndex,
  );

  // Get the MAC address from the CPE
  let mac: string | null = null;
  if (macFieldResponse.success && macFieldResponse.macField) {
    // Query and add the MAC address in Fargs
    const macDeclare = declare(macFieldResponse.macField, {value: 1}, {}) as {
      value?: [boolean | number | string, string];
    };

    if (
      macDeclare && macDeclare.value && macDeclare.value[0] &&
      typeof macDeclare.value[0] === 'string'
    ) mac = macDeclare.value[0].toUpperCase();
  }

  // Return the MAC address
  return mac;
}

/**
 * Initializes the sandbox environment. This function should be called before
 * running any custom scripts. It checks if the script configured to run 
 * matches the script tag provided in the arguments and sets up the context
 * accordingly.
 *
 * @throws {Error} If the sandbox is not initialized or if the script tag is not
 * set in the arguments.
 * @throws {SKIP} If it is debug and already ran once with the same script tag,
 * so it should not run again.
 */
function init(): void {
  let scriptInfo;
  try {
    scriptInfo = JSON.parse(context.args[1]);
  } catch (error: unknown) {
    log('Failed to parse script info from arguments, using default values. ' +
      `Error: ${(error as Error).message}, Arguments: ${context.args[1]}`, {});
    throw new Error(
      'Failed to parse script info from arguments: ' +
      (error as Error).message
    );
  }

  // If the script tag was not set, throw an error
  if (!scriptInfo?.scriptTag)
    throw new Error("Script tag not set");

  const scriptTag = scriptInfo?.scriptTag;

  // If we must run the script in debug mode, check if the script tag matches or
  // not, if so, throw SKIP to not run the script
  const tagValue = declare(
    'Tags.' + scriptTag,
    { value: SandboxDate.now(null, null) },
    {},
  ) as {
    value?: [boolean | number | string, string];
  };
  if (
    scriptInfo?.isDebug &&
    tagValue?.value?.[0] !== true
  ) throw SKIP;

  // Remove the script tag in Tags to avoid running again in debug mode
  declare('Tags.' + scriptInfo?.scriptTag, {}, {value: false});

  // Get the MAC address of the device
  const mac = getMACAddress();

  // Set the debug mode, tag and initilization flag
  if (!state.sessionContext.customScriptInfo) {
    state.sessionContext.customScriptInfo = {
      executionCache: new IterationMapCache(),
      messages: [],
    };
  }

  // Set the revision back to 0 in case this is a re-run of the script, so the
  // script can use it to detect if it is the first run or a re-run
  state.sessionContext.customScriptInfo.executionCache.resetRevision();

  state.sessionContext.customScriptInfo.isDebug = !!scriptInfo?.isDebug;
  state.sessionContext.customScriptInfo.scriptTag = scriptInfo?.scriptTag;
  state.sessionContext.customScriptInfo.mac = mac;

  // Only ends the function here because we need to execute the previous steps
  // in order to make genie understand the revisions
  if (state.sessionContext?.customScriptInfo?.initialized) return;

  // Send the script initialization info to Flashman for monitoring
  sendScriptRunInfoToFlashman(scriptInfo.scriptTag, {started: true});

  // Set the initialized flag
  state.sessionContext.customScriptInfo.initialized = true;

  // Log the script initialization
  flog(
    `Script ${scriptInfo?.scriptTag} ` +
    `initialized in ${
      state.sessionContext.customScriptInfo.isDebug ? 'debug' : 'normal'
    } mode.`,
  );
}

Object.defineProperty(context, "Date", { value: SandboxDate });
Object.defineProperty(context, "declare", { value: declare });
Object.defineProperty(context, "clear", { value: clear });
Object.defineProperty(context, "commit", { value: commit });
Object.defineProperty(context, "ext", { value: ext });
Object.defineProperty(context, "log", { value: log });
Object.defineProperty(context, "alert", { value: alert });
Object.defineProperty(context, "flog", { value: flog });
Object.defineProperty(context, "ferror", { value: ferror });
Object.defineProperty(context, "getValue", { value: getValue });
Object.defineProperty(context, "setValue", { value: setValue });
Object.defineProperty(context, "addObject", { value: addObject });
Object.defineProperty(context, "deleteObject", { value: deleteObject });
Object.defineProperty(context, "init", { value: init });
Object.defineProperty(context, "updateFirmware", { value: updateFirmware });

// Monkey-patch Math.random() to make it deterministic
context.random = random;
vm.runInContext("Math.random = random;", context);
delete context.random;

function errorToFault(err: Error): Fault {
  if (!err) return null;

  if (!err.name) return { code: "script", message: `${err}` };

  const fault: Fault = {
    code: `script.${err.name}`,
    message: err.message,
    detail: {
      name: err.name,
      message: err.message,
    },
  };

  if (err.stack) {
    fault.detail["stack"] = err.stack;
    // Trim the stack trace at the self-executing anonymous wrapper function
    const stackTrimIndex = fault.detail["stack"].match(
      /\s+at\s[^\s]+\s+at\s[^\s]+\s\(vm\.js.+\)/
    );
    if (stackTrimIndex) {
      fault.detail["stack"] = fault.detail["stack"].slice(
        0,
        stackTrimIndex.index
      );
    }
  }

  return fault;
}

export async function run(
  script: vm.Script,
  globals: Record<string, unknown>,
  sessionContext: SessionContext,
  startRevision: number,
  maxRevision: number,
  extCounter,
  name?:string,
): Promise<ScriptResult> {
  state = {
    sessionContext: sessionContext,
    revision: startRevision,
    maxRevision: maxRevision,
    uncommitted: false,
    declarations: [],
    extensions: {},
    clear: [],
    rng: null,
    extCounter: extCounter,
    globals: globals,
  };

  const endTimer = 
    metricsExporter.provisionDuration.
    labels({name:name??'unknown', ext_counter:extCounter})
    .startTimer()
  
  for (const n of Object.keys(context)) delete context[n];

  Object.assign(context, globals);

  let ret, status;

  // args: Array<string>
  // [0]: "PERIODIC"/"BOOTSTRAP"/"BOOT"
  // [1]: {
  //   isDebug: boolean,
  //   scriptTag: string,
  // }
  // Try parsing the second argument as JSON, if it fails, throw an error
  // But only for scripts that come with scriptInfo in arguments
  try {
    ret = script.runInContext(context, { displayErrors: false });
    status = 0;
    // Send a request to Flashman to inform that this script already finished
    // running
    if (state.sessionContext?.customScriptInfo?.scriptTag) {
      // Send the logs to flashman
      sendFlashmanLogs();

      // Inform flashman that the script ran
      sendScriptRunInfoToFlashman(
        state.sessionContext.customScriptInfo.scriptTag,
      );
    }
  } catch (err) {
    if (err === COMMIT) {
      // Clear the messages from old executions
      if (state.sessionContext?.customScriptInfo?.messages)
        state.sessionContext.customScriptInfo.messages = [];

      status = 1;
    } else if (err === EXT) {
      // Clear the messages from old executions
      if (state.sessionContext?.customScriptInfo?.messages)
        state.sessionContext.customScriptInfo.messages = [];

      status = 2;
    } else if (err === SKIP) {
      // If we must skip this provision, just return
      endTimer();
      return {
        fault: null,
        clear: state.clear,
        declare: state.declarations,
        done: true,
        returnValue: ret,
      };
    } else if (err === UPGRADE) {
      // Send a request to Flashman to inform that this script run the firmware
      if (state.sessionContext?.customScriptInfo?.scriptTag) {
        // Send the logs to flashman
        sendFlashmanLogs();

        // Inform flashman that the script ran
        sendScriptRunInfoToFlashman(
          state.sessionContext.customScriptInfo.scriptTag,
        );
      }
      endTimer();
      return {
        fault: null,
        clear: state.clear,
        declare: state.declarations,
        done: true,
        returnValue: ret,
      };
    } else {
      // For any other error, convert it to a fault and return it
      const fault = errorToFault(err);
      if (state.sessionContext?.customScriptInfo?.scriptTag) {
        // Send the logs to flashman
        sendFlashmanLogs();

        // Inform flashman that the script ran
        sendScriptRunInfoToFlashman(
          state.sessionContext.customScriptInfo.scriptTag,
          {fault},
        );
      }
      return {
        fault: fault,
        clear: null,
        declare: null,
        done: false,
        returnValue: null,
      };
    }
  }

  const _state = state;
  let fault;

  await Promise.all(
    Object.entries(_state.extensions).map(async ([k, v]) => {
      fault = (await runExtension(_state.sessionContext, k, v)) || fault;
    })
  );

  if (fault) {
    return {
      fault: fault,
      clear: null,
      declare: null,
      done: false,
      returnValue: null,
    };
  }

  if (status === 2) {
    return run(
      script,
      globals,
      sessionContext,
      startRevision,
      maxRevision,
      extCounter - _state.extCounter,
      name
    );
  }

  endTimer();

  return {
    fault: null,
    clear: _state.clear,
    declare: _state.declarations,
    done: status === 0,
    returnValue: ret,
  };
}
