import { lyraConstants, lyraCore, lyraEvm, lyraUtils, TestSystemContractsType } from '@lyrafinance/core';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import chai, { expect } from 'chai';
import { solidity } from 'ethereum-waffle';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
chai.use(solidity);

describe('Example script to setup lyra for local testnet', () => {
  let account: SignerWithAddress;
  let testSystem: TestSystemContractsType;

  let boardIds: BigNumber[];
  let strikeIds: BigNumber[];

  let snap: number;

  before(async () => {
    [account] = await ethers.getSigners();
    const enableTracer = true; // call with yarn test test/integration-tests lyraDeployTest.ts --log
    testSystem = await lyraCore.deploy(account, enableTracer);
    await lyraCore.seed(account, testSystem);
  });

  beforeEach(async () => {
    snap = await lyraEvm.takeSnapshot();
  });

  afterEach(async () => {
    await lyraEvm.restoreSnapshot(snap);
  });

  it('will pay out long calls', async () => {
    boardIds = await testSystem.optionMarket.getLiveBoards();
    strikeIds = await testSystem.optionMarket.getBoardStrikes(boardIds[0]);
    const strike = await testSystem.optionMarket.getStrike(strikeIds[0]);
    expect(strike.strikePrice).eq(lyraUtils.toBN('1500'));

    // One long call
    await testSystem.optionMarket.openPosition({
      strikeId: strikeIds[0],
      positionId: 0,
      amount: lyraUtils.toBN('1'),
      setCollateralTo: 0,
      iterations: 1,
      minTotalCost: 0,
      maxTotalCost: lyraConstants.MAX_UINT,
      optionType: lyraCore.OptionType.LONG_CALL,
    });

    await lyraEvm.fastForward(lyraConstants.MONTH_SEC);
    await testSystem.mockSNX.exchangeRates.setRateAndInvalid(
      lyraUtils.toBytes32('sETH'),
      lyraUtils.toBN('2000'),
      false,
    );

    await testSystem.optionMarket.settleExpiredBoard(boardIds[0]);
    expect(await testSystem.liquidityPool.totalOutstandingSettlements()).to.eq(lyraUtils.toBN('500'));

    const preBalance = await testSystem.mockSNX.quoteAsset.balanceOf(account.address);
    await testSystem.shortCollateral.settleOptions([strikeIds[0]]);
    const postBalance = await testSystem.mockSNX.quoteAsset.balanceOf(account.address);
    expect(postBalance.sub(preBalance)).to.eq(lyraUtils.toBN('500'));
  });
});
