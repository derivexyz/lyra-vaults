import { getGlobalDeploys, getMarketDeploys } from '@lyrafinance/protocol';
import * as hre from 'hardhat';
import { loadParams } from './utils';

// make sure to run with `yarn verify --network kovan-ovm`
async function main() {
  const params = loadParams();
  const { deployer } = await hre.getNamedAccounts();
  const lyraGlobal = getGlobalDeploys(params.network);
  const lyraMarket = getMarketDeploys(params.network, params.vault.market);

  // LyraVault
  await hre.run('verify:verify', {
    address: (await hre.deployments.get('LyraVault')).address,
    constructorArguments: [
      lyraGlobal.QuoteAsset.address,
      deployer, // feeRecipient,
      params.vault.roundDuration,
      params.vault.tokenName,
      params.vault.tokenSymbol,
      {
        decimals: params.vault.decimals,
        cap: params.vault.cap,
        asset: params.vault.depositAsset === 'quote' ? lyraGlobal.QuoteAsset.address : lyraMarket.BaseAsset.address,
      },
    ],
  });

  // Strategy: currently failing due to size of LyraAdapter... should use interfaces in adapter...
  await hre.run('verify:verify', {
    address: (await hre.deployments.get(params.contract)).address,
    constructorArguments: [(await hre.deployments.get('LyraVault')).address, params.optionType],
  });
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
