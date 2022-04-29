//SPDX-License-Identifier: ISC
pragma solidity ^0.8.9;

interface IEIP4626 {
  ///@notice The address of the underlying token used for the Vault for accounting, depositing, and withdrawing.
  function asset() external view returns (address assetTokenAddress);

  ///@notice Total amount of the underlying asset that is “managed” by Vault.
  function totalAssets() external view returns (uint totalManagedAssets);

  ///@notice The amount of shares that the Vault would exchange for the amount of assets provided,
  ///     in an ideal scenario where all the conditions are met.
  ///@dev MUST NOT be inclusive of any fees that are charged against assets in the Vault.
  function convertToShares(uint assets) external view returns (uint shares);

  ///@notice The amount of assets that the Vault would exchange for the amount of shares provided,
  ///        in an ideal scenario where all the conditions are met.
  ///@dev MUST NOT be inclusive of any fees that are charged against assets in the Vault.
  function convertToAssets(uint shares) external view returns (uint assets);

  ///@notice Maximum amount of the underlying asset that can be deposited into the Vault for the receiver, through a deposit call.
  function maxDeposit(address receiver) external view returns (uint maxAsset);

  ///@notice Allows an on-chain or off-chain user to simulate the effects of their deposit at the current block, given current on-chain conditions.
  function previewDeposit(uint assets) external view returns (uint shares);

  ///@notice Mints shares Vault shares to receiver by depositing exactly amount of underlying tokens.
  function deposit(uint asset, address receiver) external returns (uint shares);

  ///@notice Maximum amount of shares that can be minted from the Vault for the receiver, through a mint call.
  function maxMint(address reciever) external returns (uint maxShares);

  ///@notice Allows an on-chain or off-chain user to simulate the effects of their mint at the current block, given current on-chain conditions.
  function previewMint(uint shares) external returns (uint assets);
}
