const config = require('./config');
const { VerusIdInterface } = require('verusid-ts-client');
const primitives = require('verus-typescript-primitives');

// Instantiate the VerusID client against the live VRSCTEST daemon.
const verusId = new VerusIdInterface(
  config.verusChain,
  `http://${config.verusRpcHost}:${config.verusRpcPort}`,
  {
    auth: {
      username: config.verusRpcUser,
      password: config.verusRpcPassword,
    },
  }
);

module.exports = {
  verusId,
  primitives,
};
