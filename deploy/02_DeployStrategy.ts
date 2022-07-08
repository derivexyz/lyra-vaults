import { getGlobalDeploys, getMarketDeploys } from '@lyrafinance/protocol';
import { ZERO_ADDRESS } from '@lyrafinance/protocol/dist/scripts/util/web3utils';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { loadParams } from '../scripts/utils';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const lyraVault = await deployments.get('LyraVault');
  const params = loadParams();

  // get lyra addresses
  const lyraGlobal = getGlobalDeploys(params.network);

  await deploy(params.contract, {
    from: deployer,
    args: [lyraVault.address, params.optionType],
    libraries: {
      BlackScholes: lyraGlobal.BlackScholes.address,
    },
    log: true,
  });

  const lyraMarket = getMarketDeploys(params.network, params.vault.market);

  // init Lyra Adapter
  await deployments.execute(
    params.contract,
    {
      from: deployer,
      log: true,
    },
    'initAdapter',
    lyraGlobal.LyraRegistry.address,
    lyraMarket.OptionMarket.address,
    ZERO_ADDRESS, // @todo: curve swap
    ZERO_ADDRESS, // @todo: basic fee counter (not yet deployed by lyra)
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
      await deployments.get(params.contract)
    ).address,
  );
  console.log('setStrategy complete...');
};
export default func;
func.tags = ['DeployStrategy'];
