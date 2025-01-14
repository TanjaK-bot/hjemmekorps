const env = process.env.NODE_ENV || 'development';
const port = process.env.PORT || 3000;
const APP_ENV_VARS = [
  'sanity__token',
  'site__tokensecret',
  'sanity__dataset',
  'mailgun__apikey',
];

// Order of priorities for config:
// 1. defaults ..can be overwritten by
// 2. app-environment-specific ..can be overwritten by
// 3. overrides ..can be overwritten by
// 4. judiciously chosen environment variables

function objectMerge(a, b) {
  // stuff b things into A recursively
  // Note: mangles A for efficiency
  for (let prop in b) {
    if (b.hasOwnProperty(prop)) {
      if (typeof a[prop] === 'object') {
        objectMerge(a[prop], b[prop]);
      } else {
        a[prop] = b[prop];
      }
    }
  }
}

const config = require('./defaults.json');
let appEnvConf = {};
if (env === 'test') {
  appEnvConf = require('./test.json');
} else if (env === 'development') {
  appEnvConf = require('./development.json');
} else {
  appEnvConf = require('./production.json');
}
objectMerge(config, appEnvConf);
objectMerge(config, require('./overrides.json'));

let envConf = {};
APP_ENV_VARS.forEach(varName => {
  if (process.env[varName]) {
    let parts = varName.split('__');
    if (envConf[parts[0]]) {
      objectMerge(envConf[parts[0]], { [parts[1]]: process.env[varName] });
    } else {
      envConf[parts[0]] = { [parts[1]]: process.env[varName] };
    }
  }
});
objectMerge(config, envConf);

let hostname =
  env === 'development'
    ? 'localhost'
    : env === 'production'
    ? 'hjemmekorps.no'
    : 'test.hjemmekorps.no';

module.exports = {
  instruments: require('./instruments.json').instruments,
  name: env,
  test: env === 'test',
  development: env === 'development',
  production: env === 'production',
  hostname,
  port,
  config,
};
