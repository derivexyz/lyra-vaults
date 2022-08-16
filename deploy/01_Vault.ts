import { getGlobalDeploys, getMarketDeploys } from '@lyrafinance/protocol';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { loadParams, Params } from '../scripts/utils';

// run with `yarn hardhat deploy --network goerli-ovm --export deployments/goerli-ovm/deployments.json`
// also set "network: goerli-ovm" in the params.json folder.

// `hardhat.config.ts` uses `.env.defaults/private` to assign deployer address

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;

  const { deployer } = await getNamedAccounts();
  const params = loadParams() as Params;

  // get lyra addresses
  const lyraGlobal = getGlobalDeploys(params.network);
  const lyraMarket = getMarketDeploys(params.network, params.vault.market);

  await deploy('LyraVault', {
    from: deployer,
    args: [
      lyraGlobal.QuoteAsset.address,
      deployer, // feeRecipient,
      params.vault.roundDuration,
      params.vault.tokenName,
      params.vault.tokenSymbol,
      {
        decimals: params.vault.decimals,
        cap: params.vault.cap,
        // vault deposit asset depends on strategy
        asset: params.vault.depositAsset === 'quote' ? lyraGlobal.QuoteAsset.address : lyraMarket.BaseAsset.address,
      },
    ],
    log: true,
  });
};
export default func;
func.tags = ['LyraVault'];
