import { JsonRpcProvider } from '@ethersproject/providers';
import {
  getGlobalDeploys,
  getMarketDeploys,
  lyraConstants as constants,
  lyraUtils as utils,
  TestSystem,
} from '@lyrafinance/protocol';
import chalk from 'chalk';
import { Contract, ethers } from 'ethers';

async function main() {
  // 1. setup deployer and network
  const provider = new ethers.providers.JsonRpcProvider(
    'https://optimism-kovan.infura.io/v3/561ebceae957407ea6699a474aa4f7b0',
  );
  const privateKey = '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e'; // enter address with ETH
  const deployer = new ethers.Wallet(privateKey, provider);

  // 2. get lyra contracts
  let lyraGlobal = await getGlobalDeploys('kovan-ovm');
  let lyraMarket = await getMarketDeploys('kovan-ovm', 'sETH');

  // const testFaucet = new Contract(lyraGlobal.TestFaucet.address, lyraGlobal.TestFaucet.abi, deployer);
  const sUSD = new Contract(lyraGlobal.QuoteAsset.address, lyraGlobal.QuoteAsset.abi, deployer);
  const optionMarket = new Contract(lyraMarket.OptionMarket.address, lyraMarket.OptionMarket.abi, deployer);

  // 3. call lyra
  // await execute(testFaucet, 'drip', [] as any, provider); // skip as addresses already has liquidity
  await execute(sUSD, 'approve', [optionMarket.address, constants.MAX_UINT], provider);

  const tradeParams = {
    strikeId: 5,
    positionId: 0,
    iterations: 3,
    optionType: TestSystem.OptionType.LONG_CALL,
    amount: utils.toBN('1'),
    setCollateralTo: utils.toBN('0'),
    minTotalCost: utils.toBN('0'),
    maxTotalCost: constants.MAX_UINT,
  };
  await execute(optionMarket, 'openPosition', [tradeParams], provider);
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function execute(contract: Contract, func: string, args: any[], provider: JsonRpcProvider) {
  while (true) {
    try {
      console.log(chalk.grey(`Executing ${contract.address}`));
      let overrides: any = { gasLimit: 15000000 };
      let tx = await contract[func](...args, overrides);
      while ((await provider.getTransactionReceipt(tx.hash)) == null) {
        await sleep(100);
      }
      let receipt = await tx.wait();
      console.log(`Gas used for tx ${chalk.blueBright(receipt.transactionHash)}:`, receipt.gasUsed.toNumber());
      return tx;
    } catch (e) {
      if (e instanceof Error) {
        console.log(e.message.slice(0, 27));
        if (e.message.slice(0, 27) == 'nonce has already been used') {
          continue;
        }
        throw e;
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
