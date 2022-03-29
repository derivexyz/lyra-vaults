//SPDX-License-Identifier:MIT
pragma solidity ^0.8.9;

// https://docs.synthetix.io/contracts/source/interfaces/iexchangerates
interface IStrategy {
  function setBoard(uint boardId) external;

  function doTrade(uint strikeId, address rewardRecipient)
    external
    returns (
      uint positionId,
      uint premiumReceived,
      uint collateralAdded
    );

  function reducePosition(uint positionId, address rewardRecipient) external;

  function returnFundsAndClearStrikes() external;
}
