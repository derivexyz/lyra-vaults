import { lyraConstants, lyraDefaultParams, TestSystem, TestSystemContractsType } from '@lyrafinance/protocol';
import { toBN } from '@lyrafinance/protocol/dist/scripts/util/web3utils';
import { TradeInputParametersStruct } from '@lyrafinance/protocol/dist/typechain-types/BasicOptionMarketWrapper';
import * as dotenv from 'dotenv';
import { ethers } from 'hardhat';

dotenv.config();

// THIS SCRIPT IS EXPERIMENTAL

// This script deploys all real SNX contracts to localhost and deploys Lyra markets on top of them.
// You can use the files in .snx to tune SNX deployment params.
async function main() {
  // 0. Must run `yarn hardhat node` first
  // 1. Setup
  const provider = new ethers.providers.JsonRpcProvider('http://localhost:8545');
  const privateKey = process.env.PRIVATE_KEY as string;

  provider.getGasPrice = async () => {
    return ethers.BigNumber.from('0');
  };
  provider.estimateGas = async () => {
    return ethers.BigNumber.from(15000000);
  };
  const deployer = new ethers.Wallet(privateKey, provider);

  // 2. Deploy Lyra with real SNX
  let lyraTestSystem: TestSystemContractsType;
  lyraTestSystem = await TestSystem.deploy(deployer, false, true, {
    mockSNX: false,
    compileSNX: true, // can set to false if already compiled once to speed up script
    optionMarketParams: { ...lyraDefaultParams.OPTION_MARKET, feePortionReserved: toBN('0.05') },
  });

  await TestSystem.seed(deployer, lyraTestSystem);

  // 3. Open position
  await lyraTestSystem.optionMarket.openPosition({
    strikeId: 1,
    positionId: 0,
    iterations: 1,
    optionType: TestSystem.OptionType.LONG_CALL,
    amount: toBN('1'),
    setCollateralTo: 0,
    minTotalCost: 0,
    maxTotalCost: lyraConstants.MAX_UINT,
  } as TradeInputParametersStruct);

  console.log('Opened positions...');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
