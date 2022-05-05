import '@eth-optimism/plugins/hardhat/compiler';
import { lyraContractPaths } from '@lyrafinance/protocol/dist/test/utils/package/index-paths';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-waffle';
import '@typechain/hardhat';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import 'hardhat-contract-sizer';
import 'hardhat-dependency-compiler';
import 'hardhat-gas-reporter';
import 'hardhat-tracer';
import 'solidity-coverage';

dotenv.config();

const mnemonic = fs.existsSync('.secret')
  ? fs.readFileSync('.secret').toString().trim()
  : 'test test test test test test test test test test test junk';

const etherscanKey = process.env.ETHERSCAN_KEY;

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

export default {
  networks: {
    hardhat: {},
    local: {
      url: 'http://127.0.0.1:8545',
      accounts: { mnemonic },
      gasPrice: 0,
    },
    kovan: {
      url: 'https://kovan.infura.io/v3/',
    },
    'local-ovm': {
      url: 'http://127.0.0.1:8545',
      accounts: { mnemonic },
      gasPrice: 0,
      ovm: true,
    },
    'kovan-ovm': {
      url: 'https://kovan.optimism.io',
      ovm: true,
    },
  },
  solidity: {
    version: '0.8.9',
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
    },
  },
  // typechain: {
  //   outDir: 'typechain',
  //   target: 'ethers-v5',
  // },
  contractSizer: {
    alphaSort: true,
  },
  etherscan: {
    apiKey: etherscanKey,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
  },
  dependencyCompiler: {
    paths: lyraContractPaths,
  },
};
