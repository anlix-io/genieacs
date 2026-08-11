import test from "ava";
import * as vm from "vm";
import { run } from "../lib/sandbox";
import { SessionContext } from "../lib/types";

const timestamp = 123;
const deviceId = "device-id";
const extensionKey =
  `0: ["flashman-api","getChosenWan","${deviceId}",` +
  `"${timestamp}${deviceId}"]`;

function sessionContext(
  initialized: boolean,
  response?: { wanChosenPath: unknown }
): SessionContext {
  return {
    timestamp,
    deviceId,
    extensionsCache: response ? { [extensionKey]: response } : {},
    customScriptInfo: initialized ? { initialized: true } : undefined,
  } as unknown as SessionContext;
}

function runScript(
  source: string,
  context: SessionContext
): ReturnType<typeof run> {
  return run(new vm.Script(source), {}, context, 0, 0, 0);
}

test("getChosenWan normalizes a valid WAN path", async (t) => {
  const result = await runScript(
    "getChosenWan()",
    sessionContext(true, {
      wanChosenPath:
        "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2." +
        "WANPPPConnection.3",
    })
  );

  t.is(
    result.returnValue,
    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2." +
      "WANPPPConnection.3."
  );
});

test("getChosenWan returns undefined for an unavailable WAN", async (t) => {
  const result = await runScript(
    "getChosenWan()",
    sessionContext(true, { wanChosenPath: "" })
  );

  t.is(result.fault, null);
  t.is(result.returnValue, undefined);
});

test("getChosenWan rejects unsafe WAN paths", async (t) => {
  const result = await runScript(
    "getChosenWan()",
    sessionContext(true, { wanChosenPath: "Device.IP.Interface.*." })
  );

  t.regex(result.fault.message, /Invalid WAN path/);
});

test("getChosenWan requires sandbox initialization", async (t) => {
  const result = await runScript("getChosenWan()", sessionContext(false));

  t.regex(result.fault.message, /Sandbox not initialized/);
});
