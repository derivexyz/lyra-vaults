# Building a new strategy <a name="strategy"></a>

Let's go through an example of building a new strategy called `DeltaShortStrategy.sol`:
* the strategy will sell covered calls for a given `boardId`
* any option that falls within max/min vol, delta and expiry bounds can be sold
* `collatPercent` can be set to <100% to leverage up
* anyone can trigger a trade but with a fixed `size` and `minTradeInterval` between trades to reduce slippage
* anyone can trigger a partial close if the collateral falls below the `collatBuffer`
* pauses any trading if market is too volatile using the `GWAVOracle.sol` 

Outline: 
1. [Setup](#setup)
3. [Strategy parameters](#params)
4. [Approving strikeId](#approval)
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

We create `setStrategyDetail()` to allow the `manager` to swap out strategies in between rounds if needed as well as `setBoard()` which is called by `LyraVault.startNextRound()` to determine which board to trade:

```solidity
function setStrategyDetail(DeltaShortStrategyDetail memory _deltaStrategy) external onlyOwner {
  (, , , , , , , bool roundInProgress) = vault.vaultState();
  require(!roundInProgress, "cannot change strategy if round is active");
  strategyDetail = _deltaStrategy;
}

function setBoard(uint boardId) external onlyVault {
  Board memory board = getBoard(boardId);
  require(_isValidExpiry(board.expiry), "invalid board");
  activeExpiry = board.expiry;
}
```

### Selling Calls <a name="approval"></a>

The vault sells strikes whenever anyone "pokes" the vault by calling `LyraVault.trade(strikeId)`. To ensure only valid trades are made we must `require` several conditions:

Ensure vault sufficiently waits before executing another trade to allow arbing of vaults (if any) and minimize slippage:
```solidity
require(
  lastTradeTimestamp[strikeId] + strategyDetail.minTradeInterval <= block.timestamp,
  "min time interval not passed"
);
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
      iterations: 4, // number of sub orders to break trade into to reduce slippage
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



### Settling Positions and Returning Funds <a name="settling"></a>
  