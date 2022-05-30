# Integration testing

Full integration tests between the vault and the Lyra market can be performed using `@lyrafinance/protocol` without the need for mock contracts.

*Note: some details are ommitted for the sake of brevity. Refer to [test/integration-tests/delta-strategy-covered-call.ts](test/integration-tests/delta-strategy-covered-call.ts) for full test.*

Outline: 
1. [Lyra market deploy & overrides](#lyra)
3. [Vault deploy](#vault)
4. [Override Lyra params to force a failed trade request](#screen)
5. [Override the spot price to force a failed reduce position request](#reduce)

### Lyra market deploy & overrides <a name="lyra"></a>
First, follow installation instructions in [@lyrafinance/protocol](https://www.npmjs.com/package/@lyrafinance/protocol). 

Import all required modules and setup scaffold:
```typescript
import { lyraConstants, lyraEvm, TestSystem } from '@lyrafinance/protocol';
import { expect } from 'chai';
import { DeltaShortStrategy, LyraVault, MockERC20 } from '../../../typechain-types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

describe('Covered Call Delta Strategy integration test', async () => {
  // mocked tokens
  let lyraTestSystem: TestSystemContractsType;
  let vault: LyraVault;
  let strategy: DeltaShortStrategy;

  // roles
  let deployer: SignerWithAddress;
  let manager: SignerWithAddress;

  before('assign roles', async () => {
    const addresses = await ethers.getSigners();
    deployer = addresses[0];
    manager = addresses[1];
    randomUser = addresses[8];
    randomUser2 = addresses[9];
  });
```

Create override parameters to create a custom Lyra market:
```typescript
const spotPrice = toBN('3000');
const boardParameter = {
    expiresIn: lyraConstants.DAY_SEC * 7,
    baseIV: '0.9',
    strikePrices: ['2500', '3000', '3200', '3400', '3550'],
    skews: ['1.1', '1', '1.1', '1.3', '1.3'],
};
const initialPoolDeposit = toBN('1500000'); // 1.5m
const pricingParams = {
    ...TestSystem.defaultParams.pricingParams,
    standardSize: toBN('50'),
    spotPriceFeeCoefficient: toBN('0.001'),
    vegaFeeCoefficient: toBN('60'),
};
```

Now, deploy the full lyra market with overrides and a custom board:
```typescript
before('deploy lyra market', async () => {
  /// deploys all necessary Lyra market contracts and stores in lyraTestSystem
  lyraTestSystem = await TestSystem.deploy(deployer, true, false, { pricingParams });

  // seeds liquidity pool with funds, creates a board and sets an initial base price
  await TestSystem.seed(deployer, lyraTestSystem, {
    initialBoard: boardParameter,
    initialBasePrice: spotPrice,
    initialPoolDeposit: initialPoolDeposit,
  });

  // set boardId
  const boardId = (await lyraTestSystem.optionMarket.getLiveBoards())[0];

  // this function must be periodically called to ensure board is not stale and can accept trades
  await lyraTestSystem.optionGreekCache.updateBoardCachedGreeks(boardId);

  // fast forward so vol GWAV can work
  await lyraEvm.fastForward(600);
});
```

### Vault deploy <a name="vault"></a>

Deploy `LyraVault.sol` - refer to [docs/VaultAccounting.md](docs/VaultAccounting.md) for more
```typescript
before('deploy vault', async () => {
  const LyraVault = await ethers.getContractFactory('LyraVault');
  vault = (await LyraVault.connect(manager).deploy(
    susd.address,
    manager.address, // feeRecipient,
    lyraConstants.DAY_SEC * 7,
    'LyraVault Share',
    'Lyra VS',
    { 18,  ethers.utils.parseEther('5000'), asset: seth.address },
  )) as LyraVault;
});
```

Set the strategy and initialize `LyraAdapter.sol`:
```typescript
before('deploy strategy', async () => {
  strategy = (await (
    await ethers.getContractFactory('DeltaShortStrategy', {
      libraries: { BlackScholes: lyraTestSystem.blackScholes.address },
    })
  )
    .connect(manager)
    .deploy(
      vault.address,
      TestSystem.OptionType.SHORT_CALL_BASE,
      lyraTestSystem.GWAVOracle.address,
    )) as DeltaShortStrategy;
});

before('initialize strategy and adapter', async () => {
  // todo: need to use LyraRegistry.sol instead
  await strategy.connect(manager).initAdapter(
      lyraTestSystem.testCurve.address, // curve swap
      lyraTestSystem.optionToken.address,
      lyraTestSystem.optionMarket.address,
      lyraTestSystem.liquidityPool.address,
      lyraTestSystem.shortCollateral.address,
      lyraTestSystem.synthetixAdapter.address,
      lyraTestSystem.optionMarketPricer.address,
      lyraTestSystem.optionGreekCache.address,
      susd.address, // quote
      seth.address, // base
      lyraTestSystem.basicFeeCounter.address as string,
  );
});

before('link strategy to vault', async () => {
  await vault.connect(manager).setStrategy(strategy.address);
  await strategy.connect(manager).setStrategyDetail( { ... }); // fill-in your strategy params 
});
```
### Override Lyra params to force a failed trade request <a name="screen"></a>

```typescript
it('should revert when min premium < premium calculated with min vol', async () => {
  // significantly increasing lyra spot fees to 50% of spot to make premiums below threshold
  let pricingParams: PricingParametersStruct = {
    ...TestSystem.defaultParams.pricingParams,
    spotPriceFeeCoefficient: toBN('0.5'), // set spot fee to 50%
  };
  await lyraTestSystem.optionMarketPricer.setPricingParams(pricingParams);

  // 3550 is good strike with reasonable delta, but won't go through because premium will be too low.
  await expect(vault.connect(randomUser).trade(strikes[4])).to.be.revertedWith('TotalCostOutsideOfSpecifiedBounds');

  // resetting back to normal
  pricingParams = {
    ...pricingParams,
    spotPriceFeeCoefficient: toBN('0.001'),
  };
  await lyraTestSystem.optionMarketPricer.setPricingParams(pricingParams);
});
```

### Override the spot price to force a failed reduce position request <a name="reduce"></a>

```typescript
it('should revert when trying to reduce a safe position', async () => {
  // we remain safe even if eth goes to 3400 (13% jump)
  await TestSystem.marketActions.mockPrice(lyraTestSystem, toBN('3400'), 'sETH');

  fullCloseAmount = await strategy.getAllowedCloseAmount(position, strikePrice, expiry);
  expect(fullCloseAmount).to.be.eq(0);
  await expect(vault.connect(randomUser).reducePosition(positionId, toBN('0.1'))).to.be.revertedWith(
    'amount exceeds allowed close amount',
  );
});
```