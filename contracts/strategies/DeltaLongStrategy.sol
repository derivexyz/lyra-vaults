//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
pragma experimental ABIEncoderV2;

// Hardhat
import "hardhat/console.sol";

// standard strategy interface
import "../interfaces/IStrategy.sol";

// Lyra
import {VaultAdapter} from "@lyrafinance/core/contracts/periphery/VaultAdapter.sol";
import {GWAVOracle} from "@lyrafinance/core/contracts/periphery/GWAVOracle.sol";

// Libraries
import {Vault} from "../libraries/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LyraVault} from "../core/LyraVault.sol";
import {DecimalMath} from "@lyrafinance/core/contracts/synthetix/DecimalMath.sol";
import {SignedDecimalMath} from "@lyrafinance/core/contracts/synthetix/SignedDecimalMath.sol";

// StrategyBase to inherit
import {StrategyBase} from "./StrategyBase.sol";

contract DeltaLongStrategy is StrategyBase, IStrategy {
  using DecimalMath for uint;
  using SignedDecimalMath for int;

  // example strategy detail
  struct DeltaExtendedStrategy {
    uint minTradeInterval;
  }

  DeltaExtendedStrategy public extendedStrategy;

  ///////////
  // ADMIN //
  ///////////

  constructor(
    LyraVault _vault,
    OptionType _optionType,
    GWAVOracle _gwavOracle
  ) StrategyBase(_vault, _optionType, _gwavOracle) {}

  /**
   * @dev update the extended strategy detail for the new round.
   */
  function setExtendedStrategy(DeltaExtendedStrategy memory _deltaStrategy) external onlyOwner {
    (, , , , , , , bool roundInProgress) = vault.vaultState();
    require(!roundInProgress, "cannot change strategy if round is active");
    extendedStrategy = _deltaStrategy;
  }

  /**
   * @dev set the board id that will be traded for the next round
   * @param boardId lyra board Id.
   */
  function setBoard(uint boardId) external onlyVault {
    _setBoard(boardId);
  }

  /**
   * @dev convert premium in quote asset into collateral asset and send it back to the vault.
   */
  function returnFundsAndClearStrikes() external onlyVault {
    // exchange asset back to collateral asset and send it back to the vault
    _returnFundsToVaut();

    // keep internal storage data on old strikes and positions ids
    _clearAllActiveStrikes();
  }

  /**
   * @notice sell a fix aomunt of options and collect premium
   * @dev the vault should pass in a strike id, and the strategy would verify if the strike is valid on-chain.
   * @param strikeId lyra strikeId to trade
   * @param lyraRewardRecipient address to receive trading reward. This need to be whitelisted
   * @return positionId
   * @return premiumPayed
   * @return collateralToAdd this value will always be 0 for long strategy
   */
  function doTrade(uint strikeId, address lyraRewardRecipient)
    external
    onlyVault
    returns (
      uint positionId,
      uint premiumPayed,
      uint collateralToAdd
    )
  {
    // validate trade
    require(
      lastTradeTimestamp[strikeId] + extendedStrategy.minTradeInterval <= block.timestamp,
      "min time interval not passed"
    );
    require(_isValidVolVariance(strikeId), "vol variance exceeded");

    Strike memory strike = getStrikes(_toDynamic(strikeId))[0];
    require(isValidStrike(strike), "invalid strike");

    (positionId, premiumPayed) = _buyStrike(strike, lyraRewardRecipient);
  }

  /**
   * @dev this function will not be used for long strategy
   */
  function reducePosition(
    uint,
    uint,
    address
  ) external pure {
    revert("not supported");
  }

  /**
   * @dev perform the trade
   * @param strike strike detail
   * @param lyraRewardRecipient address to receive lyra trading reward
   * @return positionId
   * @return premiumReceived
   */
  function _buyStrike(Strike memory strike, address lyraRewardRecipient) internal returns (uint, uint) {
    // get max premium to pay
    uint maxPremium = _getPremiumLimit(strike, false);
    // perform trade to long
    TradeResult memory result = openPosition(
      TradeInputParameters({
        strikeId: strike.id,
        positionId: strikeToPositionId[strike.id],
        iterations: 4,
        optionType: optionType,
        amount: baseStrategy.size,
        setCollateralTo: 0,
        minTotalCost: 0,
        maxTotalCost: maxPremium,
        rewardRecipient: lyraRewardRecipient // set to zero address if don't want to wait for whitelist
      })
    );
    _setLastTradedAt(strike.id, block.timestamp);

    // update active strikes
    _addActiveStrike(strike.id, result.positionId);

    require(result.totalCost <= maxPremium, "premium too high");

    return (result.positionId, result.totalCost);
  }
}
