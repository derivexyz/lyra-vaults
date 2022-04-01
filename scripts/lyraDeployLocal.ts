import { getGlobalDeploys, getMarketDeploys, lyraConstants, lyraUtils, TestSystem } from '@lyrafinance/core';
import { toBN } from '@lyrafinance/core/dist/scripts/util/web3utils';
import { DeployOverrides } from '@lyrafinance/core/dist/test/utils/deployTestSystem';
import { ethers } from 'ethers';
async function main() {
  /////////////////////////////////////
  // Deploy Lyra market on localhost //
  /////////////////////////////////////

  // 1. get local deployer and network
  const provider = new ethers.providers.JsonRpcProvider('http://localhost:8545');

  const privateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // enter address with ETH
  provider.getGasPrice = async () => {
    return ethers.BigNumber.from('0');
  };
  provider.estimateGas = async () => {
    return ethers.BigNumber.from(15000000);
  }; // max limit to prevent run out of gas errors
  const deployer = new ethers.Wallet(privateKey, provider);

  // 2. deploy and seed market with overrides
  const exportAddresses = true;
  const enableTracer = false;
  const overrides: DeployOverrides = {
    minCollateralParams: {
      ...TestSystem.defaultParams.minCollateralParams,
      minStaticBaseCollateral: lyraUtils.toBN('0.001'),
    },
  };

  const localTestSystem = await TestSystem.deploy(deployer, enableTracer, exportAddresses, overrides);
  await TestSystem.seed(deployer, localTestSystem);

  // 3. open position
  await localTestSystem.optionMarket.openPosition({
    strikeId: 1,
    positionId: 0,
    amount: toBN('1'),
    setCollateralTo: toBN('0'),
    iterations: 3,
    optionType: TestSystem.OptionType.LONG_CALL,
    minTotalCost: toBN('0'),
    maxTotalCost: toBN('500'),
  });

  // // 3. add new BTC market
  // let newMarketSystem = await addNewMarketSystem(deployer, localTestSystem, 'sBTC', exportAddresses)
  // await seedNewMarketSystem(deployer, localTestSystem, newMarketSystem)

  ///////////////////////////////////////////////////
  // Interact with kovan-ovm/mainnet-ovm contracts //
  ///////////////////////////////////////////////////

  // 'local' used here as example, but can pass in 'kovan-ovm' or 'mainnet-ovm' instead of 'local'.
  // 1. get global contracts
  const lyraGlobal = getGlobalDeploys('local');
  console.log('contract name:', lyraGlobal.SynthetixAdapter.contractName);
  console.log('address:', lyraGlobal.SynthetixAdapter.address);
  // console.log('abi:', lyraGlobal.SynthetixAdapter.abi);
  // console.log('bytecode:', lyraGlobal.SynthetixAdapter.bytecode.slice(0, 20) + '...');

  // 2. get market contracts
  const lyraMarket = getMarketDeploys('local', 'sETH');
  console.log('contract name:', lyraMarket.OptionMarket.contractName);
  console.log('address:', lyraMarket.OptionMarket.address);
  // console.log('abi:', lyraMarket.OptionMarket.abi);
  // console.log('bytecode:', lyraMarket.OptionMarket.bytecode.slice(0, 20) + '...');

  const tradeInput = {
    strikeId: 1,
    positionId: 0,
    iterations: 1,
    optionType: TestSystem.OptionType.LONG_CALL,
    amount: lyraUtils.toBN('1'),
    setCollateralTo: lyraUtils.toBN('0'),
    minTotalCost: 0,
    maxTotalCost: lyraConstants.MAX_UINT,
  };
  const tx = await localTestSystem.optionMarket.openPosition(tradeInput);
  console.log('Tx', (await tx.wait()).transactionHash);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
