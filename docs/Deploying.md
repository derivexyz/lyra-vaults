# Deploying

Deployments are done through the `hardhat-deploy` plug-in via the `yarn hardhat deploy --network NETWORK --export PATH` command which will kick-off the below three scripts: 
1. 01_Vault.ts - deploys the vault using the `network, market, roundDuration, tokenName, tokenSymbol, decimals and cap` params
2. 02_DeployStrategy.ts - deploys the strategy contract using the `contract, optionType and network` params. The `contract` param determines the type of strategy contract to use (e.g. DeltaLongStrategy.sol vs DeltaShortStrategy.sol) 
3. 03_SetStrategy.ts - loads a specific strategy detail to the strategy contract using the `strategyDetail` field just as `maxDeltaGap`, `minVol`, `maxVol` and etc. 

All of the above params are loaded from `deployments/params.json`. 

### Verifying contracts

Call `yarn verifyVault:goerli` or `yarn verifyVault:mainnet` to etherscan verify the deployed contracts.

### Deployments Addresses

It is recommended that you set the `PATH` field to `deployments/YOUR_NETWORK/deployments.json` when calling `yarn hardhat deploy --network NETWORK export PATH`. All of the deployed contracts will show up here. 

### Dedeploying Contracts

`hardhat-deploy` will skip scripts if the contract is already deployed. To redeploy, delete all the contents of the `deployments/goerli-ovm` folder (insert another network name if different).

### Local Deployment

To deploy a vault locally, you must first deploy a mock Lyra market to your local network (see `scripts/lyraDeployLocal.ts`). Note, you may need to manually (1) add your desired expiries and strikes (2) mint sUSD/sETH for the depositors. Once Lyra mock is deployed, set the network in `deployments/params.json` and in `yardhat deploy --network NETWORK --export deployments/NETWORK/deployments.json` to `local. 


