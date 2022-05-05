//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {OptionMarket} from "@lyrafinance/protocol/contracts/OptionMarket.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockOptionMarket {
  address public collateralToken;
  address public premiumToken;
  uint public premium;
  uint public collateral;
  uint public settlementPayout;

  function setMockPremium(address _token, uint _premium) external {
    premiumToken = _token;
    premium = _premium;
  }

  function setMockCollateral(address _token, uint _collateralAmount) external {
    collateralToken = _token;
    collateral = _collateralAmount;
  }

  function setMockSettlement(uint _collateral) external {
    settlementPayout = _collateral;
  }

  function openPosition(
    uint, /*_listingId*/
    OptionMarket.OptionType, /*tradeType*/
    uint /*amount*/
  ) external returns (uint totalCost) {
    IERC20(collateralToken).transferFrom(msg.sender, address(this), collateral);

    IERC20(premiumToken).transfer(msg.sender, premium);
    // todo: mint mocked certificate?
    return premium;
  }

  function settleOptions(
    uint, /*listingId*/
    OptionMarket.OptionType /*tradeType*/
  ) external {
    IERC20(collateralToken).transfer(msg.sender, settlementPayout);
  }
}
