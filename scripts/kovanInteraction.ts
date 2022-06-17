import {
  getGlobalDeploys,
  getMarketDeploys,
  lyraConstants as constants,
  lyraUtils as utils,
  TestSystem,
} from '@lyrafinance/protocol';
import { Contract, ethers } from 'ethers';
import { execute, loadEnv } from './utils';

async function main() {
  // 1. setup deployer and network
  const envVars = loadEnv();
  const provider = new ethers.providers.JsonRpcProvider(`https://optimism-kovan.infura.io/v3/${envVars.INFURA_KEY}`);
  const privateKey = envVars.PRIVATE_KEY; // enter address with ETH
  const deployer = new ethers.Wallet(privateKey, provider);

  // 2. get lyra contracts
  let lyraGlobal = getGlobalDeploys('kovan-ovm');
  let lyraMarket = getMarketDeploys('kovan-ovm', 'sETH');

  const testFaucet = new Contract(lyraGlobal.TestFaucet.address, lyraGlobal.TestFaucet.abi, deployer);
  const sUSD = new Contract(lyraGlobal.QuoteAsset.address, lyraGlobal.QuoteAsset.abi, deployer);
  const optionMarket = new Contract(lyraMarket.OptionMarket.address, lyraMarket.OptionMarket.abi, deployer);

  // 3. call lyra
  await execute(testFaucet, 'drip', [] as any, provider); // skip as addresses already has liquidity
  await execute(sUSD, 'approve', [optionMarket.address, constants.MAX_UINT], provider);

  const tradeParams = {
    strikeId: 5,
    positionId: 0,
    iterations: 3,
    optionType: TestSystem.OptionType.LONG_CALL,
    amount: utils.toBN('1'),
    setCollateralTo: utils.toBN('0'),
    minTotalCost: utils.toBN('0'),
    maxTotalCost: constants.MAX_UINT,
  };
  await execute(optionMarket, 'openPosition', [tradeParams], provider);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
