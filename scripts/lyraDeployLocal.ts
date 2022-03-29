import { lyraCore, lyraUtils } from '@lyrafinance/core';
import { InitOverrides } from '@lyrafinance/core/dist/test/utils/deployTestSystem';
import { ethers } from 'ethers';

async function main() {
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
  const overrides: InitOverrides = {
    minCollateralParams: {
      ...lyraCore.defaultParams.minCollateralParams,
      minStaticBaseCollateral: lyraUtils.toBN('0.001'),
    },
  };

  const localTestSystem = await lyraCore.deploy(deployer, false, exportAddresses, overrides);
  await lyraCore.seed(deployer, localTestSystem);

  // // 3. add new BTC market
  // let newMarketSystem = await addNewMarketSystem(deployer, localTestSystem, 'sBTC', exportAddresses)
  // await seedNewMarketSystem(deployer, localTestSystem, newMarketSystem)

  // 4. get global contracts
  const lyraGlobal = lyraCore.getGlobalContracts('local');
  console.log('contract name:', lyraGlobal.SynthetixAdapter.contractName);
  console.log('address:', lyraGlobal.SynthetixAdapter.address);
  console.log('abi:', lyraGlobal.SynthetixAdapter.abi);
  console.log('bytecode:', lyraGlobal.SynthetixAdapter.bytecode.slice(0, 20) + '...');

  // 5. get market contracts
  const lyraMarket = lyraCore.getMarketContracts('local', 'sETH');
  console.log('contract name:', lyraMarket.OptionMarket.contractName);
  console.log('address:', lyraMarket.OptionMarket.address);
  console.log('abi:', lyraMarket.OptionMarket.abi);
  console.log('bytecode:', lyraMarket.OptionMarket.bytecode.slice(0, 20) + '...');
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
