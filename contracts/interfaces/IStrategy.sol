//SPDX-License-Identifier:MIT
pragma solidity ^0.8.9;

interface IStrategy {
  function setBoard(uint boardId) external;

  function doTrade(uint strikeId, address rewardRecipient)
    external
    returns (
      uint positionId,
      uint premiumReceived,
      uint collateralAdded
    );

  function reducePosition(
    uint positionId,
    uint closeAmount,
    address rewardRecipient
  ) external;

  function returnFundsAndClearStrikes() external;
}
