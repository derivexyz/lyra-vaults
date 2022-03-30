import { lyraConstants, lyraCore } from '@lyrafinance/core';
import { toBN } from '@lyrafinance/core/dist/scripts/util/web3utils';
import { TestSystemContractsType } from '@lyrafinance/core/dist/test/utils/deployTestSystem';
import { LyraGlobal, LyraMarket } from '@lyrafinance/core/dist/test/utils/package/parseFiles';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { DeltaStrategy, LyraVault, MockERC20 } from '../../../typechain-types';
import { DeltaStrategyDetailStruct } from '../../../typechain-types/DeltaStrategy';

const defaultDeltaStrategyDetail: DeltaStrategyDetailStruct = {
  collatBuffer: toBN('1.2'),
  collatPercent: toBN('0.8'),
  maxVolVariance: toBN('0.1'),
  gwavPeriod: 600,
  minTimeToExpiry: lyraConstants.DAY_SEC,
  maxTimeToExpiry: lyraConstants.WEEK_SEC * 2,
  targetDelta: toBN('0.35'),
  maxDeltaGap: toBN('0.1'),
  minVol: toBN('0.9'), // min vol to sell
  maxVol: toBN('1.3'), // max vol to sell
  size: toBN('10'),
  minTradeInterval: 600,
};

describe('Delta Strategy integration test', async () => {
  // mocked tokens
  let susd: MockERC20;
  let seth: MockERC20;

  let lyraTestSystem: TestSystemContractsType;
  let lyraGlobal: LyraGlobal;
  let lyraETHMarkets: LyraMarket;
  let vault: LyraVault;
  let strategy: DeltaStrategy;

  // roles
  let deployer: SignerWithAddress;
  let manager: SignerWithAddress;
  let randomUser: SignerWithAddress;
  let randomUser2: SignerWithAddress;

  // testing parameters
  const spotPrice = toBN('3000');
  let boardId = BigNumber.from(0);
  const boardParameter = {
    expiresIn: lyraConstants.DAY_SEC * 7,
    baseIV: '0.8',
    strikePrices: ['2500', '3000', '3200', '3500'],
    skews: ['0.9', '1', '1.1', '1.1'],
  };
  const initialPoolDeposit = '1000000'; // 1m

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[8];
    randomUser2 = addresses[9];
  });

  before('deploy lyra core', async () => {
    lyraTestSystem = await lyraCore.deploy(deployer, false, true);
    lyraGlobal = lyraCore.getGlobalContracts('local');

    lyraETHMarkets = lyraCore.getMarketContracts('local', 'sETH');

    await lyraCore.seed(deployer, lyraTestSystem, spotPrice, boardParameter, initialPoolDeposit);

    // assign test tokens
    susd = lyraTestSystem.mockSNX.baseAsset;
    seth = lyraTestSystem.mockSNX.quoteAsset;

    // set boardId
    const boards = await lyraTestSystem.optionMarket.getLiveBoards();
    boardId = boards[0];

    await lyraTestSystem.optionGreekCache.updateBoardCachedGreeks(boardId);

    // fast forward do vol gwap can work
    await ethers.provider.send('evm_increaseTime', [600]);
    await ethers.provider.send('evm_mine', []);
  });

  before('deploy vault', async () => {
    const LyraVault = await ethers.getContractFactory('LyraVault');

    const cap = ethers.utils.parseEther('5000');
    const decimals = 18;

    vault = (await LyraVault.connect(manager).deploy(
      susd.address,
      manager.address, // feeRecipient,
      lyraConstants.DAY_SEC * 7,
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
      .deploy(vault.address, lyraCore.OptionType.SHORT_CALL_BASE, lyraTestSystem.GWAVOracle.address)) as DeltaStrategy;
  });

  before('initialize strategy and adaptor', async () => {
    // todo: remove this once we put everything in constructor
    await strategy.connect(manager).init(
      lyraTestSystem.testCurve.address as string, // curve swap
      lyraETHMarkets.OptionToken.address as string,
      lyraETHMarkets.OptionMarket.address as string,
      lyraETHMarkets.LiquidityPool.address as string,
      lyraETHMarkets.ShortCollateral.address as string,
      lyraTestSystem.synthetixAdapter.address as string,
      lyraETHMarkets.OptionMarketPricer.address as string,
      lyraETHMarkets.OptionGreekCache.address as string,
      susd.address, // quote
      seth.address, // base
      lyraTestSystem.basicFeeCounter.address as string,
    );
    await strategy.connect(manager).initStrategy();
  });

  before('link strategy to vault', async () => {
    await vault.connect(manager).setStrategy(strategy.address);
  });

  describe('check strategy setup', async () => {
    it('deploys with correct vault and optionType', async () => {
      expect(await strategy.vault()).to.be.eq(vault.address);
      expect(await strategy.optionType()).to.be.eq(lyraCore.OptionType.SHORT_CALL_BASE);
      expect(await strategy.gwavOracle()).to.be.eq(lyraTestSystem.GWAVOracle.address);
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

  describe('start the first round', async () => {
    before('create fake seth for users', async () => {
      await seth.mint(randomUser.address, toBN('100'));
      await seth.mint(randomUser2.address, toBN('100'));
    });
    it('user should be able to deposit through vault', async () => {
      // user 1 deposits
      await seth.connect(randomUser).approve(vault.address, toBN('50'));
      await vault.connect(randomUser).deposit(toBN('50'));
      // user 2 deposits
      await seth.connect(randomUser2).approve(vault.address, toBN('50'));
      await vault.connect(randomUser2).deposit(toBN('50'));

      const state = await vault.vaultState();
      expect(state.totalPending.eq(toBN('100'))).to.be.true;
    });
    it('manager can start round 1', async () => {
      await vault.connect(manager).startNextRound(boardId);
    });
    it('will not trade when vol is too low"', async () => {
      // all consider bad strikes because vol is too low
      const strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
      // 2500 is bad strike (vol is 0.72)
      await expect(vault.connect(randomUser).trade(strikes[0])).to.be.revertedWith('invalid strike');

      // 3000 is bad strike (vol is 0.8)
      await expect(vault.connect(randomUser).trade(strikes[1])).to.be.revertedWith('invalid strike');

      // 3200 is good strike (vol is 0.88)
      await expect(vault.connect(randomUser).trade(strikes[2])).to.be.revertedWith('invalid strike');

      // 3500 is good strike (vol is 0.88)
      await expect(vault.connect(randomUser).trade(strikes[3])).to.be.revertedWith('invalid strike');
    });
  });
});
