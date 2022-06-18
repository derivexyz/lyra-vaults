import { JsonRpcProvider } from '@ethersproject/providers';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Contract } from 'ethers';
import path from 'path';

export function loadEnv() {
  const defaultEnv = dotenv.config({
    path: 'scripts/.env.defaults',
  }) as any;

  const privEnv = dotenv.config({
    path: path.join('scripts', '.env.private'),
  }) as any;

  return {
    ...defaultEnv.parsed,
    ...privEnv.parsed,
  };
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
