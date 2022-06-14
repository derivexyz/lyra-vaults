// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {Vault} from "./Vault.sol";

library ShareMath {
  function assetToShares(
    uint assetAmount,
    uint assetPerShare,
    uint decimals
  ) internal pure returns (uint) {
    // If this throws, it means that vault's roundPricePerShare[currentRound] has not been set yet
    // which should never happen.
    require(assetPerShare > 0, "Invalid assetPerShare");

    return (assetAmount * (10**decimals)) / (assetPerShare);
  }

  function sharesToAsset(
    uint shares,
    uint assetPerShare,
    uint decimals
  ) internal pure returns (uint) {
    // If this throws, it means that vault's roundPricePerShare[currentRound] has not been set yet
    // which should never happen.
    require(assetPerShare > 0, "Invalid assetPerShare");

    return (shares * assetPerShare) / (10**decimals);
  }

  /**
   * @notice Returns the shares unredeemed by the user given their DepositReceipt
   * @param depositReceipt is the user's deposit receipt
   * @param currentRound is the `round` stored on the vault
   * @param assetPerShare is the price in asset per share
   * @param decimals is the number of decimals the asset/shares use
   * @return unredeemedShares is the user's virtual balance of shares that are owed
   */
  function getSharesFromReceipt(
    Vault.DepositReceipt memory depositReceipt,
    uint currentRound,
    uint assetPerShare,
    uint decimals
  ) internal pure returns (uint unredeemedShares) {
    if (depositReceipt.round > 0 && depositReceipt.round < currentRound) {
      uint sharesFromRound = assetToShares(depositReceipt.amount, assetPerShare, decimals);

      return uint(depositReceipt.unredeemedShares) + sharesFromRound;
    }
    return depositReceipt.unredeemedShares;
  }

  function pricePerShare(
    uint totalSupply,
    uint totalBalance,
    uint pendingAmount,
    uint decimals
  ) internal pure returns (uint) {
    uint singleShare = 10**decimals;
    return totalSupply > 0 ? (singleShare * (totalBalance - pendingAmount)) / (totalSupply) : singleShare;
  }

  /************************************************
   *  HELPERS
   ***********************************************/

  function assertUint104(uint num) internal pure {
    require(num <= type(uint104).max, "Overflow uint104");
  }

  function assertUint128(uint num) internal pure {
    require(num <= type(uint128).max, "Overflow uint128");
  }
}
