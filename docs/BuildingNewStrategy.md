# Building a new strategy <a name="strategy"></a>

Let's go through an example of building a new strategy called `DeltaShortStrategy.sol`:
* the strategy will sell covered calls for a given `boardId` but multiple `strikeIds`
* any option that falls within max/min vol, delta and expiry bounds can be sold
* `collatPercent` can be set to <100% to leverage up
* anyone can trigger a trade but with a fixed `size` and `minTradeInterval` between trades to reduce slippage
* anyone can trigger a partial close if the collateral falls below the `collatBuffer`
* pauses any trading if market is too volatile using the `GWAVOracle.sol` 

Outline: 
1. [Setup](#setup)
3. [Strategy parameters](#params)
4. [Screening strikeId](#screen)
5. [Selling calls](#selling)
6. [Reducing positions](#reducing)
7. [Settling positions and returning funds](#settling)

### Setup <a name="setup"></a>

The first step is to inherit and initialize `StrategyBase.sol` which contains common strategy logic and inherits the `LyraAdapter.sol` from `@lyrafinance/protocol`. 

```solidity
import {StrategyBase} from "./StrategyBase.sol";
import {GWAVOracle} from "@lyrafinance/protocol/contracts/periphery/GWAVOracle.sol";
import {DecimalMath} from "@lyrafinance/protocol/contracts/synthetix/DecimalMath.sol";
import {SignedDecimalMath} from "@lyrafinance/protocol/contracts/synthetix/SignedDecimalMath.sol";

contract DeltaShortStrategy is StrategyBase, IStrategy {
  using DecimalMath for uint;
  using SignedDecimalMath for int;

constructor(
  LyraVault _vault,
  OptionType _optionType,
  GWAVOracle _gwavOracle
) StrategyBase(_vault, _optionType, _gwavOracle) {}
```

### Strategy Parameters <a name="params"></a>

Next we define a struct that governs all trade selection: 
```solidity
struct DeltaShortStrategyDetail {
  uint minTimeToExpiry; // minimum board expiry
  uint maxTimeToExpiry; // maximum board expiry
  int targetDelta; // ideal option delta to trade
  uint maxDeltaGap; // max diff between targetDelta and option delta
  uint minVol; // min option volatility required 
  uint maxVol; // max option volatility required
  uint size; // amount of options to sell per LyraVault.trade()
  uint minTradeInterval; // min seconds between LyraVault.trade() calls
  uint maxVolVariance; // max deviation from GWAV vol and option volatility
  uint gwavPeriod; // gwav period used when calculating GWAV vol
  uint collatBuffer; // multiple of vaultAdapter.minCollateral(): 1.1 -> 110% * minCollat
  uint collatPercent; // partial collateral: 0.9 -> 90% * fullCollat
}
```

We create `setStrategyDetail()` to allow the `manager` to update strategy parameters in between rounds.

```solidity
function setStrategyDetail(DeltaShortStrategyDetail memory _deltaStrategy) external onlyOwner {
  (, , , , , , , bool roundInProgress) = vault.vaultState();
  require(!roundInProgress, "cannot change strategy if round is active");
  strategyDetail = _deltaStrategy;
}

`setBoard()` is also created to ensure `LyraVault.sol` always trades a valid expiry. This is called by `LyraVault.startNextRound()`:

function setBoard(uint boardId) external onlyVault {
  Board memory board = getBoard(boardId);
  require(_isValidExpiry(board.expiry), "invalid board");
  activeExpiry = board.expiry;
}
```

### Screening strikeId <a name="screen"></a>

The vault sells strikes whenever anyone "pokes" the vault by calling `LyraVault.trade(strikeId)`. To ensure only valid trades are made we must `require` several conditions:

Ensure vault sufficiently waits before executing another trade to allow arbing of vaults (if any) and minimize slippage:
```solidity
require(
  lastTradeTimestamp[strikeId] + strategyDetail.minTradeInterval <= block.timestamp,
  "min time interval not passed"
);
```

At times of high volatility, we'd like the vault to pause trading as the Lyra market may not have properly arb'd vols or could be undergoing an attack. To define "high volatility", we compare the GWAV vol with `GWAVOracle.volGWAV()` with the spot vols (queried using `LyraAdapter.getVols()`)
```solidity
require(_isValidVolVariance(strikeId), "vol variance exceeded");

function _isValidVolVariance(uint strikeId) internal view returns (bool isValid) {
  uint volGWAV = gwavOracle.volGWAV(strikeId, strategyDetail.gwavPeriod);
  uint volSpot = getVols(_toDynamic(strikeId))[0];

  uint volDiff = (volGWAV >= volSpot) ? volGWAV - volSpot : volSpot - volGWAV;
  return isValid = volDiff < strategyDetail.maxVolVariance;
}
```

Make sure both the strike falls within the correct delta and vol bounds. Note, we use `getStrikes()`, `getVols()` and `getDeltas()` functions from `LyraAdapter.sol` to easily get all market data. 
 ```solidity
Strike memory strike = getStrikes(_toDynamic(strikeId))[0];
require(isValidStrike(strike), "invalid strike");

function isValidStrike(Strike memory strike) public view returns (bool isValid) {
  if (activeExpiry != strike.expiry) {
    return false;
  }

  uint[] memory strikeId = _toDynamic(strike.id);
  uint vol = getVols(strikeId)[0];
  int callDelta = getDeltas(strikeId)[0];
  int delta = _isCall() ? callDelta : callDelta - SignedDecimalMath.UNIT;
  uint deltaGap = _abs(strategyDetail.targetDelta - delta);
  return vol >= strategyDetail.minVol && vol <= strategyDetail.maxVol && deltaGap < strategyDetail.maxDeltaGap;
}
```

Now that we've ensured that `strikeId` is valid, we create `getRequiredCollateral` to determine the collateral needed to reach the desired leverage specified in the `DeltaShortStrategyDetail` struct:
```solidity
function getRequiredCollateral(Strike memory strike)
  public view
  returns (uint collateralToAdd, uint setCollateralTo)
{
  uint sellAmount = strategyDetail.size;
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
    _getFullCollateral(strike.strikePrice, sellAmount).multiplyDecimal(strategyDetail.collatPercent);

  // if excess collateral, keep in position to encourage more option selling
  setCollateralTo = _max(_max(minBufferCollateral, targetCollat), existingCollateral);

  // existingCollateral is never > setCollateralTo
  collateralToAdd = setCollateralTo - existingCollateral;
}
```

Since trades are executed many times, we use `_isActiveStrike()` to keep track of existing positions and take note of the existing collateral/amounts.

Lastly, we create a helper function `_getBufferCollateral()` to calculate a collateral that is above the buffer requirement and up to the desired leverage amount:
```solidity
function _getBufferCollateral(
  uint strikePrice,
  uint expiry,
  uint spotPrice,
  uint amount
) internal view returns (uint) {
  uint minCollat = getMinCollateral(optionType, strikePrice, expiry, spotPrice, amount);
  uint minCollatWithBuffer = minCollat.multiplyDecimal(strategyDetail.collatBuffer);

  uint fullCollat = _getFullCollateral(strikePrice, amount);
  return _min(minCollatWithBuffer, fullCollat);
} 
```

Notice, `getMinCollateral()` from `LyraAdapter.sol` is used to auto compute the minimum collateral for a specific `optionType`, `strikePrice`, `expiry`, `spotPrice`, and `amount`.

### Selling Calls <a name="selling"></a>

In the previous section we created all the logic to screen a given `strikeId` and calculate the addition collateral required to execute the trade. 

We now need to actually open the position using `LyraAdapter.openPosition()`: 
```solidity
function _sellStrike(
  Strike memory strike,
  uint setCollateralTo,
  address lyraRewardRecipient
) internal returns (uint, uint) {
  // get minimum expected premium based on minIv
  uint minExpectedPremium = _getPremiumLimit(strike, strategyDetail.minVol, strategyDetail.size);
  // perform trade
  TradeResult memory result = openPosition(
    TradeInputParameters({
      strikeId: strike.id,
      positionId: strikeToPositionId[strike.id], // new positions must set this to 0
      iterations: 3, // number of sub orders to break trade into to reduce slippage but at higher gas expense
      optionType: optionType,
      amount: strategyDetail.size,
      setCollateralTo: setCollateralTo,
      minTotalCost: minExpectedPremium,
      maxTotalCost: type(uint).max,
      rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
    })
  );
  lastTradeTimestamp[strike.id] = block.timestamp;

  // update active strikes
  _addActiveStrike(strike.id, result.positionId);

  require(result.totalCost >= minExpectedPremium, "premium received is below min expected premium");

  return (result.positionId, result.totalCost);
}
```

*Note: to ensure the vault always sells options at a high enough volatility, we calculate the minimum premium amount we expect using `StrategyBase._getPremiumLimit()` and input this value into `minTotalCost` in the `TradeInputParameters`*

All of the screening logic + call selling can now be packaged up into the `doTrade()` function.
### Reducing Positions <a name="reducing"></a>
With leverage thrown into the mix, we'd like to add the ability for the vault to reduce risky positions. Since the vault aims to use 100% of it's funds to sell calls, reducing the `position.amount` is more reliable as opposed to adding collateral as the vault may not have funds available. 

For this, we first create `getAllowedCloseAmount()` to ensure we only close the amount necessary to stay above our `collatBuffer` param:
```solidity
function getAllowedCloseAmount(
  OptionPosition memory position,
  uint strikePrice,
  uint strikeExpiry
) public view returns (uint closeAmount) {
  ExchangeRateParams memory exchangeParams = getExchangeParams(); // LyraAdapter function to get Synthetix market info
  uint minCollatPerAmount = _getBufferCollateral(strikePrice, strikeExpiry, exchangeParams.spotPrice, 1e18);

  closeAmount = position.collateral < minCollatPerAmount.multiplyDecimal(position.amount)
    ? position.amount - position.collateral.divideDecimal(minCollatPerAmount)
    : 0;
}
```

Can now compose `tradeParams` required when partially closing the position:
```solidity
uint maxExpectedPremium = _getPremiumLimit(strike, strategyDetail.maxVol, strategyDetail.size);
TradeInputParameters memory tradeParams = TradeInputParameters({
  strikeId: position.strikeId,
  positionId: position.positionId,
  iterations: 3,
  optionType: optionType,
  amount: closeAmount,
  setCollateralTo: position.collateral,
  minTotalCost: type(uint).min,
  maxTotalCost: maxExpectedPremium,
  rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
});
```

Lastly, in the Lyra Avalon release positions can be closed out no matter the delta or time to expiry, albeit at a higher fee. We must now determine whether we require `forceClose()` or can simply `closePosition()`:
```solidity
if (!_isOutsideDeltaCutoff(strike.id) && !_isWithinTradingCutoff(strike.id)) {
  result = closePosition(tradeParams);
} else {
  // will pay less competitive price to close position
  result = forceClosePosition(tradeParams);
}
```

`StrategyBase.sol` provides `_isOutsideDeltaCutoff()` and `_isWithinTradingCutoff()` to help determine whether force closing is necessary:
```solidity
function _isOutsideDeltaCutoff(uint strikeId) internal view returns (bool) {
  MarketParams memory marketParams = getMarketParams(); // LyraAdapter function to get Lyra market params
  int callDelta = getDeltas(_toDynamic(strikeId))[0];
  return callDelta > (int(DecimalMath.UNIT) - marketParams.deltaCutOff) || callDelta < marketParams.deltaCutOff;
}

function _isWithinTradingCutoff(uint strikeId) internal view returns (bool) {
  MarketParams memory marketParams = getMarketParams(); // LyraAdapter function to get Lyra market params
  Strike memory strike = getStrikes(_toDynamic(strikeId))[0];
  return strike.expiry - block.timestamp <= marketParams.tradingCutoff;
}
```

The above logic can now be packaged up into the `reducePosition()` function which can be "poked" by anyone via `LyraVault.reducePosition()`.

### Settling Positions and Returning Funds <a name="settling"></a>

Upon expiry, Lyra bots will auto-settle all options and return funds to the position owners, which in this case is the strategy contract. When the round ends, `LyraVault.startNextRound()` will call `returnFundsAndClearStrikes()`. As this is common pattern that most round-based strategies are expected to follow, we can use `_returnFundsToVault()` and `_clearAllActiveStrikes()` in `StrategyBase.sol` to return all remaining collateral to the vault and clear out the active strike cache.

As some vaults may be base collateralized, `_returnFundsToVault()` also supports auto exchanging of quote premiums into base collat:
```solidity
function _returnFundsToVault() internal virtual {
  ExchangeRateParams memory exchangeParams = getExchangeParams(); // LyraAdapter function to get Synthetix market params
  uint quoteBal = quoteAsset.balanceOf(address(this));

  if (_isBaseCollat()) {
    // exchange quote asset to base asset, and send base asset back to vault
    uint baseBal = baseAsset.balanceOf(address(this));
    uint minQuoteExpected = quoteBal.divideDecimal(exchangeParams.spotPrice).multiplyDecimal(
      DecimalMath.UNIT - exchangeParams.baseQuoteFeeRate
    );
    uint baseReceived = exchangeFromExactQuote(quoteBal, minQuoteExpected);
    require(baseAsset.transfer(address(vault), baseBal + baseReceived), "failed to return funds from strategy");
  } else {
    // send quote balance directly
    require(quoteAsset.transfer(address(vault), quoteBal), "failed to return funds from strategy");
  }
}
```

`LyraAdapter.exchangeFromExactQuote()` is used to exchange the earned premiums back into base through the Synthetix spot market.

When getting position status via `_clearAllActiveStrikes()` we can rely on `LyraAdapter.getPositions()`: 
```solidity
function _clearAllActiveStrikes() internal {
  if (activeStrikeIds.length != 0) {
    for (uint i = 0; i < activeStrikeIds.length; i++) {
      uint strikeId = activeStrikeIds[i];
      OptionPosition memory position = getPositions(_toDynamic(strikeToPositionId[strikeId]))[0];
      // revert if position state is not settled
      require(position.state != PositionState.ACTIVE, "cannot clear active position");
      delete strikeToPositionId[strikeId];
      delete lastTradeTimestamp[i];
    }
    delete activeStrikeIds;
  }
}
```

The final function takes the form:
```solidity
function returnFundsAndClearStrikes() external onlyVault {
  // exchange asset back to collateral asset and send it back to the vault
  _returnFundsToVault();

  // keep internal storage data on old strikes and positions ids
  _clearAllActiveStrikes();
}
```