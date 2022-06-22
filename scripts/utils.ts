import { JsonRpcProvider } from '@ethersproject/providers';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { BigNumber, Contract, ethers } from 'ethers';
import path from 'path';

export type StrategyParams = {
  network: string;
  contract: string;
  strategyDetail: StrategyDetail;
};

export type StrategyDetail = {
  minTimeToExpiry: number;
  maxTimeToExpiry: number;
  targetDelta: BigNumber;
  maxDeltaGap: BigNumber;
  minVol: BigNumber;
  maxVol: BigNumber;
  size: BigNumber;
  minTradeInterval: number;
  maxVolVariance: BigNumber;
  gwavPeriod: number;
  collatBuffer?: BigNumber;
  collatPercent?: BigNumber;
};

export function loadEnv() {
  const defaultEnv = dotenv.config({
    path: '.env.defaults',
  }) as any;

  const privEnv = dotenv.config({
    path: path.join('.env.private'),
  }) as any;

  return {
    ...defaultEnv.parsed,
    ...privEnv.parsed,
  };
}

export function loadStrategyParams(): StrategyParams {
  const data = require(path.join(__dirname, '../deployments', 'params.json'));
  // to bypass hardhat-deploy
  const formatted = JSON.parse(JSON.stringify(data));

  Object.keys(formatted.strategyDetail).forEach(function (key) {
    if (typeof formatted.strategyDetail[key] === 'string') {
      formatted.strategyDetail[key] = ethers.utils.parseUnits(formatted.strategyDetail[key], 18);
    }
  });
  return formatted;
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

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
