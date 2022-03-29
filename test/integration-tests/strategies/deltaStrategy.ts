import { lyraConstants, lyraCore, lyraUtils } from '@lyrafinance/core';
import { LyraGlobal } from '@lyrafinance/core/dist/test/utils/package/parseFiles';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { DeltaStrategy, LyraVault, MockERC20 } from '../../../typechain-types';
import { DeltaStrategyDetailStruct } from '../../../typechain-types/DeltaStrategy';

const defaultDeltaStrategyDetail: DeltaStrategyDetailStruct = {
  collatBuffer: lyraUtils.toBN('1.2'),
  collatPercent: lyraUtils.toBN('0.8'),
  maxVolVariance: lyraUtils.toBN('0.1'),
  gwavPeriod: 600,
  minTimeToExpiry: lyraConstants.DAY_SEC,
  maxTimeToExpiry: lyraConstants.WEEK_SEC * 2,
  targetDelta: lyraUtils.toBN('0.3'),
  maxDeltaGap: lyraUtils.toBN('0.1'),
  minVol: lyraUtils.toBN('0.5'),
  maxVol: lyraUtils.toBN('0.1'),
  size: lyraUtils.toBN('10'),
  minTradeInterval: lyraConstants.HOUR_SEC,
};

describe('Delta Strategy integration test', async () => {
  // local mock tokens
  let susd: MockERC20;
  let seth: MockERC20;

  let lyraGlobal: LyraGlobal;
  let deployer: SignerWithAddress;
  let manager: SignerWithAddress;
  let vault: LyraVault;
  let randomUser: SignerWithAddress;
  let strategy: DeltaStrategy;

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[9];
  });

  before('deploy lyra core', async () => {
    const localTestSystem = await lyraCore.deploy(deployer, false, true);
    lyraGlobal = lyraCore.getGlobalContracts('local');
    await lyraCore.seed(deployer, localTestSystem);
  });

  before('deploy mock tokens', async () => {
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    susd = (await MockERC20Factory.deploy('Synth USD', 'sUSD')) as MockERC20;
    seth = (await MockERC20Factory.deploy('Synth ETH', 'sUSD')) as MockERC20;
  });

  before('deploy vault', async () => {
    const LyraVault = await ethers.getContractFactory('LyraVault');

    const cap = ethers.utils.parseEther('5000');
    const decimals = 18;

    vault = (await LyraVault.deploy(
      susd.address,
      manager.address, // feeRecipient,
      86400 * 7,
      'LyraVault Share',
      'Lyra VS',
      {
        decimals,
        cap,
        asset: seth.address,
      },
    )) as LyraVault;
  });

  before('deploy strategy', async () => {
    strategy = (await (
      await ethers.getContractFactory('DeltaStrategy', {
        libraries: {
          BlackScholes: lyraGlobal.BlackScholes.address as string,
        },
      })
    )
      .connect(manager)
      .deploy(vault.address, lyraCore.OptionType.SHORT_CALL_BASE, lyraGlobal.GWAV.address)) as DeltaStrategy;
  });

  before('initialize strategy and adaptor', async () => {
    // todo: remove this once we put everything in constructor
  });

  describe('immutables', async () => {
    it('deploys with correct vault and optionMarket addresses', async () => {
      expect(await strategy.vault()).to.be.eq(vault.address);
    });
  });

  describe('setStrategy', async () => {
    it('setting strategy should correctly update strategy variables', async () => {
      await strategy.connect(manager).setStrategy(defaultDeltaStrategyDetail);

      const newStrategy = await strategy.currentStrategy();
      expect(newStrategy.minTimeToExpiry).to.be.eq(defaultDeltaStrategyDetail.minTimeToExpiry);
      expect(newStrategy.maxTimeToExpiry).to.be.eq(defaultDeltaStrategyDetail.maxTimeToExpiry);
      expect(newStrategy.targetDelta).to.be.eq(defaultDeltaStrategyDetail.targetDelta);
      expect(newStrategy.maxDeltaGap).to.be.eq(defaultDeltaStrategyDetail.maxDeltaGap);
      expect(newStrategy.minVol).to.be.eq(defaultDeltaStrategyDetail.minVol);
      expect(newStrategy.maxVol).to.be.eq(defaultDeltaStrategyDetail.maxVol);
      expect(newStrategy.size).to.be.eq(defaultDeltaStrategyDetail.size);
      expect(newStrategy.minTradeInterval).to.be.eq(defaultDeltaStrategyDetail.minTradeInterval);
    });

    it('should revert if setStrategy is not called by owner', async () => {
      await expect(strategy.connect(randomUser).setStrategy(defaultDeltaStrategyDetail)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
  });
});
