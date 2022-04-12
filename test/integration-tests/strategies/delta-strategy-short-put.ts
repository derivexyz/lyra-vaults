import { lyraConstants, lyraEvm, TestSystem } from '@lyrafinance/core';
import { toBN } from '@lyrafinance/core/dist/scripts/util/web3utils';
import { DEFAULT_PRICING_PARAMS } from '@lyrafinance/core/dist/test/utils/defaultParams';
import { TestSystemContractsType } from '@lyrafinance/core/dist/test/utils/deployTestSystem';
import { PricingParametersStruct } from '@lyrafinance/core/dist/typechain-types/OptionMarketViewer';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { DeltaStrategy, LyraVault, MockERC20 } from '../../../typechain-types';
import { DeltaStrategyDetailStruct, OptionPositionStructOutput } from '../../../typechain-types/DeltaStrategy';
import { strikeIdToDetail } from './utils';

const defaultDeltaStrategyDetail: DeltaStrategyDetailStruct = {
  collatBuffer: toBN('1.5'), // multiplier of minimum required collateral
  collatPercent: toBN('0.35'), // percentage of full collateral
  maxVolVariance: toBN('0.1'),
  gwavPeriod: 600,
  minTimeToExpiry: lyraConstants.DAY_SEC,
  maxTimeToExpiry: lyraConstants.WEEK_SEC * 2,
  targetDelta: toBN('0.2').mul(-1),
  maxDeltaGap: toBN('0.05'), // accept delta from 0.15~0.25
  minVol: toBN('0.8'), // min vol to sell. (also used to calculate min premium for call selling vault)
  maxVol: toBN('1.3'), // max vol to sell.
  size: toBN('15'),
  minTradeInterval: 600,
};

