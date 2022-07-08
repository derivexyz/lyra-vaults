// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vault} from "./Vault.sol";
import {ShareMath} from "./ShareMath.sol";

import {IERC20Detailed} from "../interfaces/IERC20Detailed.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev copied from Ribbon's VaultLifeCycle, changed to internal library for gas optimization
 */
library VaultLifecycle {
  using SafeMath for uint;
  using SafeERC20 for IERC20;

  /**
   * @notice Calculate the shares to mint, new price per share,
   *         and amount of funds to re-allocate as collateral for the new round
   * @param currentShareSupply is the total supply of shares
   * @param asset is the address of the vault's asset
   * @param decimals is the decimals of the asset
   * @param pendingAmount is the amount of funds pending from recent deposits
   * @return newLockedAmount is the amount of funds to allocate for the new round
   * @return queuedWithdrawAmount is the amount of funds set aside for withdrawal
   * @return newPricePerShare is the price per share of the new round
   * @return mintShares is the amount of shares to mint from deposits
   */
  function rollover(
    uint currentShareSupply,
    address asset,
    uint decimals,
    uint pendingAmount,
    uint queuedWithdrawShares
  )
    internal
    view
    returns (
      uint newLockedAmount,
      uint queuedWithdrawAmount,
      uint newPricePerShare,
      uint mintShares
    )
  {
    uint currentBalance = IERC20(asset).balanceOf(address(this));

    newPricePerShare = ShareMath.pricePerShare(currentShareSupply, currentBalance, pendingAmount, decimals);

    // After closing the short, if the options expire in-the-money
    // vault pricePerShare would go down because vault's asset balance decreased.
    // This ensures that the newly-minted shares do not take on the loss.
    uint _mintShares = ShareMath.assetToShares(pendingAmount, newPricePerShare, decimals);

    uint newSupply = currentShareSupply.add(_mintShares);

    uint queuedWithdraw = newSupply > 0 ? ShareMath.sharesToAsset(queuedWithdrawShares, newPricePerShare, decimals) : 0;

    return (currentBalance.sub(queuedWithdraw), queuedWithdraw, newPricePerShare, _mintShares);
  }

  /**
   * @notice Calculates the performance and management fee for this week's round
   * @param vaultState is the struct with vault accounting state
   * @param currentLockedBalance is the amount of funds currently locked in opyn
   * @param performanceFeePercent is the performance fee pct.
   * @param managementFeePercent is the management fee pct.
   * @return performanceFeeInAsset is the performance fee
   * @return managementFeeInAsset is the management fee
   * @return vaultFee is the total fees
   */
  function getVaultFees(
    Vault.VaultState storage vaultState,
    uint currentLockedBalance,
    uint performanceFeePercent,
    uint managementFeePercent
  )
    internal
    view
    returns (
      uint performanceFeeInAsset,
      uint managementFeeInAsset,
      uint vaultFee
    )
  {
    uint prevLockedAmount = vaultState.lastLockedAmount;

    uint lockedBalanceSansPending = currentLockedBalance.sub(vaultState.totalPending);

    uint _performanceFeeInAsset;
    uint _managementFeeInAsset;
    uint _vaultFee;

    // Take performance fee and management fee ONLY if difference between
    // last week and this week's vault deposits, taking into account pending
    // deposits and withdrawals, is positive. If it is negative, last week's
    // option expired ITM past breakeven, and the vault took a loss so we
    // do not collect performance fee for last week

    // todo: update management fee to exclude profit?
    if (lockedBalanceSansPending > prevLockedAmount) {
      _performanceFeeInAsset = performanceFeePercent > 0
        ? lockedBalanceSansPending.sub(prevLockedAmount).mul(performanceFeePercent).div(100 * Vault.FEE_MULTIPLIER)
        : 0;
      _managementFeeInAsset = managementFeePercent > 0
        ? lockedBalanceSansPending.mul(managementFeePercent).div(100 * Vault.FEE_MULTIPLIER)
        : 0;

      _vaultFee = _performanceFeeInAsset.add(_managementFeeInAsset);
    }

    return (_performanceFeeInAsset, _managementFeeInAsset, _vaultFee);
  }
}
