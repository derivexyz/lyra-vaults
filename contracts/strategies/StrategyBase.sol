//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

// Hardhat
import "hardhat/console.sol";

// Lyra
import {LyraAdapter} from "@lyrafinance/protocol/contracts/periphery/LyraAdapter.sol";

// Libraries
import {Vault} from "../libraries/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LyraVault} from "../core/LyraVault.sol";
import {DecimalMath} from "@lyrafinance/protocol/contracts/synthetix/DecimalMath.sol";
import {SignedDecimalMath} from "@lyrafinance/protocol/contracts/synthetix/SignedDecimalMath.sol";

contract StrategyBase is LyraAdapter {
  using DecimalMath for uint;
  using SignedDecimalMath for int;

  LyraVault public immutable vault;
  OptionType public immutable optionType;

  /// @dev asset used as collateral in AMM to sell. Should be the same as vault asset
  IERC20 public collateralAsset;

  mapping(uint => uint) public lastTradeTimestamp;

  uint[] public activeStrikeIds;
  mapping(uint => uint) public strikeToPositionId;

  ///////////
  // ADMIN //
  ///////////

  modifier onlyVault() virtual {
    require(msg.sender == address(vault), "only Vault");
    _;
  }

  constructor(LyraVault _vault, OptionType _optionType) LyraAdapter() {
    vault = _vault;
    optionType = _optionType;
  }

  function initAdapter(
    address _lyraRegistry,
    address _optionMarket,
    address _curveSwap,
    address _feeCounter
  ) external onlyOwner {
    // set addresses for LyraAdapter
    _setLyraAddresses(_lyraRegistry, _optionMarket, _curveSwap, _feeCounter);

    quoteAsset.approve(address(vault), type(uint).max);
    baseAsset.approve(address(vault), type(uint).max);
    collateralAsset = _isBaseCollat() ? baseAsset : quoteAsset;
  }

  ///////////////////
  // VAULT ACTIONS //
  ///////////////////

  /**
   * @dev exchange asset back to collateral asset and send it back to the vault
   * @dev override this function if you want to customize asset management flow
   */
  function _returnFundsToVault() internal virtual {
    ExchangeRateParams memory exchangeParams = _getExchangeParams();
    uint quoteBal = quoteAsset.balanceOf(address(this));

    if (_isBaseCollat()) {
      // exchange quote asset to base asset, and send base asset back to vault
      uint baseBal = baseAsset.balanceOf(address(this));
      uint minQuoteExpected = quoteBal.divideDecimal(exchangeParams.spotPrice).multiplyDecimal(
        DecimalMath.UNIT - exchangeParams.baseQuoteFeeRate
      );
      uint baseReceived = _exchangeFromExactQuote(quoteBal, minQuoteExpected);
      require(baseAsset.transfer(address(vault), baseBal + baseReceived), "failed to return funds from strategy");
    } else {
      // send quote balance directly
      require(quoteAsset.transfer(address(vault), quoteBal), "failed to return funds from strategy");
    }
  }

  /////////////////////////////
  // Trade Parameter Helpers //
  /////////////////////////////

  /**
   * @dev Automatically decide between close and forceClose
   * depending on whether deltaCutoff or tradingCutoff are crossed
   */

  function _closeOrForceClosePosition(
    OptionPosition memory position,
    uint closeAmount,
    uint minTotalCost,
    uint maxTotalCost,
    address lyraRewardRecipient
  ) internal {
    // closes excess position with premium balance

    // if it's a full close, take out our collateral as well.
    uint setCollateralTo = position.amount == closeAmount ? 0 : position.collateral;

    TradeInputParameters memory tradeParams = TradeInputParameters({
      strikeId: position.strikeId,
      positionId: position.positionId,
      iterations: 3,
      optionType: optionType,
      amount: closeAmount,
      setCollateralTo: setCollateralTo,
      minTotalCost: minTotalCost,
      maxTotalCost: maxTotalCost,
      rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
    });

    TradeResult memory result;
    if (!_isOutsideDeltaCutoff(position.strikeId) && !_isWithinTradingCutoff(position.strikeId)) {
      result = _closePosition(tradeParams);
    } else {
      // will pay less competitive price to close position but bypasses Lyra delta/trading cutoffs
      result = _forceClosePosition(tradeParams);
    }
    require(result.totalCost <= maxTotalCost, "premium paid is above max expected premium");
  }

  /**
   * @dev get minimum premium that the vault should receive.
   * param listingId lyra option listing id
   * param size size of trade in Lyra standard sizes
   */
  function _getPremiumLimit(
    Strike memory strike,
    uint vol,
    uint size
  ) internal view returns (uint limitPremium) {
    ExchangeRateParams memory exchangeParams = _getExchangeParams();
    (uint callPremium, uint putPremium) = _getPurePremium(
      _getSecondsToExpiry(strike.expiry),
      vol,
      exchangeParams.spotPrice,
      strike.strikePrice
    );

    limitPremium = _isCall() ? callPremium.multiplyDecimal(size) : putPremium.multiplyDecimal(size);
  }

  /**
   * @dev use latest optionMarket delta cutoff to determine whether trade delta is out of bounds
   */
  function _isOutsideDeltaCutoff(uint strikeId) internal view returns (bool) {
    MarketParams memory marketParams = _getMarketParams();
    int callDelta = _getDeltas(_toDynamic(strikeId))[0];
    return callDelta > (int(DecimalMath.UNIT) - marketParams.deltaCutOff) || callDelta < marketParams.deltaCutOff;
  }

  /**
   * @dev use latest optionMarket trading cutoff to determine whether trade is too close to expiry
   */
  function _isWithinTradingCutoff(uint strikeId) internal view returns (bool) {
    MarketParams memory marketParams = _getMarketParams();
    Strike memory strike = _getStrikes(_toDynamic(strikeId))[0];
    return strike.expiry - block.timestamp <= marketParams.tradingCutoff;
  }

  //////////////////////////////
  // Active Strike Management //
  //////////////////////////////

  /**
   * @dev add strike id to activeStrikeIds array
   */
  function _addActiveStrike(uint strikeId, uint tradedPositionId) internal {
    if (!_isActiveStrike(strikeId)) {
      strikeToPositionId[strikeId] = tradedPositionId;
      activeStrikeIds.push(strikeId);
    }
  }

  /**
   * @dev add the last traded timestamp for a specific strike.
   */
  function _setLastTradedAt(uint strikeId, uint timestamp) internal {
    lastTradeTimestamp[strikeId] = timestamp;
  }

  /**
   * @dev remove position data opened in the current round.
   * this can only be called after the position is settled by lyra
   **/
  function _clearAllActiveStrikes() internal {
    if (activeStrikeIds.length != 0) {
      for (uint i = 0; i < activeStrikeIds.length; i++) {
        uint strikeId = activeStrikeIds[i];
        OptionPosition memory position = _getPositions(_toDynamic(strikeToPositionId[strikeId]))[0];
        // revert if position state is not settled
        require(position.state != PositionState.ACTIVE, "cannot clear active position");
        delete strikeToPositionId[strikeId];
        delete lastTradeTimestamp[strikeId];
      }
      delete activeStrikeIds;
    }
  }

  function _isActiveStrike(uint strikeId) internal view returns (bool isActive) {
    isActive = strikeToPositionId[strikeId] != 0;
  }

  //////////
  // Misc //
  //////////

  function _isBaseCollat() internal view returns (bool isBase) {
    isBase = (optionType == OptionType.SHORT_CALL_BASE) ? true : false;
  }

  function _isCall() internal view returns (bool isCall) {
    isCall = (optionType == OptionType.SHORT_PUT_QUOTE || optionType == OptionType.LONG_PUT) ? false : true;
  }

  function _getSecondsToExpiry(uint expiry) internal view returns (uint) {
    require(block.timestamp <= expiry, "timestamp expired");
    return expiry - block.timestamp;
  }

  function _abs(int val) internal pure returns (uint) {
    return val >= 0 ? uint(val) : uint(-val);
  }

  function _min(uint x, uint y) internal pure returns (uint) {
    return (x < y) ? x : y;
  }

  function _max(uint x, uint y) internal pure returns (uint) {
    return (x > y) ? x : y;
  }

  // temporary fix - eth core devs promised Q2 2022 fix
  function _toDynamic(uint val) internal pure returns (uint[] memory dynamicArray) {
    dynamicArray = new uint[](1);
    dynamicArray[0] = val;
  }
}
