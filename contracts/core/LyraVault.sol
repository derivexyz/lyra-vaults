//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {OptionMarket} from "@lyrafinance/core/contracts/OptionMarket.sol";

import {BaseVault} from "./BaseVault.sol";
import {DeltaStrategy} from "../strategies/DeltaStrategy.sol";
import {VaultAdapter} from "@lyrafinance/core/contracts/periphery/VaultAdapter.sol";
import {ISynthetix} from "../interfaces/ISynthetix.sol";
import {Vault} from "../libraries/Vault.sol";

/// @notice LyraVault help users run option-selling strategies on Lyra AMM.
contract LyraVault is Ownable, BaseVault {
  using SafeMath for uint;

  OptionMarket public immutable optionMarket;

  ISynthetix public immutable synthetix;

  IERC20 public immutable premiumAsset;
  IERC20 public immutable collateralAsset;

  DeltaStrategy public strategy;

  // Amount locked for scheduled withdrawals last week;
  uint128 public lastQueuedWithdrawAmount;
  // % of funds to be used for weekly option purchase
  uint public optionAllocation;

  /// @dev Synthetix currency key for sUSD
  bytes32 private immutable premiumCurrencyKey;

  /// @dev Synthetix currency key for sETH
  bytes32 private immutable sETHCurrencyKey;

  event StrategyUpdated(address strategy);

  event Trade(address user, uint positionId, uint premium);

  event RoundStarted(uint16 roundId, uint104 lockAmount);

  event RoundClosed(uint16 roundId, uint104 lockAmount);

  constructor(
    address _optionMarket,
    address _susd,
    address _feeRecipient,
    address _synthetix,
    uint _roundDuration,
    string memory _tokenName,
    string memory _tokenSymbol,
    Vault.VaultParams memory _vaultParams,
    bytes32 _premiumCurrencyKey,
    bytes32 _sETHCurrencyKey
  ) BaseVault(_feeRecipient, _roundDuration, _tokenName, _tokenSymbol, _vaultParams) {
    optionMarket = OptionMarket(_optionMarket);
    synthetix = ISynthetix(_synthetix);
    premiumAsset = IERC20(_susd);
    collateralAsset = IERC20(_vaultParams.asset);

    premiumCurrencyKey = _premiumCurrencyKey;
    sETHCurrencyKey = _sETHCurrencyKey;

    // allow synthetix to trade sUSD for sETH
    collateralAsset.approve(_optionMarket, type(uint).max);
    premiumCurrencyKey.approve(_synthetix, type(uint).max);
  }

  /// @dev set strategy contract. This function can only be called by owner.
  function setStrategy(address _strategy) external onlyOwner {
    strategy = DeltaStrategy(_strategy);
    collateralAsset.approve(_strategy, type(uint).max);
    premiumCurrencyKey.approve(_strategy, type(uint).max);
    emit StrategyUpdated(_strategy);
  }

  /// @dev anyone can trigger a trade
  function trade(uint boardId) external {
    require(vaultState.roundInProgress, "round closed");

    (VaultAdapter.Strike memory strike,
    uint collateralToAdd)
      = strategy.getRequiredCollateral(boardId);

    // open a short call position on lyra and collect premium
    uint collateralBefore = IERC20(vaultParams.asset).balanceOf(address(this));

    // todo: detail strategy
    // perform trade through strategy
    (uint positionId, uint realPremium) = strategy.doTrade(
      strike, collateralToAdd, address(0)
    );

    uint collateralAfter = IERC20(vaultParams.asset).balanceOf(address(this));

    uint assetUsed = collateralBefore.sub(collateralAfter);

    // update the remaining locked amount
    vaultState.lockedAmountLeft = vaultState.lockedAmountLeft.sub(assetUsed);

    // require(realPremium >= minPremium, "premium too low");

    require(strategy.checkPostTrade(), "bad trade");

    // exhcnage sUSD to sETH
    synthetix.exchange(premiumCurrencyKey, realPremium, sETHCurrencyKey);

    // todo: udpate events
    emit Trade(msg.sender, positionId, realPremium);
  }

  function balanceCollateral() external {
    return true;
  }

  /// @notice settle outstanding short positions.
  /// @dev anyone can call the function to settle outstanding expired positions
  /// @param listingIds an array of listingId that the vault traded with in the last round.
  function settle(uint[] memory listingIds) external {
    // eth call options are settled in eth
    // todo: update to Avalon interface
  }

  /// @dev close the current round, enable user to deposit for the next round
  function closeRound() external onlyOwner {
    uint104 lockAmount = vaultState.lockedAmount;
    vaultState.lastLockedAmount = lockAmount;
    vaultState.lockedAmountLeft = 0;
    vaultState.lockedAmount = 0;
    vaultState.nextRoundReadyTimestamp = block.timestamp.add(Vault.ROUND_DELAY);
    vaultState.roundInProgress = false;

    // todo: add check on whether options were settled.

    emit RoundClosed(vaultState.round, lockAmount);
  }

  /// @notice start the next round
  function startNextRound(uint boardId) external {
    require(!vaultState.roundInProgress, "round opened");
    require(block.timestamp > vaultState.nextRoundReadyTimestamp, "CD");
    require(strategy.isValidBoard(boardId), "invalid board");
    strategy.clearAllActiveStrikes();

    (uint lockedBalance, uint queuedWithdrawAmount) = _rollToNextRound(uint(lastQueuedWithdrawAmount));

    vaultState.lockedAmount = uint104(lockedBalance);
    vaultState.lockedAmountLeft = lockedBalance;
    vaultState.roundInProgress = true;
    lastQueuedWithdrawAmount = uint128(queuedWithdrawAmount);

    emit RoundStarted(vaultState.round, uint104(lockedBalance));
  }
}
