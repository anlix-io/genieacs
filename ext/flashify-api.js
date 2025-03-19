const redis = require('redis');

const REDISHOST = (process.env.FLM_REDIS_HOST || '127.0.0.1');
const REDISPORT = (process.env.FLM_REDIS_PORT || 6379);

const startRedis = function() {
  const client = redis.createClient({
    url: `redis://${REDISHOST}:${REDISPORT}`,
  });
  return new Promise((resolve, reject) => {
    client.connect().then(() => {
      console.log('Successfully connected to Redis');
      resolve(client);
    }).catch((err) => {
      console.error('Error on connecting to Redis: ' + err);
      reject(err);
    });
  });
}

const publishRedisMessage = async function(topic, message) {
  let client = await startRedis();
  console.log('Client ok');
  await client.publish(topic, message);
  console.log('Publish ok');
};

let cacheReceiveDiagnosticIDX = '';
let cacheReceiveDiagnosticDATA = {};
const receiveDeviceDiagnostics = async function(args, callback) {
  let params;
  let callidx;

  try {
    callidx = args[1];
    params = JSON.parse(args[0]);
  } catch (error) {
    return callback(null, {
      success: false,
      reason: 'params-json-parse',
      message: 'Error parsing params JSON',
    });
  }

  if (cacheReceiveDiagnosticIDX === callidx) {
    return callback(null, cacheReceiveDiagnosticDATA);
  }

  if (!params || !params.acs_id) {
    cacheReceiveDiagnosticIDX = callidx;
    cacheReceiveDiagnosticDATA = {
      success: false,
      reason: 'incomplete-params',
      message: 'Incomplete arguments',
    };
    return callback(null, cacheReceiveDiagnosticDATA);
  }

  try {
    console.log('Sending to redis');
    await publishRedisMessage('diagnosticComplete', params.acs_id);
  } catch (err) {
    console.log('Error on redis: ' + err);
    cacheReceiveDiagnosticIDX = callidx;
    cacheReceiveDiagnosticDATA = {
      success: false,
      reason: 'redis-error',
      message: 'Error on redis',
    };
    return callback(null, cacheReceiveDiagnosticDATA);
  }

  cacheReceiveDiagnosticIDX = callidx;
  callback(null, cacheReceiveDiagnosticDATA);
  cacheReceiveDiagnosticDATA = {success: true};
};

exports.receiveDeviceDiagnostics = receiveDeviceDiagnostics;
