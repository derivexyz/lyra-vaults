# Vault Accounting

Lyra vault template utilizes a round-based mechanism for accounting, which is very similar to RibbonV2's structure. As a result, we cloned ribbon v2's `BaseVault` as a template to do accounting. A very big difference between Lyra's Vault and Ribbon vault is that we abstract more logic to the strategy contract, which make the vault relatively easy, and we can also remove lots of strike selection and option minting process from the lifecycle.

## Deposit

At any time, anyone can use the `deposit` function to deposit the asset into the vault.

```javascript
function deposit(uint amount) external
```

This will add the asset into the `vaultState.pendingDeposit`, and ready to be utilized by the next round when the manger call `startNextRound`. If you deposit during an active round, your asset will not be used until the next round, and you also won't share any of the profit or loss from the current round. After the next round started, you can claim the shares by calling `redeem` or `maxRedeem` function.
```javascript
function redeem(uint numShares) external
function maxRedeem() external
```

## Withdraw 

To withdraw from the vault, a user need to first call `initiateWithdraw` to signal how many shares he wants to exit. These shares will be recorded under `vaultState.queuedWithdrawShares`. The share to asset ratio of each round won't be fixed until the next round started, so the user will need to wait until the next round is started to call `completeWithdraw` to get their asset out from the vault.

```javascript
function initiateWithdraw(uint numShares) external
function completeWithdraw() external
```

## Rollover round
What exactly is going to happen when the manager call `startNextRound`? Two main things here: first, the `_rollToNextRound` is going to fix the price to share ratio, and then calculate how much `pendingDeposit` will be translated into new shares, and how much asset (`lockedAmount`) can be used for the strategy to trade. New shares waiting for people to claim will be minted, and pending withdraws will be excluded from `lockedAmount`, meaning that these assets will be reserved for withdraw and not utilized in the starting round.