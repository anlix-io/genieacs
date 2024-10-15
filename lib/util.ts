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

import { EventEmitter } from "events";

export function generateDeviceId(
  deviceIdStruct: Record<string, string>,
  alternativeSerial: string
): string {
  // Escapes everything except alphanumerics and underscore
  function esc(str): string {
    return str.replace(/[^A-Za-z0-9_]/g, (chr) => {
      const buf = Buffer.from(chr, "utf8");
      let rep = "";
      for (const b of buf) rep += "%" + b.toString(16).toUpperCase();
      return rep;
    });
  }
  let serialNumber = deviceIdStruct["SerialNumber"];

  if (alternativeSerial !== "") {
    // Remove some special chars
    serialNumber = alternativeSerial.replace(/[^A-Za-z0-9_]/g, "");
  }

  // Guaranteeing globally unique id as defined in TR-069
  if (deviceIdStruct["ProductClass"]) {
    return (
      esc(deviceIdStruct["OUI"]) +
      "-" +
      esc(deviceIdStruct["ProductClass"]) +
      "-" +
      esc(serialNumber)
    );
  }
  return esc(deviceIdStruct["OUI"]) + "-" + esc(serialNumber);
}

// Source: http://stackoverflow.com/a/6969486
export function escapeRegExp(str: string): string {
  return str.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
}

export function encodeTag(tag: string): string {
  return encodeURIComponent(tag)
    .replace(
      /[!~*'().]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
    )
    .replace(/0x(?=[0-9A-Z]{2})/g, "0%78")
    .replace(/%/g, "0x");
}

export function decodeTag(tag: string): string {
  return decodeURIComponent(tag.replace(/0x(?=[0-9A-Z]{2})/g, "%"));
}

export function once(
  emitter: EventEmitter,
  event: string,
  timeout: number
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Event ${event} timed out after ${timeout} ms`));
    }, timeout);

    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

export function setTimeoutPromise(delay: number, ref = true): Promise<void> {
  return new Promise((resolve) => {
    const timerId = setTimeout(resolve, delay);
    if (!ref) timerId.unref();
  });
}
