import * as hre from 'hardhat';
// import { loadParams } from './utils';

// make sure to run with `yarn verify --network goerli-ovm`
async function main() {
  //   const params = loadParams();
  const { deployer } = await hre.getNamedAccounts();
  //   const lyraGlobal = getGlobalDeploys(params.network);
  //   const lyraMarket = getMarketDeploys(params.network, params.vault.market);

  const { deployments, getNamedAccounts } = hre;

  // LyraVault
  await deployments.execute(
    'LyraVault',
    {
      from: deployer,
      log: true,
      gasLimit: 15000000,
    },
    'trade',
    45, // strikeId
  );
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
