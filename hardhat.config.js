/// ENVVAR
// - CI:                output gas report to file instead of stdout
// - COVERAGE:          enable coverage report
// - ENABLE_GAS_REPORT: enable gas report
// - COMPILE_MODE:      production modes enables optimizations (default: development)
// - COMPILE_VERSION:   compiler version (default: 0.8.9)
// - COINMARKETCAP:     coinmarkercat api key for USD value in gas report
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-waffle")
require('dotenv').config()
const fs = require('fs');
const path = require('path');
const argv = require('yargs/yargs')()
  .env('')
  .options({
    ci: {
      type: 'boolean',
      default: false,
    },
    coverage: {
      type: 'boolean',
      default: false,
    },
    gas: {
      alias: 'enableGasReport',
      type: 'boolean',
      default: false,
    },
    mode: {
      alias: 'compileMode',
      type: 'string',
      choices: ['production', 'development'],
      default: 'development',
    },
    compiler: {
      alias: 'compileVersion',
      type: 'string',
      default: '0.8.17',
    },
    coinmarketcap: {
      alias: 'coinmarketcapApiKey',
      type: 'string',
    },
  })
  .argv;

require('@nomiclabs/hardhat-truffle5');

if (argv.enableGasReport) {
  require('hardhat-gas-reporter');
}

require('hardhat-contract-sizer');

for (const f of fs.readdirSync(path.join(__dirname, 'hardhat'))) {
  require(path.join(__dirname, 'hardhat', f));
}

const withOptimizations = argv.enableGasReport || argv.compileMode === 'production';

const pk1 = process.env.PK_1 || '';
const pk2 = process.env.PK_2 || '';

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: argv.compiler,
    settings: {
      optimizer: {
        enabled: withOptimizations,
        runs: 999999,
      },
    },
  },
  networks: {
    hardhat: {
      blockGasLimit: 10000000,
      allowUnlimitedContractSize: !withOptimizations,
    },


    fuji: {
      url: 'https://api.avax-test.network/ext/bc/C/rpc',
      accounts: [pk1, pk2],
      chainId: 43113,
      live: true,
      saveDeployments: true,
      // tags: ['staging'],
      // gasMultiplier: 4,
      // gas: 800000000,
      // gasPrice: 25000000000,
    },
    'oasis-test': {
      url: 'https://testnet.emerald.oasis.dev',
      accounts: [pk1, pk2],
      chainId: 42261,
      live: true,
      saveDeployments: true,
      // tags: ['staging'],
      // gasMultiplier: 4,
      gas: 800000,
      gasPrice: 250000000000,
    },
    'thunder-core-testnet': {
      url: 'https://testnet-rpc.thundercore.com',
      accounts: [pk1, pk2],
      chainId: 18,
      live: true,
      saveDeployments: true,
      gas: 2000000,
      gasPrice: 350000000000,
    },
  },
  gasReporter: {
    currency: 'USD',
    outputFile: argv.ci ? 'gas-report.txt' : undefined,
    coinmarketcap: argv.coinmarketcap,
  },
  contractSizer: {
    runOnCompile: true,
    disambiguatePaths: false,
  },
  solidity: {
    version: '0.8.17',
    settings: {
      optimizer: {
        enabled: true,
        runs: 50000
      }
    }
  },
  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    sources: "./contracts",
    tests: "./test",
    deploy: "./deploy",
    deployments: "./deployments",
  },
};

if (argv.coverage) {
  require('solidity-coverage');
  module.exports.networks.hardhat.initialBaseFeePerGas = 0;
}
