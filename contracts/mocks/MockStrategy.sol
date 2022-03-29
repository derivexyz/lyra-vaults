//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20Detailed} from "../interfaces/IERC20Detailed.sol";

contract MockStrategy is IStrategy {
  IERC20Detailed public immutable collateral;
  IERC20Detailed public immutable premium;

  uint public tradePremiumAmount;
  uint public tradeCollateralAmount;

  bool public isSettlted;

  uint public boardId;

  constructor(IERC20Detailed _premiumToken, IERC20Detailed _collateralToken) {
    collateral = _collateralToken;
    premium = _premiumToken;
  }

  function setBoard(uint _boardId) external {
    boardId = _boardId;
  }

  function setMockedTradeAmount(uint _premium, uint _collateral) public {
    tradePremiumAmount = _premium;
    tradeCollateralAmount = _collateral;
  }

  function doTrade(uint, address)
    external
    returns (
      uint positionId,
      uint premiumReceived,
      uint collateralAdded
    )
  {
    // get collateral from caller
    collateral.transferFrom(msg.sender, address(this), tradeCollateralAmount);

    // transfer premium to caller
    premium.transfer(msg.sender, premiumReceived);

    return (0, premiumReceived, tradeCollateralAmount);
  }

  function reducePosition(uint, address) external {}

  function setMockIsSettled(bool _isSettled) public {
    isSettlted = _isSettled;
  }

  function returnFundsAndClearStrikes() external {
    // return collateral and premium to msg.sender
    uint colBalance = collateral.balanceOf(address(this));
    collateral.transfer(msg.sender, colBalance);

    uint premiumBalance = premium.balanceOf(address(this));
    premium.transfer(msg.sender, premiumBalance);
  }
}