describe('Short Put Delta Strategy integration test', async () => {
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
    baseIV: '0.8',
    strikePrices: ['2500', '2600', '2700', '2800', '2900', '3000', '3100'],
    skews: ['1.3', '1.2', '1.1', '1', '1.1', '1.3', '1.3'],
  };
  const initialPoolDeposit = toBN('1500000'); // 1.5m

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[8];
    randomUser2 = addresses[9];
  });

  before('deploy lyra core', async () => {
    const pricingParams: PricingParametersStruct = {
      ...DEFAULT_PRICING_PARAMS,
      standardSize: toBN('10'),
      spotPriceFeeCoefficient: toBN('0.001'),
    };

    lyraTestSystem = await TestSystem.deploy(deployer, true, false, { pricingParams });

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

    const cap = ethers.utils.parseEther('5000000'); // 5m USD as cap
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
        asset: susd.address,
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
        TestSystem.OptionType.SHORT_PUT_QUOTE,
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
  });

  before('link strategy to vault', async () => {
    await vault.connect(manager).setStrategy(strategy.address);
  });

  describe('check strategy setup', async () => {
    it('deploys with correct vault and optionType', async () => {
      expect(await strategy.optionType()).to.be.eq(TestSystem.OptionType.SHORT_PUT_QUOTE);
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
  });

  describe('start the first round', async () => {
    let strikes: BigNumber[] = [];
    before('create fake susd for users', async () => {
      await susd.mint(randomUser.address, toBN('100000'));
      await susd.mint(randomUser2.address, toBN('100000'));
    });
    before('set strikes array', async () => {
      strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
    });
    it('user should be able to deposit through vault', async () => {
      // user 1 deposits
      await susd.connect(randomUser).approve(vault.address, lyraConstants.MAX_UINT);
      await vault.connect(randomUser).deposit(toBN('50000'));
      // user 2 deposits
      await susd.connect(randomUser2).approve(vault.address, lyraConstants.MAX_UINT);
      await vault.connect(randomUser2).deposit(toBN('50000'));

      const state = await vault.vaultState();
      expect(state.totalPending.eq(toBN('100000'))).to.be.true;
    });
    it('manager can start round 1', async () => {
      await vault.connect(manager).startNextRound(boardId);
    });

    it('will not trade when delta is out of range"', async () => {
      // 2500, 2600, 2800 are bad strike based on delta
      await expect(vault.connect(randomUser).trade(strikes[0])).to.be.revertedWith('invalid strike');
      await expect(vault.connect(randomUser).trade(strikes[1])).to.be.revertedWith('invalid strike');
      await expect(vault.connect(randomUser).trade(strikes[4])).to.be.revertedWith('invalid strike');
    });

    it('should revert when premium > max premium calculated with max vol', async () => {
      await expect(vault.connect(randomUser).trade(strikes[3])).to.be.revertedWith('TotalCostOutsideOfSpecifiedBounds');
    });

    it('should trade when delta and vol are within range', async () => {
      const strikeObj = await strikeIdToDetail(lyraTestSystem.optionMarket, strikes[2]);
      const [collateralToAdd] = await strategy.getRequiredCollateral(strikeObj);

      const vaultStateBefore = await vault.vaultState();
      const strategySUSDBalance = await susd.balanceOf(strategy.address);

      // 3400 is a good strike
      await vault.connect(randomUser).trade(strikeObj.id);

      const vaultStateAfter = await vault.vaultState();
      const strategySUDCBalanceAfter = await susd.balanceOf(strategy.address);

      // check state.lockAmount left is updated
      expect(vaultStateBefore.lockedAmountLeft.sub(vaultStateAfter.lockedAmountLeft).eq(collateralToAdd)).to.be.true;
      // check that we receive sUSD
      expect(strategySUDCBalanceAfter.sub(strategySUSDBalance).gt(0)).to.be.true;

      // active strike is updated
      const storedStrikeId = await strategy.activeStrikeIds(0);
      expect(storedStrikeId.eq(strikeObj.id)).to.be.true;

      // check that position size is correct
      const positionId = await strategy.strikeToPositionId(storedStrikeId);
      const [position] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      expect(position.amount.eq(defaultDeltaStrategyDetail.size)).to.be.true;
      expect(position.collateral.eq(collateralToAdd)).to.be.true;
    });

    it('should revert when user try to trigger another trade during cooldown', async () => {
      await expect(vault.connect(randomUser).trade(strikes[2])).to.be.revertedWith('min time interval not passed');
    });

    it('should be able to trade a higher strike if spot price goes up', async () => {
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('3200'), 'sETH');

      // triger with new strike (2900)
      await vault.connect(randomUser).trade(strikes[4]);

      // check that active strikes are updated
      const storedStrikeId = await strategy.activeStrikeIds(1);
      expect(storedStrikeId.eq(strikes[4])).to.be.true;
      const positionId = await strategy.strikeToPositionId(storedStrikeId);
      const [position] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      expect(position.amount.eq(defaultDeltaStrategyDetail.size)).to.be.true;
    });

    const additionalDepositAmount = toBN('25000');
    it('can add more deposit during the round', async () => {
      await vault.connect(randomUser).deposit(additionalDepositAmount);
      const state = await vault.vaultState();
      expect(state.totalPending.eq(additionalDepositAmount)).to.be.true;
      const receipt = await vault.depositReceipts(randomUser.address);
      expect(receipt.amount.eq(additionalDepositAmount)).to.be.true;
    });
    it('fastforward to the expiry', async () => {
      await lyraEvm.fastForward(boardParameter.expiresIn);
    });
    it('should be able to close closeRound after settlement', async () => {
      await lyraTestSystem.optionMarket.settleExpiredBoard(boardId);
      const susdInStrategyBefore = await susd.balanceOf(strategy.address);
      const usdInVaultBefore = await susd.balanceOf(vault.address);

      // settle all positions, from 1 to highest position
      const totalPositions = (await lyraTestSystem.optionToken.nextId()).sub(1).toNumber();
      const idsToSettle = Array.from({ length: totalPositions }, (_, i) => i + 1); // create array of [1... totalPositions]
      await lyraTestSystem.shortCollateral.settleOptions(idsToSettle);

      const susdInStrategyAfterSettlement = await susd.balanceOf(strategy.address);

      // collateral should be back into the strategy after settlement
      expect(susdInStrategyAfterSettlement.sub(susdInStrategyBefore).gt(0)).to.be.true;

      await vault.closeRound();

      const susdInStrategyAfter = await susd.balanceOf(strategy.address);
      const susdInVaultAfter = await susd.balanceOf(vault.address);

      // strategy should be empty after close round
      expect(susdInStrategyAfter.isZero()).to.be.true;

      // all sUSD in strategy should go back to the vault
      expect(susdInVaultAfter.sub(usdInVaultBefore).eq(susdInStrategyAfterSettlement));
    });
  });
  describe('start round 2', async () => {
    let strikes: BigNumber[] = [];
    let position: OptionPositionStructOutput;
    let strikePrice: BigNumber;
    let positionId: BigNumber;
    let expiry: BigNumber;
    let snapshot: number;
    let strategySUSDBalanceBefore: BigNumber;
    before('prepare before new round start', async () => {
      // set price back to initial spot price
      await TestSystem.marketActions.mockPrice(lyraTestSystem, spotPrice, 'sETH');

      // initiate withdraw for later test
      await vault.connect(randomUser2).initiateWithdraw(toBN('50000'));
    });
    before('create new board', async () => {
      await TestSystem.marketActions.createBoard(lyraTestSystem, boardParameter);
      const boards = await lyraTestSystem.optionMarket.getLiveBoards();
      boardId = boards[0];

      strikes = await lyraTestSystem.optionMarket.getBoardStrikes(boardId);
    });

    before('start the next round', async () => {
      await lyraEvm.fastForward(lyraConstants.DAY_SEC);
      await vault.connect(manager).startNextRound(boardId);
    });

    before('should be able to complete the withdraw', async () => {
      const susdBefore = await seth.balanceOf(randomUser2.address);

      await vault.connect(randomUser2).completeWithdraw();

      const susdAfter = await susd.balanceOf(randomUser2.address);

      expect(susdAfter.sub(susdBefore).gt(toBN('50000'))).to.be.true;
    });

    beforeEach(async () => {
      snapshot = await lyraEvm.takeSnapshot();

      strategySUSDBalanceBefore = await susd.balanceOf(strategy.address);
      await vault.connect(randomUser).trade(strikes[2]);

      [strikePrice, expiry] = await lyraTestSystem.optionMarket.getStrikeAndExpiry(strikes[2]);
      positionId = await strategy.strikeToPositionId(strikes[2]);
      position = (await lyraTestSystem.optionToken.getOptionPositions([positionId]))[0];
    });

    afterEach(async () => {
      await lyraEvm.restoreSnapshot(snapshot);
    });

    it('should recieve premium', async () => {
      const strategySUDCBalanceAfter = await susd.balanceOf(strategy.address);
      expect(strategySUDCBalanceAfter.sub(strategySUSDBalanceBefore).gt(0)).to.be.true;
    });

    it('should revert when trying to reduce a safe position', async () => {
      const fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry);
      expect(fullCloseAmount).to.be.eq(0);
      await expect(vault.connect(randomUser).reducePosition(positionId, toBN('10000'))).to.be.revertedWith(
        'amount exceeds allowed close amount',
      );
    });

    it('reduce full position if unsafe position + delta is in range', async () => {
      // 13% crash
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('2600'), 'sETH');
      const positionId = await strategy.strikeToPositionId(strikes[2]); // 2700 strike
      const preReduceBal = await susd.balanceOf(strategy.address);

      const fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry.sub(10)); //account for time passing
      expect(fullCloseAmount).to.be.gt(0);
      await vault.connect(randomUser).reducePosition(positionId, fullCloseAmount);
      const postReduceBal = await susd.balanceOf(strategy.address);
      expect(postReduceBal).to.be.lt(preReduceBal);
    });

    it('partially reduce position if unsafe position + delta is in range', async () => {
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('2600'), 'sETH');
      const preReduceBal = await susd.balanceOf(strategy.address);

      const fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry.sub(10)); //account for time passing
      expect(fullCloseAmount).to.be.gt(0);
      await vault.connect(randomUser).reducePosition(positionId, fullCloseAmount.div(2));
      const postReduceBal = await susd.balanceOf(strategy.address);
      expect(postReduceBal).to.be.lt(preReduceBal);
    });

    it('revert reduce position if unsafe position + close amount too large', async () => {
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('2250'), 'sETH');
      const fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry.sub(10)); //account for time passing
      expect(fullCloseAmount).to.be.gt(0);
      await expect(vault.connect(randomUser).reducePosition(positionId, fullCloseAmount.mul(2))).to.be.revertedWith(
        'amount exceeds allowed close amount',
      );
    });

    it('partially reduce position with force close if delta out of range', async () => {
      await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('2000'), 'sETH');

      const [positionBefore] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      const fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry.sub(10)); //account for time passing
      expect(fullCloseAmount).to.be.gt(0);

      // send strategy some usdc so they can successfully reduce position
      await susd.mint(strategy.address, toBN('50000'));

      await vault.connect(randomUser).reducePosition(positionId, fullCloseAmount.div(2));
      const [positionAfter] = await lyraTestSystem.optionToken.getOptionPositions([positionId]);

      expect(positionBefore.amount.sub(positionAfter.amount)).to.be.gt(0);
    });
  });
});
