/**
 * There is some specific events that, if handled by the speed069 module,
 * genieacs will misbehave
 * 
 * Genie not receiving a new
 * InternetGatewayDevice.ManagementServer.ConnectionRequestURL from the Inform
 * will cause the genie not being able to send connection requests to the CPEs.
 * 
 * By the other hand, if the speed069 skips the Inform and proxies it to
 * genieacs, it may cause massive workload on both genieacs process and also
 * on Flashman (due to sync procedure on 4 VALUE CHANGE events)
 * 
 * The first workaround with speed069 integration is to handle Inform
 * parameters (from informs that are being handled on speed069) with pubsub
 * redis channel
 */

import { devicesCollection } from "./db";
import { error, info } from "./logger";
import { PubSubClient } from "./redis";

type Speed069JsonInformParams = {
  acs_id: string;
  body: {
    eventCodes: string[];
    parameterList: {
      name: string;
      type: string;
      value: string;
    }[];
    type: string;
  };
  header?: string;
}

export function subscribeToInformParamsFromSpeed069() : Promise<void> {
  // Redis channel format is:
  // speed069:inform_notiff:<acs_id>
  return PubSubClient.pSubscribe("speed069:inform_notiff:*", (message, channel) => {
    const acsId = channel.slice("speed069:inform_notiff:".length);
    const payload : Speed069JsonInformParams = JSON.parse(message);
    const timestamp = Date.now();
    const query = { _id: acsId }
    const update : any = {};

    for (const param of payload.body.parameterList) {
      update[param.name + '._value'] = param.value;
      update[param.name + '._type'] = param.type;
      update[param.name + '._timestamp'] = new Date(timestamp);
    }
    devicesCollection.updateOne(
      query,
      { $set: update },
      { upsert: false },
    ).catch((err) => {
      error({
        message: "Error updating device data for speed069 inform",
        error: err,
      });
    });
  }).catch((err) => {
    error({
      message: "Error subscribing to speed069 inform channel",
      error: err,
    });
  }).then(() => {
    info({
      message: "Subscribed to speed069 inform parameters channel",
    });
  });
}
