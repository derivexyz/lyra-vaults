import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { loadStrategyParams } from '../scripts/utils';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deployer } = await getNamedAccounts();
  const strategyParams = loadStrategyParams();

  // set strategyDetail
  await deployments.execute(
    strategyParams.contract,
    {
      from: deployer,
      log: true,
    },
    'setStrategyDetail',
    strategyParams.strategyDetail,
  );
  console.log('setStrategyDetail complete...');
};
export default func;
func.tags = ['SetStrategy'];
