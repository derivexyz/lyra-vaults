import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { loadParams } from '../scripts/utils';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deployer } = await getNamedAccounts();
  const params = loadParams();

  // set strategyDetail
  await deployments.execute(
    params.contract,
    {
      from: deployer,
      log: true,
    },
    'setStrategyDetail',
    params.strategyDetail,
  );
  console.log('setStrategyDetail complete...');
};
export default func;
func.tags = ['SetStrategy'];
