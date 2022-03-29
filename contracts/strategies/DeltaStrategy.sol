//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
pragma experimental ABIEncoderV2;

// Hardhat
import "hardhat/console.sol";

// Lyra
import {VaultAdapter} from "@lyrafinance/core/contracts/periphery/VaultAdapter.sol";
import {GWAVOracle} from "@lyrafinance/core/contracts/periphery/GWAVOracle.sol";

// Libraries
import {Vault} from "../libraries/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LyraVault} from "../core/LyraVault.sol";
import {DecimalMath} from "@lyrafinance/core/contracts/synthetix/DecimalMath.sol";
import {SignedDecimalMath} from "@lyrafinance/core/contracts/synthetix/SignedDecimalMath.sol";

contract DeltaStrategy is VaultAdapter {
  using DecimalMath for uint;
  using SignedDecimalMath for int;

  LyraVault public immutable vault;
  OptionType public immutable optionType;
  GWAVOracle public immutable gwavOracle;
  IERC20 public immutable collateralAsset;

  mapping(uint => uint) public lastTradeTimestamp;

  uint public activeExpiry;
  uint[] public activeStrikeIds;
  mapping(uint => uint) public strikeToPositionId;

  // example strategy detail
  struct DeltaStrategyDetail {
    uint collatBuffer; // multiple of vaultAdapter.minCollateral(): 1.1 -> 110% * minCollat
    uint collatPercent; // partial collateral: 0.9 -> 90% * fullCollat
    uint minTimeToExpiry;
    uint maxTimeToExpiry;
    int targetDelta;
    uint maxDeltaGap;
    uint minVol;
    uint maxVol;
    uint size;
    uint minTradeInterval;
    uint maxVolVariance;
    uint gwavPeriod;
  }

  DeltaStrategyDetail public currentStrategy;

  ///////////
  // ADMIN //
  ///////////

  constructor(
    LyraVault _vault,
    OptionType _optionType,
    GWAVOracle _gwavOracle
  ) VaultAdapter() {
    vault = _vault;
    optionType = _optionType;
    gwavOracle = _gwavOracle;

    quoteAsset.approve(address(vault), type(uint).max);
    baseAsset.approve(address(vault), type(uint).max);

    collateralAsset = _isBaseCollat() ? baseAsset : quoteAsset;
  }

  /**
   * @dev update the strategy for the new round.
   */
  function setStrategy(DeltaStrategyDetail memory _deltaStrategy) external onlyOwner {
    //todo: add requires to params
    // bool roundInProgress;
    (, , , , , , , bool roundInProgress) = vault.vaultState();
    require(!roundInProgress, "cannot change strategy if round is active");
    currentStrategy = _deltaStrategy;
  }

  ///////////////////
  // VAULT ACTIONS //
  ///////////////////

  function setBoard(uint boardId) external onlyVault {
    Board memory board = getBoard(boardId);
    require(isValidBoard(board), "invalid board");
    activeExpiry = board.expiry;
  }

  function returnFundsAndClearStrikes() external onlyVault {
    ExchangeRateParams memory exchangeParams = getExchangeParams();
    uint quoteBal = quoteAsset.balanceOf(address(this));

    uint quoteReceived = 0;
    if (_isBaseCollat()) {
      // todo: double check this
      uint baseBal = baseAsset.balanceOf(address(this));
      uint minQuoteExpected = baseBal.multiplyDecimal(exchangeParams.spotPrice).multiplyDecimal(
        DecimalMath.UNIT - exchangeParams.baseQuoteFeeRate
      );
      quoteReceived = exchangeFromExactBase(baseBal, minQuoteExpected);
    }
    require(quoteAsset.transfer(address(vault), quoteBal + quoteReceived), "failed to return funds from strategy");

    _clearAllActiveStrikes();
  }

  function doTrade(uint strikeId, address lyraRewardRecipient)
    external
    onlyVault
    returns (
      uint positionId,
      uint premiumReceived,
      uint collateralToAdd
    )
  {
    // validate trade
    Strike memory strike = getStrikes(_toDynamic(strikeId))[0];
    require(
      lastTradeTimestamp[strike.id] + currentStrategy.minTradeInterval <= block.timestamp,
      "min time interval not passed"
    );
    require(isValidStrike(strike), "invalid strike");
    require(_isValidVolVariance(strike.id), "vol variance exceeded");

    uint setCollateralTo;
    (collateralToAdd, setCollateralTo) = getRequiredCollateral(strike);

    require(
      collateralAsset.transferFrom(address(vault), address(this), collateralToAdd),
      "collateral transfer from vault failed"
    );

    (positionId, premiumReceived) = sellStrike(strike, setCollateralTo, lyraRewardRecipient);
  }

  /**
   * @dev convert size (denominated in standard sizes) to actual contract amount.
   */
  function getRequiredCollateral(Strike memory strike)
    public
    view
    returns (uint collateralToAdd, uint setCollateralTo)
  {
    uint sellAmount = currentStrategy.size;
    ExchangeRateParams memory exchangeParams = getExchangeParams();

    // get existing position info if active
    uint existingAmount = 0;
    uint existingCollateral = 0;
    if (_isActiveStrike(strike.id)) {
      OptionPosition memory position = getPositions(_toDynamic(strikeToPositionId[strike.id]))[0];
      existingCollateral = position.collateral;
      existingAmount = position.amount;
    }

    // gets minBufferCollat for the whole position
    uint minBufferCollateral = _getBufferCollateral(
      strike.strikePrice,
      strike.expiry,
      exchangeParams.spotPrice,
      existingAmount + sellAmount
    );

    // get targetCollat for this trade instance
    // prevents vault from adding excess collat just to meet targetCollat
    uint targetCollat = existingCollateral +
      _getFullCollateral(strike.strikePrice, sellAmount).multiplyDecimal(currentStrategy.collatPercent);

    // if excess collateral, keep in position to encourage more option selling
    setCollateralTo = _max(_max(minBufferCollateral, targetCollat), existingCollateral);

    // existingCollateral is never > setCollateralTo
    collateralToAdd = setCollateralTo - existingCollateral;
  }

  /**
   * request trade detail according to the strategy. Keeps premiums in contract
   * For puts, since premium is added to collateral, basically premium amount
   * is not used from the funds that are sent
   */
  function sellStrike(
    Strike memory strike,
    uint setCollateralTo,
    address lyraRewardRecipient
  ) internal returns (uint, uint) {
    // get minimum expected premium based on minIv
    uint minExpectedPremium = _getPremiumLimit(strike, true);

    // perform trade
    TradeResult memory result = openPosition(
      TradeInputParameters({
        strikeId: strike.id,
        positionId: strikeToPositionId[strike.id],
        iterations: 4,
        optionType: optionType,
        amount: currentStrategy.size,
        setCollateralTo: setCollateralTo,
        minTotalCost: minExpectedPremium,
        maxTotalCost: type(uint).max,
        rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
      })
    );
    lastTradeTimestamp[strike.id] = block.timestamp;

    // update active strikes
    _addActiveStrike(strike, result.positionId);

    require(result.totalCost >= minExpectedPremium, "premium received is below min expected premium");

    return (result.positionId, result.totalCost);
  }

  function reducePosition(uint positionId, address lyraRewardRecipient) external onlyVault {
    OptionPosition memory position = getPositions(_toDynamic(positionId))[0];
    Strike memory strike = getStrikes(_toDynamic(position.strikeId))[0];
    ExchangeRateParams memory exchangeParams = getExchangeParams();

    require(strikeToPositionId[position.strikeId] != positionId, "invalid positionId");

    // only allows closing if collat < minBuffer
    uint minCollatPerAmount = _getBufferCollateral(strike.strikePrice, strike.expiry, exchangeParams.spotPrice, 1e18);
    require(
      position.collateral < minCollatPerAmount.multiplyDecimal(position.amount),
      "position properly collateralized"
    );

    // closes excess position with premium balance
    uint closeAmount = position.amount - position.collateral.divideDecimal(minCollatPerAmount);
    uint maxExpectedPremium = _getPremiumLimit(strike, false);
    TradeResult memory result = closePosition(
      TradeInputParameters({
        strikeId: position.strikeId,
        positionId: position.positionId,
        iterations: 3,
        optionType: optionType,
        amount: closeAmount,
        setCollateralTo: position.collateral,
        minTotalCost: type(uint).min,
        maxTotalCost: maxExpectedPremium,
        rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
      })
    );

    require(result.totalCost <= maxExpectedPremium, "premium paid is above max expected premium");

    // return closed collateral amount
    if (_isBaseCollat()) {
      uint currentBal = baseAsset.balanceOf(address(this));
      baseAsset.transfer(address(vault), currentBal);
    } else {
      // quote collateral
      quoteAsset.transfer(address(vault), closeAmount);
    }
  }

  ////////////////
  // Validation //
  ////////////////

  function isValidBoard(Board memory board) public view returns (bool isValid) {
    return _isValidExpiry(board.expiry);
  }

  /**
   * @dev get the target listing id to trade on.
   * with delta vault strategy, this will check whether board is valid and
   * loop through all listingIds until target delta is found
   */
  function isValidStrike(Strike memory strike) public view returns (bool isValid) {
    if (activeExpiry != strike.expiry) {
      return false;
    }

    uint[] memory strikeId = _toDynamic(strike.id);
    uint vol = getVols(strikeId)[0];
    int delta = _isCall() ? getDeltas(strikeId)[0] - SignedDecimalMath.UNIT : getDeltas(strikeId)[0];

    uint deltaGap = _abs(currentStrategy.targetDelta - delta);

    if (vol >= currentStrategy.minVol && vol <= currentStrategy.maxVol && deltaGap < currentStrategy.maxDeltaGap) {
      return true;
    } else {
      return false;
    }
  }

  function _isValidVolVariance(uint strikeId) internal view returns (bool isValid) {
    uint volGWAV = gwavOracle.volGWAV(strikeId, currentStrategy.gwavPeriod);
    uint volSpot = getVols(_toDynamic(strikeId))[0];

    uint volDiff = (volGWAV >= volSpot) ? volGWAV - volSpot : volSpot - volGWAV;

    return isValid = (volDiff < currentStrategy.maxVolVariance) ? true : false;
  }

  function _isValidExpiry(uint expiry) public view returns (bool isValid) {
    uint secondsToExpiry = _getSecondsToExpiry(expiry);
    isValid = (secondsToExpiry >= currentStrategy.minTimeToExpiry && secondsToExpiry <= currentStrategy.maxTimeToExpiry)
      ? true
      : false;
  }

  /////////////////////////////
  // Trade Parameter Helpers //
  /////////////////////////////

  function _getFullCollateral(uint strikePrice, uint amount) internal view returns (uint fullCollat) {
    // calculate required collat based on collatBuffer and collatPercent
    fullCollat = _isBaseCollat() ? amount : amount.multiplyDecimal(strikePrice);
  }

  function _getBufferCollateral(
    uint strikePrice,
    uint expiry,
    uint spotPrice,
    uint amount
  ) internal view returns (uint) {
    uint minCollat = getMinCollateral(optionType, strikePrice, expiry, spotPrice, amount);
    uint minCollatWithBuffer = minCollat.multiplyDecimal(currentStrategy.collatBuffer);

    uint fullCollat = _getFullCollateral(strikePrice, amount);

    return _min(minCollatWithBuffer, fullCollat);
  }

  /**
   * @dev get minimum premium that the vault should receive.
   * param listingId lyra option listing id
   * param size size of trade in Lyra standard sizes
   */
  function _getPremiumLimit(Strike memory strike, bool isMin) internal view returns (uint limitPremium) {
    ExchangeRateParams memory exchangeParams = getExchangeParams();
    uint limitVol = isMin ? currentStrategy.minVol : currentStrategy.maxVol;
    (uint minCallPremium, uint minPutPremium) = getPurePremium(
      _getSecondsToExpiry(strike.expiry),
      limitVol,
      exchangeParams.spotPrice,
      strike.strikePrice
    );

    limitPremium = _isCall()
      ? minCallPremium.multiplyDecimal(currentStrategy.size)
      : minPutPremium.multiplyDecimal(currentStrategy.size);
  }

  //////////////////////////////
  // Active Strike Management //
  //////////////////////////////

  function _addActiveStrike(Strike memory strike, uint tradedPositionId) internal {
    if (!_isActiveStrike(strike.id)) {
      strikeToPositionId[strike.id] = tradedPositionId;
      activeStrikeIds.push(strike.id);
    }
  }

  function _clearAllActiveStrikes() internal {
    if (activeStrikeIds.length != 0) {
      for (uint i = 0; i < activeStrikeIds.length; i++) {
        OptionPosition memory position = getPositions(_toDynamic(strikeToPositionId[i]))[0];
        require(position.state != PositionState.ACTIVE, "cannot clear active position");
        delete strikeToPositionId[i];
        delete lastTradeTimestamp[i];
      }
      delete activeStrikeIds;
    }
  }

  function _isActiveStrike(uint strikeId) internal view returns (bool isActive) {
    isActive = strikeToPositionId[strikeId] != 0 ? true : false;
  }

  //////////
  // Misc //
  //////////

  function _isBaseCollat() internal view returns (bool isBase) {
    isBase = (optionType == OptionType.SHORT_CALL_BASE) ? true : false;
  }

  function _isCall() internal view returns (bool isCall) {
    isCall = (optionType == OptionType.SHORT_PUT_QUOTE) ? false : true;
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

  modifier onlyVault() virtual {
    require(msg.sender == address(vault), "only Vault");
    _;
  }
}
