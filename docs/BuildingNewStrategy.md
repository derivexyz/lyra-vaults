# Building a new strategy <a name="strategy"></a>

Let's go through an example of building a new strategy called `DeltaShortStrategy.sol`:
* the strategy will sell covered calls for a given `boardId`
* any option that falls within max/min vol, delta and expiry bounds can be sold
* `collatPercent` can be set to <100% to leverage up
* anyone can trigger a trade but with a fixed `size` and `minTradeInterval` between trades to reduce slippage
* anyone can trigger a partial close if the collateral falls below the `collatBuffer`
* pauses any trading if market is too volatile using the `GWAVOracle.sol` 

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

We create `setStrategyDetail()` to allow the `manager` to swap out strategies in between rounds if needed as well as `setBoard()` to determine which board to trade:

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
