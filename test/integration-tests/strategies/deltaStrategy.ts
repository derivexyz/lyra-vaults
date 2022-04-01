import { lyraConstants, lyraEvm, TestSystem } from '@lyrafinance/core';
import { toBN } from '@lyrafinance/core/dist/scripts/util/web3utils';
import { TestSystemContractsType } from '@lyrafinance/core/dist/test/utils/deployTestSystem';
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
  targetDelta: toBN('0.2'),
  maxDeltaGap: toBN('0.05'), // accept delta from 0.15~0.25
  minVol: toBN('0.8'), // min vol to sell. (also used to calculate min premium for call selling vault)
  maxVol: toBN('1.3'), // max vol to sell.
  size: toBN('10'),
  minTradeInterval: 600,
};

describe('Delta Strategy integration test', async () => {
  // mocked tokens
  let susd: MockERC20;
  let seth: MockERC20;

  let lyraTestSystem: TestSystemContractsType;
  // let lyraGlobal: LyraGlobal;
  // let lyraETHMarkets: LyraMarket;
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
    baseIV: '0.9',
    strikePrices: ['2500', '3000', '3200', '3400', '3500'],
    skews: ['1.1', '1', '1.1', '1.3', '1.3'],
  };
  const initialPoolDeposit = toBN('1500000'); // 1m

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[8];
    randomUser2 = addresses[9];
  });

  before('deploy lyra core', async () => {
    lyraTestSystem = await TestSystem.deploy(deployer, false, false);
    // lyraGlobal = lyraCore.getGlobalContracts('local');

    // lyraETHMarkets = lyraCore.getMarketContracts('local', 'sETH');

    await TestSystem.seed(deployer, lyraTestSystem, {
      initialBoard: boardParameter,
      initialBasePrice: spotPrice,
      initialPoolDeposit: initialPoolDeposit,
    });

    // assign test tokens
    seth = lyraTestSystem.snx.baseAsset as MockERC20;
    susd = lyraTestSystem.snx.quoteAsset as MockERC20;

    // set boardId
    const boards = await lyraTestSystem.optionMarket.getLiveBoards();
    boardId = boards[0];

    await lyraTestSystem.optionGreekCache.updateBoardCachedGreeks(boardId);

    // fast forward do vol gwap can work
    await lyraEvm.fastForward(600);
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
          BlackScholes: lyraTestSystem.blackScholes.address,
        },
      })
    )
      .connect(manager)
      .deploy(
        vault.address,
        TestSystem.OptionType.SHORT_CALL_BASE,
        lyraTestSystem.GWAVOracle.address,
      )) as DeltaStrategy;
  });

  before('initialize strategy and adaptor', async () => {
    // todo: remove this once we put everything in constructor
    await strategy.connect(manager).initAdapter(
      lyraTestSystem.testCurve.address, // curve swap
      lyraTestSystem.optionToken.address,
      lyraTestSystem.optionMarket.address,
      lyraTestSystem.liquidityPool.address,
      lyraTestSystem.shortCollateral.address,
      lyraTestSystem.synthetixAdapter.address,
      lyraTestSystem.optionMarketPricer.address,
      lyraTestSystem.optionGreekCache.address,
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
      expect(await strategy.optionType()).to.be.eq(TestSystem.OptionType.SHORT_CALL_BASE);
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
    it('will not trade when delta is out of range"', async () => {
      const strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
      // 2500 is a bad strike because delta is close to 1
      await expect(vault.connect(randomUser).trade(strikes[0])).to.be.revertedWith('invalid strike');

      // 3000 is a bad strike because delta is close to 0.5
      await expect(vault.connect(randomUser).trade(strikes[1])).to.be.revertedWith('invalid strike');

      // 3200 is a bad strike (delta is close to 0.34)
      await expect(vault.connect(randomUser).trade(strikes[2])).to.be.revertedWith('invalid strike');
    });

    it('will trade when delta and vol are within range', async () => {
      const strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
      // 3400 is a good strike
      await vault.connect(randomUser).trade(strikes[3]);
      //todo: more checks
    });

    it('should revert when min premium < premium calculated with min vol', async () => {
      const strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
      // 3500 is good strike with reasonable delta, but won't go through because premium will be too low.
      await expect(vault.connect(randomUser).trade(strikes[4])).to.be.revertedWith('TotalCostOutsideOfSpecifiedBounds');
    });
  });
});
