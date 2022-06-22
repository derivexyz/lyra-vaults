import { getGlobalDeploys, getMarketDeploys, TestSystem } from '@lyrafinance/protocol';
import { ZERO_ADDRESS } from '@lyrafinance/protocol/dist/scripts/util/web3utils';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { loadStrategyParams } from '../scripts/utils';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const lyraVault = await deployments.get('LyraVault');

  const strategyParams = loadStrategyParams();

  // get lyra addresses
  const lyraGlobal = getGlobalDeploys(strategyParams.network);

  await deploy(strategyParams.contract, {
    from: deployer,
    args: [lyraVault.address, TestSystem.OptionType.SHORT_PUT_QUOTE],
    libraries: {
      BlackScholes: lyraGlobal.BlackScholes.address,
    },
    log: true,
  });

  const lyraMarket = getMarketDeploys('kovan-ovm', 'sETH');

  // init Lyra Adapter
  await deployments.execute(
    strategyParams.contract,
    {
      from: deployer,
      log: true,
    },
    'initAdapter',
    lyraGlobal.LyraRegistry.address,
    lyraMarket.OptionMarket.address,
    ZERO_ADDRESS, // curve swap
    ZERO_ADDRESS, // basic fee counter (not yet deployed by lyra)
  );
  console.log('initAdapter complete...');

  // link strategy to vault
  await deployments.execute(
    'LyraVault',
    {
      from: deployer,
      log: true,
    },
    'setStrategy',
    (
      await deployments.get(strategyParams.contract)
    ).address,
  );
  console.log('setStrategy complete...');
};
export default func;
func.tags = ['DeployStrategy'];
