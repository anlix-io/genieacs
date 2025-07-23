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

function subscribeToInformParamsFromSpeed069() : void {
  // Redis channel format is:
  // speed069:inform_notiff:<acs_id>
  PubSubClient.pSubscribe("speed069:inform_notiff:*", (message, channel) => {
    const acsId = channel.slice("speed069:inform_notiff:".length);
    const payload : Speed069JsonInformParams = JSON.parse(message);
    const timestamp = Date.now();
    const query = { _id: acsId }
    const update : any = {};

    // We are only applying the update on "._value", "._type" and "._timestamp"
    // fields IF ALL OF THEM are present in collection as well, just for safety
    // and I'm not a genie expert to be sure which side effects could happen
    //
    // TO-DO: we could check them individually, but I guess it would cause
    // extra roundtrips to the database

    for (const param of payload.body.parameterList) {
      query[param.name + '._value'] = { $exists: true };
      query[param.name + '._type'] = { $exists: true };
      query[param.name + '._timestamp'] = { $exists: true };
      update[param.name + '._value'] = param.value;
      update[param.name + '._type'] = param.type;
      update[param.name + '._timestamp'] = new Date(timestamp);
    }
    devicesCollection.updateOne(
      query,
      { $set: update },
      { upsert: false },
    ).catch((err) => {
      console.error("Error updating device data for speed069 inform:", err);
    });
  }).catch((err) => {
    console.error("Error subscribing to speed069 inform channel:", err);
  });
}

// Subscribing after 5 seconds
setTimeout(subscribeToInformParamsFromSpeed069, 1000);
