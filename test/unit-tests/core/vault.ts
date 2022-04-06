import { parseEther, parseUnits } from '@ethersproject/units';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { LyraVault, MockERC20, MockStrategy } from '../../../typechain-types';
import { FEE_MULTIPLIER } from '../utils/constants';

describe('Unit test: Basic LyraVault flow', async () => {
  // contract instances
  let vault: LyraVault;

  // mocked contracts
  let mockedStrategy: MockStrategy;

  let seth: MockERC20;
  let susd: MockERC20;

  // signers
  let anyone: SignerWithAddress;
  let owner: SignerWithAddress;
  let depositor: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  // fix deposit amount at 1 eth
  const depositAmount = parseEther('1');

  const performanceFee = 2 * FEE_MULTIPLIER; // 2% fee
  const managementFee = 1 * FEE_MULTIPLIER; // 1% fee
  const initCap = parseEther('50');

  let totalDeposit: BigNumber;

  // mocked premium in USD and ETH
  const roundPremiumSUSD = parseUnits('50');
  const roundPremiumInEth = parseEther('0.01');

  before('prepare signers', async () => {
    const addresses = await ethers.getSigners();
    owner = addresses[0];
    anyone = addresses[1];
    depositor = addresses[2];
    feeRecipient = addresses[3];
  });

  before('prepare mocked contracts', async () => {
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    susd = (await MockERC20Factory.deploy('Synth USD', 'sUSD')) as MockERC20;
    seth = (await MockERC20Factory.deploy('Synth ETH', 'sUSD')) as MockERC20;

    const MockStrategyFactory = await ethers.getContractFactory('MockStrategy');
    mockedStrategy = (await MockStrategyFactory.deploy(seth.address, susd.address)) as MockStrategy;
  });

  describe('deploy', async () => {
    it('should successfully deploy and set immutable addresses', async () => {
      const LyraVault = await ethers.getContractFactory('LyraVault');

      const cap = ethers.utils.parseEther('5000');
      const decimals = 18;

      vault = (await LyraVault.deploy(
        susd.address,
        owner.address, // feeRecipient,
        86400 * 7,
        'LyraVault Share',
        'Lyra VS',
        {
          decimals,
          cap,
          asset: seth.address,
        },
      )) as LyraVault;
      const params = await vault.vaultParams();
      expect(params.asset).to.be.eq(seth.address);

      expect(params.decimals).to.be.eq(decimals);

      // view functions
      expect(await vault.decimals()).to.be.eq(decimals);
    });
  });

  describe('owner settings', async () => {
    it('shoud revert when setting cap as 0', async () => {
      await expect(vault.connect(owner).setCap(0)).to.be.revertedWith('!newCap');
    });
    it('owner should be able to set a new cap', async () => {
      await vault.connect(owner).setCap(initCap);

      const params = await vault.vaultParams();
      expect(params.cap).to.be.eq(initCap);
    });
    it('owner should be able to set a new management fee', async () => {
      await vault.connect(owner).setManagementFee(managementFee);

      const fee = await vault.managementFee();
      const weeklyFee = BigNumber.from(managementFee).mul(7).div(365);
      expect(weeklyFee).to.be.eq(fee);
    });
    it("should revert when trying to set a mangement fee that's too high", async () => {
      await expect(vault.connect(owner).setManagementFee(100 * FEE_MULTIPLIER)).to.be.revertedWith(
        'Invalid management fee',
      );
    });
    it('owner should be able to set a new performance fee', async () => {
      await vault.connect(owner).setPerformanceFee(performanceFee);

      const fee = await vault.performanceFee();
      expect(fee).to.be.eq(performanceFee);
    });
    it("should revert when trying to set a performance fee that's too high", async () => {
      await expect(vault.connect(owner).setPerformanceFee(100 * FEE_MULTIPLIER)).to.be.revertedWith(
        'Invalid performance fee',
      );
    });
    it('should revert when trying to set a invalid feeRecipient high', async () => {
      await expect(vault.connect(owner).setFeeRecipient(ethers.constants.AddressZero)).to.be.revertedWith(
        '!newFeeRecipient',
      );
    });
    it('owner should be able to set a new fee recipient address', async () => {
      await vault.connect(owner).setFeeRecipient(feeRecipient.address);
      const recipient = await vault.feeRecipient();
      expect(recipient).to.be.eq(feeRecipient.address);
    });
    it('should revert if trying to set the same feeRecipient as the existing one', async () => {
      await expect(vault.connect(owner).setFeeRecipient(feeRecipient.address)).to.be.revertedWith(
        'Must be new feeRecipient',
      );
    });
  });

  describe('set strategy', async () => {
    it('should revert if called by non-owner', async () => {
      await expect(vault.connect(anyone).setStrategy(ethers.constants.AddressZero)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
    it('should be able to set strategy', async () => {
      // deploy a new mocked strategy
      await vault.connect(owner).setStrategy(mockedStrategy.address);
      expect(await vault.strategy()).to.be.eq(mockedStrategy.address);
    });
  });

  describe('basic deposit', async () => {
    it('should revert if trying to deposit 0', async () => {
      await expect(vault.connect(anyone).deposit(0)).to.be.revertedWith('!amount');
    });
    it('should revert if trying to use depositFor with amount = 0', async () => {
      await expect(vault.connect(anyone).depositFor(0, depositor.address)).to.be.revertedWith('!amount');
    });
    it('should revert if trying to deposit to a 0 address', async () => {
      await expect(vault.connect(anyone).depositFor(1, ethers.constants.AddressZero)).to.be.revertedWith('!creditor');
    });
    it('should deposit ewth into the contract', async () => {
      const initReceipt = await vault.depositReceipts(depositor.address);

      await seth.mint(depositor.address, depositAmount);
      await seth.connect(depositor).approve(vault.address, ethers.constants.MaxUint256);
      await vault.connect(depositor).deposit(depositAmount);

      const newReceipt = await vault.depositReceipts(depositor.address);

      expect(newReceipt.amount.sub(initReceipt.amount)).to.be.eq(depositAmount);
      expect(newReceipt.unredeemedShares.sub(initReceipt.unredeemedShares)).to.be.eq(0);
    });
    it('should revert if deposit amount exceed the cap', async () => {
      const depositAmount = initCap.add(1);
      await seth.mint(depositor.address, depositAmount);
      await seth.connect(depositor).approve(vault.address, ethers.constants.MaxUint256);
      await expect(vault.connect(depositor).deposit(depositAmount)).to.be.revertedWith('Exceed cap');
    });
  });

  describe('trade before first round end', async () => {
    it('should revert because the first round is not started yet', async () => {
      await expect(vault.trade(0)).to.be.revertedWith('round closed');
    });
  });

  describe('start the second round', async () => {
    it('should be able to close the previous round', async () => {
      totalDeposit = await seth.balanceOf(vault.address);
      await vault.connect(owner).closeRound();
    });
    it('should revert if startNextRound is called by arbitrary user', async () => {
      const wrongRoundId = 1000;
      await expect(vault.connect(anyone).startNextRound(wrongRoundId)).to.be.revertedWith(
        'Ownable: caller is not the owner',
      );
    });
    it('should be able to rollover the position', async () => {
      await ethers.provider.send('evm_increaseTime', [86400]);
      await ethers.provider.send('evm_mine', []);

      const roundBefore = await vault.vaultState();
      await vault.connect(owner).startNextRound(0);
      const roundAfter = await vault.vaultState();
      expect(roundBefore.round).to.be.eq(1);
      expect(roundAfter.round).to.be.eq(2);
    });
  });

  describe.skip('trade flow tests', async () => {
    const collateralAmount = parseUnits('1');

    it('should successfully trade with returned amount', async () => {
      // send susdc to mocked strategy
      await susd.mint(mockedStrategy.address, roundPremiumSUSD);

      await mockedStrategy.setMockedTradeAmount(roundPremiumSUSD, collateralAmount);

      const sethBefore = await seth.balanceOf(vault.address);
      await vault.trade(0);
      const sethAfter = await seth.balanceOf(vault.address);
      expect(sethBefore.sub(collateralAmount).add(roundPremiumInEth)).to.be.eq(sethAfter);
    });
  });

  describe('rollover', async () => {
    before('simulate time pass', async () => {
      await ethers.provider.send('evm_increaseTime', [86400 * 7]);
      await ethers.provider.send('evm_mine', []);
    });

    it('should revert if trying to start the next round without closing the round', async () => {
      await expect(vault.startNextRound(0)).to.be.revertedWith('round opened');
    });

    it('should close the current round', async () => {
      await vault.closeRound();
    });

    it('should revert if trying to trade right now', async () => {
      await expect(vault.trade(0)).to.be.revertedWith('round closed');
    });

    it('should revert if trying to start the next round within 24 hours from close', async () => {
      await expect(vault.startNextRound(0)).to.be.revertedWith('CD');
    });

    it.skip('should roll into the next round and pay the recipient fees', async () => {
      await ethers.provider.send('evm_increaseTime', [86400]);
      await ethers.provider.send('evm_mine', []);

      const vaultStateBefore = await vault.vaultState();
      const recipientBalanceBefore = await seth.balanceOf(feeRecipient.address);

      await vault.startNextRound(0);

      const vaultStateAfter = await vault.vaultState();

      expect(vaultStateBefore.round + 1).to.be.eq(vaultStateAfter.round);

      const roundPerformanceFee = roundPremiumInEth.mul(performanceFee).div(100 * FEE_MULTIPLIER);

      const weeklyManagementFee = await vault.managementFee();
      const roundManagementFee = totalDeposit
        .add(roundPremiumInEth)
        .mul(weeklyManagementFee)
        .div(100 * FEE_MULTIPLIER);

      const recipientBalanceAfter = await seth.balanceOf(feeRecipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.be.eq(roundManagementFee.add(roundPerformanceFee));
    });
  });
});
