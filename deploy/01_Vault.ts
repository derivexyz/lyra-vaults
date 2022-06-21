import { getGlobalDeploys, getMarketDeploys, lyraConstants } from '@lyrafinance/protocol';
import { ethers } from 'ethers';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

// run with `yarn hardhat deploy --network kovan-ovm --export deployments/kovan-ovm/deployments.json`

// `hardhat.config.ts` uses `.env.defaults/private` to assign deployer address

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;

  // const envVars = loadEnv();
  // const deployer = new ethers.Wallet(envVars.PRIVATE_KEY);
  const { deployer } = await getNamedAccounts();

  // get lyra addresses
  const lyraGlobal = getGlobalDeploys('kovan-ovm');
  const lyraMarket = getMarketDeploys('kovan-ovm', 'sETH');

  console.log(deployer);
  await deploy('LyraVault', {
    from: deployer,
    args: [
      lyraGlobal.QuoteAsset.address,
      deployer, // feeRecipient,
      lyraConstants.DAY_SEC * 7,
      'LyraVault Share',
      'Lyra VS',
      {
        decimals: 18,
        cap: ethers.utils.parseEther('100000'),
        asset: lyraMarket.BaseAsset.address,
      },
    ],
    log: true,
  });
};
export default func;
func.tags = ['LyraVault'];
