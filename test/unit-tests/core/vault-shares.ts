import { BigNumber } from '@ethersproject/bignumber';
import { parseEther, parseUnits } from '@ethersproject/units';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { LyraVault, MockERC20, MockOptionMarket, MockStrategy, MockSynthetix } from '../../../typechain-types';

describe('Unit test: share calculating for pending deposit and withdraw', async () => {
  // contract instances
  let vault: LyraVault;

  // mocked contracts
  let mockedStrategy: MockStrategy;
  let mockedMarket: MockOptionMarket;
  let mockedSynthetix: MockSynthetix;

  let seth: MockERC20;
  let susd: MockERC20;

  // signers
  let anyone: SignerWithAddress;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let shrimp: SignerWithAddress; // user with dust deposit

  const roundDuration = 7 * 86400;

  // fix deposit amount at 1 eth
  const depositAmount = parseEther('1');

  // constants across tests

  // initiate withdraw 1/4 of total shares
  const initiateWithdrawSharePercentage = 0.25;
  const round3PremiumInEth = parseEther('0.1');

  before('prepare signers', async () => {
    const addresses = await ethers.getSigners();
    owner = addresses[0];
    anyone = addresses[1];
    depositor = addresses[2];
    shrimp = addresses[3];
  });

  before('prepare mocked contracts', async () => {
    const MockOptionMarketFactory = await ethers.getContractFactory('MockOptionMarket');
    mockedMarket = (await MockOptionMarketFactory.deploy()) as MockOptionMarket;

    const MockSynthetixFactory = await ethers.getContractFactory('MockSynthetix');
    mockedSynthetix = (await MockSynthetixFactory.deploy()) as MockSynthetix;

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    seth = (await MockERC20Factory.deploy('Synth ETH', 'sETH')) as MockERC20;
    susd = (await MockERC20Factory.deploy('Synth USD', 'sUSD')) as MockERC20;

    const MockStrategyFactory = await ethers.getContractFactory('MockStrategy');
    mockedStrategy = (await MockStrategyFactory.deploy(seth.address, susd.address)) as MockStrategy;
  });

  before('setup LyraVault instance, link to a mocked strategy', async () => {
    const LyraVaultFactory = await ethers.getContractFactory('LyraVault');

    const cap = parseEther('5000');
    const decimals = 18;

    vault = (await LyraVaultFactory.deploy(
      susd.address,
      owner.address, // feeRecipient,
      roundDuration,
      'LyraVault Share',
      'Lyra VS',
      {
        decimals,
        cap,
        asset: seth.address,
      },
    )) as LyraVault;

    // set strategy
    await vault.connect(owner).setStrategy(mockedStrategy.address);
  });

  before('mint asset for option market and synthetix', async () => {
    await susd.mint(mockedMarket.address, parseUnits('100000'));

    await seth.connect(anyone).mint(mockedSynthetix.address, parseEther('100'));
  });

  describe('round 1', async () => {
    describe('basic deposit and withdraw in round 1.', async () => {
      it('should return 0 share before any deposit', async () => {
        const { heldByAccount, heldByVault } = await vault.shareBalances(depositor.address);
        expect(heldByAccount).to.be.eq(0);
        expect(heldByVault).to.be.eq(0);
      });
      it('should deposit seth into the contract and update the receipt', async () => {
        const initState = await vault.vaultState();
        const initReceipt = await vault.depositReceipts(depositor.address);

        await seth.mint(depositor.address, depositAmount);
        await seth.connect(depositor).approve(vault.address, ethers.constants.MaxUint256);
        await vault.connect(depositor).deposit(depositAmount);

        const newState = await vault.vaultState();
        const newReceipt = await vault.depositReceipts(depositor.address);

        expect(newState.totalPending.sub(initState.totalPending)).to.be.eq(depositAmount);
        expect(newReceipt.amount.sub(initReceipt.amount)).to.be.eq(depositAmount);
        expect(newReceipt.unredeemedShares).to.be.eq(initReceipt.unredeemedShares);
      });
      it('should be able to use depositFor to do the same thing for depositor', async () => {
        const initReceipt = await vault.depositReceipts(depositor.address);

        await seth.connect(anyone).mint(anyone.address, depositAmount);
        await seth.connect(anyone).approve(vault.address, ethers.constants.MaxUint256);
        await vault.connect(anyone).depositFor(depositAmount, depositor.address);

        const newReceipt = await vault.depositReceipts(depositor.address);

        expect(newReceipt.amount.sub(initReceipt.amount)).to.be.eq(depositAmount);
        expect(newReceipt.unredeemedShares).to.be.eq(initReceipt.unredeemedShares);
      });

      it('should revert when using initiateWithdraw with shareNum = 0', async () => {
        await expect(vault.connect(depositor).initiateWithdraw(0)).to.be.revertedWith('!numShares');
      });

      it('should revert when using initiateWithdraw becuase user has no shares', async () => {
        const sharesToWithdraw = depositAmount;
        await expect(vault.connect(depositor).initiateWithdraw(sharesToWithdraw)).to.be.revertedWith(
          'ERC20: transfer amount exceeds balance',
        );
      });

      it('should revert when calling competeWithdraw becuase user has no pending withdraw', async () => {
        await expect(vault.connect(depositor).completeWithdraw()).to.be.revertedWith('Not initiated');
      });

      it('should revert when calling redeem becuase depositor has no unreedemed shares', async () => {
        const sharesToWithdraw = depositAmount;
        await expect(vault.connect(depositor).redeem(sharesToWithdraw)).to.be.revertedWith('Exceeds available');
      });

      it('should get 0 share if calling maxRedeem with no deposit Receipt', async () => {
        const sharesBefore = await vault.balanceOf(anyone.address);
        await vault.connect(anyone).maxRedeem();
        const sharesAfter = await vault.balanceOf(anyone.address);
        expect(sharesAfter).to.be.eq(sharesBefore);
      });

      it('should get 0 share out by calling maxRedeem becuase depositor has no unreedemed shares', async () => {
        const sharesBefore = await vault.balanceOf(depositor.address);
        await vault.connect(depositor).maxRedeem();
        const sharesAfter = await vault.balanceOf(depositor.address);
        expect(sharesAfter).to.be.eq(sharesBefore);
      });

      // test share calculations during round 1.
      it('should return 0 for shares before round ends', async () => {
        const balances = await vault.shareBalances(depositor.address);
        expect(balances.heldByVault).to.be.eq(0);
        expect(balances.heldByAccount).to.be.eq(0);

        const shares = await vault.shares(depositor.address);
        expect(shares).to.be.eq(0);
      });
      it('should return constant for price per share before first share is minted', async () => {
        const oneShare = parseEther('1');
        const price = await vault.pricePerShare();
        expect(price).to.be.eq(oneShare);
      });
      it('shuold return 0 for total balance ', async () => {
        const balance = await vault.accountVaultBalance(depositor.address);
        expect(balance).to.be.eq(0);
      });
    });

    describe('trade during first round', async () => {
      it('should revert because the first round is not started yet', async () => {
        // set mocked asset only
        await mockedMarket.setMockCollateral(seth.address, parseEther('1'));
        await mockedMarket.setMockPremium(susd.address, 0);
        const strikeIdToTrade = 0;
        await expect(vault.trade(strikeIdToTrade)).to.be.revertedWith('round closed');
      });
    });
  });

  describe('round 2: vault makes profit', async () => {
    describe('start the second round', async () => {
      it('should be able to close the previous round', async () => {
        await vault.connect(owner).closeRound();
      });
      it('stimulate time pass', async () => {
        await ethers.provider.send('evm_increaseTime', [86400]);
        await ethers.provider.send('evm_mine', []);
      });
      it('should be able to rollover the position', async () => {
        const roundBefore = await vault.vaultState();
        const boardId = 0;
        await vault.connect(owner).startNextRound(boardId);
        const roundAfter = await vault.vaultState();
        expect(roundBefore.round).to.be.eq(1);
        expect(roundAfter.round).to.be.eq(2);
      });
    });

    describe('redeem shares', async () => {
      it('should revert while redeeming 0 shares', async () => {
        await expect(vault.connect(depositor).redeem(0)).to.be.revertedWith('!numShares');
      });
      it('should has some share balance after rollover', async () => {
        const { heldByVault, heldByAccount } = await vault.shareBalances(depositor.address);
        expect(heldByAccount).to.be.eq(0);

        // has deposited 4 in total
        const expectedShares = parseEther('2');
        expect(heldByVault).to.be.eq(expectedShares);
      });

      it('should redeem some shares', async () => {
        const totalShares = await vault.shares(depositor.address);

        const redeemAmount = totalShares.div(4);
        const shareBefore = await vault.balanceOf(depositor.address);
        await vault.connect(depositor).redeem(redeemAmount);
        const shareAfter = await vault.balanceOf(depositor.address);

        expect(shareAfter.sub(shareBefore)).to.be.eq(redeemAmount);
      });
    });

    describe('deposit asset', async () => {
      it('should allow people to deposit asset into the vault', async () => {
        // mint 50 wei to shrimp, make sure he has more than 1 share
        await seth.mint(shrimp.address, 50);
        await seth.connect(shrimp).approve(vault.address, ethers.constants.MaxUint256);
        await vault.connect(shrimp).deposit(50);
      });
    });

    describe('initiate withdraw', async () => {
      let sharesToInitaiteWithrawSecond: BigNumber;
      it('should be able to initiate a withdraw, this will trigger a max redeem', async () => {
        const totalShares = await vault.shares(depositor.address);
        const totalSharesToInitiateWithdraw = totalShares.div(1 / initiateWithdrawSharePercentage);

        // only que withraw 1/8 of total shares
        const sharesToInitaiteWithrawFirst = totalSharesToInitiateWithdraw.div(2);
        sharesToInitaiteWithrawSecond = totalSharesToInitiateWithdraw.sub(sharesToInitaiteWithrawFirst);

        await vault.connect(depositor).initiateWithdraw(sharesToInitaiteWithrawFirst);

        const { heldByVault, heldByAccount } = await vault.shareBalances(depositor.address);
        expect(heldByAccount.add(sharesToInitaiteWithrawFirst)).to.be.eq(totalShares);

        expect(heldByVault).to.be.eq(0);
      });
      it('should be able to que more withdraw share amount', async () => {
        // only que withraw another 1/8
        const withdrawReceiptBefore = await vault.withdrawals(depositor.address);
        await vault.connect(depositor).initiateWithdraw(sharesToInitaiteWithrawSecond);
        const withdrawReceiptAfter = await vault.withdrawals(depositor.address);

        expect(withdrawReceiptAfter.shares.sub(withdrawReceiptBefore.shares)).to.be.eq(sharesToInitaiteWithrawSecond);
        expect(withdrawReceiptAfter.round).to.be.eq(withdrawReceiptBefore.round);
      });
    });

    describe.skip('stimulate trade', async () => {
      const collateralAmount = parseUnits('1');
      // mock premium to 300 USD
      const minPremium = parseUnits('300');

      before('set mocked response from strategy', async () => {
        // set request and check result
        await mockedStrategy.setMockedTradeAmount(minPremium, collateralAmount);

        await susd.mint(mockedStrategy.address, minPremium);
      });

      it('should successfully trade', async () => {
        const sethBefore = await seth.balanceOf(vault.address);
        const strikeId = 0;
        await vault.trade(strikeId);
        const sethAfter = await seth.balanceOf(vault.address);
        expect(sethBefore.sub(collateralAmount).add(round3PremiumInEth)).to.be.eq(sethAfter);
      });
    });

    describe('settle and close', async () => {
      // assume option expires OTM, settlement will return the origianl collateral amount
      const settlementPayout = parseEther('1');
      before('simulate time pass', async () => {
        await ethers.provider.send('evm_increaseTime', [roundDuration]);
        await ethers.provider.send('evm_mine', []);
      });
      before('set mock settle data', async () => {
        await mockedMarket.setMockSettlement(settlementPayout);

        // send seth to mock mark
        await seth.connect(anyone).mint(mockedMarket.address, settlementPayout);
      });
      it('should revert if trying to completeWithdraw', async () => {
        await expect(vault.connect(depositor).completeWithdraw()).to.be.revertedWith('Round in progress');
      });
      it('should rollover the vault to the next round', async () => {
        await vault.closeRound();
      });
    });
  });

  describe('round 3: vault lose money', async () => {
    before('rollover to round 3', async () => {
      await ethers.provider.send('evm_increaseTime', [86400]);
      await ethers.provider.send('evm_mine', []);
      const boardId = 2;
      await vault.connect(owner).startNextRound(boardId);
      const { round } = await vault.vaultState();
      expect(round).to.be.eq(3);
    });
    describe('after rollover', async () => {
      it('should revert when trying to initiateWithdraw again before completing queued withdraw', async () => {
        const sharesToWithdraw = depositAmount;
        await expect(vault.connect(depositor).initiateWithdraw(sharesToWithdraw)).to.be.revertedWith(
          'Existing withdraw',
        );
      });
      it.skip('should be able to complete withdraw from previous rounds', async () => {
        const sethBalanceBefore = await seth.balanceOf(vault.address);
        await vault.connect(depositor).completeWithdraw();
        const sethBalanceAfter = await seth.balanceOf(vault.address);

        const withdrawnAmount = sethBalanceBefore.sub(sethBalanceAfter);
        const expectedWithrawnAmount = depositAmount
          .div(2)
          .add(round3PremiumInEth.div(1 / initiateWithdrawSharePercentage));
        expect(expectedWithrawnAmount).to.be.eq(withdrawnAmount);
      });
      it('should be able to single a withdraw', async () => {
        // only initiate to withdraw 1 share, so that it will revert when we try to complete the withdraw but share price < 1.
        await vault.connect(shrimp).initiateWithdraw(1);
      });
    });
    describe.skip('stimulate a trade', async () => {
      const collateralAmount = parseUnits('1');
      const minPremium = parseUnits('400');
      const premiumInEth = parseEther('0.1');

      before('set mocked strategy amount', async () => {
        // set request and check result
        await mockedStrategy.setMockedTradeAmount(minPremium, collateralAmount);
        await susd.mint(mockedStrategy.address, minPremium);
      });

      it('should successfully trade', async () => {
        const sethBefore = await seth.balanceOf(vault.address);
        await vault.trade(0);
        const sethAfter = await seth.balanceOf(vault.address);
        expect(sethBefore.sub(collateralAmount).add(premiumInEth)).to.be.eq(sethAfter);
      });
    });

    describe.skip('settle and close', async () => {
      // assume option expires ITM, only get 40% of the collateral out!
      const settlementPayout = parseEther('0.4');
      before('simulate time pass', async () => {
        await ethers.provider.send('evm_increaseTime', [roundDuration]);
        await ethers.provider.send('evm_mine', []);
      });
      before('set mock settle data', async () => {
        await mockedMarket.setMockSettlement(settlementPayout);

        // send seth to mock mark
        await seth.connect(anyone).mint(mockedMarket.address, settlementPayout);
      });
      it('should rollover the vault to the next round', async () => {
        await vault.closeRound();
      });
    });
  });

  describe.skip('round 4', async () => {
    before('rollover to round 4', async () => {
      await ethers.provider.send('evm_increaseTime', [86400]);
      await ethers.provider.send('evm_mine', []);
      const boardId = 3;
      await vault.connect(owner).startNextRound(boardId);
    });
    it('should revert when trying to complete the withdraw, because the collateral is 0', async () => {
      await expect(vault.connect(shrimp).completeWithdraw()).to.be.revertedWith('!withdrawAmount');
    });
  });
});
