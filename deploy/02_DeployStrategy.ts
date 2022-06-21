import { getGlobalDeploys, getMarketDeploys, TestSystem } from '@lyrafinance/protocol';
import { ZERO_ADDRESS } from '@lyrafinance/protocol/dist/scripts/util/web3utils';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const lyraVault = await deployments.get('LyraVault');

  // get lyra addresses
  const lyraGlobal = getGlobalDeploys('kovan-ovm');

  await deploy('DeltaShortStrategy', {
    from: deployer,
    args: [lyraVault.address, TestSystem.OptionType.SHORT_PUT_QUOTE],
    libraries: {
      BlackScholes: lyraGlobal.BlackScholes.address,
    },
    log: true,
  });

  const lyraMarket = getMarketDeploys('kovan-ovm', 'sETH');

  await deployments.execute(
    'DeltaShortStrategy',
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
  console.log('executed...');
};
export default func;
func.tags = ['DeltaShortStrategy'];
