const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { smock } = require("@defi-wonderland/smock");
const { formatEther } = require("ethers/lib/utils");

describe("Crypto Linker Depository", async () => {

    const calcBondPrice = (price1, price0, refBond, lev) => {
        return one18.add(
            lev.mul(
                price1.sub(price0).mul(one18).div(price0)
            ).div(one18)
        ).mul(refBond).div(one18)
    }

    const mulDiv = (val, mul, div) => {
        return ethers.BigNumber.from(val).mul(ethers.BigNumber.from(Math.round(mul * 1000000))).div(Math.round(div * 1000000))
    }
    const LARGE_APPROVAL = "100000000000000000000000000000000";
    // Initial mint for Frax, req and DAI (10,000,000)
    const initialMint = "10000000000000000000000000";
    const initialDeposit = "1000000000000000000000000";

    const maxSupply = "1000000000000000000000000000000000"
    const one18 = ethers.BigNumber.from(10).pow(18)
    // Increase timestamp by amount determined by `offset`

    let deployer, alice, bob, carol;
    let erc20Factory;
    let mockReqFactory;
    let mockOracle
    let authFactory;
    let depositoryFactory;
    let mockOracleFactory;

    let auth;
    let dai;
    let req;
    let depository;
    let treasury;
    let capacity = ethers.BigNumber.from(10000).mul(one18);
    let initialPrice = ethers.BigNumber.from(400).mul(one18);
    let initalLevervage = one18;
    let targetLeverage = one18.mul(5)
    let digitalPayout = one18.div(20) // 20%
    let buffer = 2e5;
    let floor = initialPrice.div(2)
    let strike = one18.div(20) // 5%
    let vesting = 60 * 60 * 6;
    let timeToConclusion = 60 * 60 * 24;
    let exerciseDuration = 60 * 60 * 24;
    let conclusion;
    let timeSlippage = 60;

    let depositInterval = 60 * 60 * 4;
    let tuneInterval = 60 * 60;

    let refReward = 10;
    let daoReward = 50;

    var bid = 0;

    let userTerms;
    let market;
    let metadata;

    /**
     * Everything in this block is only run once before all tests.
     * This is the home for setup methods
     */
    before(async () => {
        [deployer, alice, bob, carol] = await ethers.getSigners();

        authFactory = await ethers.getContractFactory("Authority");
        erc20Factory = await smock.mock("MockERC20");
        mockReqFactory = await smock.mock("MockREQ");
        mockOracleFactory = await smock.mock("MockOracle")
        depositoryFactory = await ethers.getContractFactory("CryptoLinkerDepository");
    });

    beforeEach(async () => {
        // that parameter has to be reset as we increase the time multiple times and ine the block
        // for the tests
        const block = await ethers.provider.getBlock("latest");
        conclusion = block.timestamp + timeToConclusion;

        dai = await erc20Factory.deploy("Dai", "DAI", 18);

        auth = await authFactory.deploy(
            deployer.address,
            deployer.address,
            deployer.address,
            deployer.address
        );
        req = await mockReqFactory.deploy(maxSupply);
        treasury = await smock.fake("ITreasuryAuth");

        depository = await depositoryFactory.deploy(
            // auth.address,
            req.address,
            treasury.address
        );

        // Setup for each component
        await dai.mint(bob.address, initialMint);

        // To get past req contract guards
        await auth.pushVault(treasury.address, true);

        await dai.mint(deployer.address, initialDeposit);
        await dai.approve(treasury.address, initialDeposit);
        //await treasury.deposit(initialDeposit, dai.address, "10000000000000");

        await req.setMinter(deployer.address, LARGE_APPROVAL)
        await req.setMinter(treasury.address, LARGE_APPROVAL)

        await req.mint(deployer.address, one18.mul(10000));
        await req.mint(depository.address, one18.mul(10000));

        await treasury.baseSupply.returns(await req.totalSupply());
        // await treasury.assetValue.whenCalledWith([dai.address, "10000000000000000000000"]).returns("10000000000000000000000")
        await treasury.governor.returns(deployer.address);
        await treasury.vault.returns(deployer.address);
        await treasury.guardian.returns(deployer.address);
        await treasury.policy.returns(deployer.address);




        await req.connect(alice).approve(depository.address, LARGE_APPROVAL);
        await dai.connect(bob).approve(depository.address, LARGE_APPROVAL);

        await depository.setRewards(refReward, daoReward);
        await depository.whitelist(carol.address);

        await dai.connect(alice).approve(depository.address, capacity);

        mockOracle = await mockOracleFactory.deploy()
        await mockOracle.setPrice(one18)

        // create the first bond
        await depository.create(
            dai.address,
            mockOracle.address,
            [
                capacity, initialPrice,
                buffer, floor,
                strike, digitalPayout,
                initalLevervage, targetLeverage
            ],
            [vesting, conclusion, exerciseDuration],
            [depositInterval, tuneInterval]
        );

    });

    it("should create market", async () => {
        expect(await depository.isLive(bid)).to.equal(true);
    });

    it("should conclude in correct amount of time", async () => {
        let terms = await depository.terms(bid);
        expect(terms.conclusion).to.equal(conclusion);
        metadata = await depository.metadata(bid);
        // timestamps are a bit inaccurate with tests
        var upperBound = timeToConclusion * 1.0033;
        var lowerBound = timeToConclusion * 0.9967;
        expect(Number(metadata.marketLength)).to.be.greaterThan(lowerBound);
        expect(Number(metadata.marketLength)).to.be.lessThan(upperBound);
    });

    it("should set max payout to correct % of capacity", async () => {
        market = await depository.markets(bid);
        var upperBound = mulDiv(capacity, 1.0033, 6);
        var lowerBound = mulDiv(capacity, 0.9967, 6);
        expect(market.maxPayout.gt(lowerBound)).to.be.equal(true);
        expect(market.maxPayout.lt(upperBound)).to.be.equal(true);
    });

    it("should return IDs of all markets", async () => {
        // create a second bond
        await depository.create(
            dai.address,
            mockOracle.address,
            [
                capacity, initialPrice,
                buffer, floor,
                strike, digitalPayout,
                initalLevervage, targetLeverage
            ],
            [vesting, conclusion, exerciseDuration],
            [depositInterval, tuneInterval]
        );
        let [first, second] = await depository.liveMarkets();
        expect(Number(first)).to.equal(0);
        expect(Number(second)).to.equal(1);
    });

    it("should update IDs of markets", async () => {
        // create a second bond
        await depository.create(
            dai.address,
            mockOracle.address,
            [
                capacity, initialPrice,
                buffer, floor,
                strike, digitalPayout,
                initalLevervage, targetLeverage
            ],
            [vesting, conclusion, exerciseDuration],
            [depositInterval, tuneInterval]
        );
        // close the first bond
        await depository.close(0);
        [first] = await depository.liveMarkets();
        expect(Number(first)).to.equal(1);
    });

    it("should include ID in live markets for quote token", async () => {
        [id] = await depository.liveMarketsFor(dai.address);
        expect(Number(id)).to.equal(bid);
    });

    it("should start with price at initial price", async () => {
        let lowerBound = initialPrice * 0.9999;
        expect(Number(await depository.marketPrice(bid))).to.be.greaterThan(lowerBound);
    });

    it("should give accurate payout for price", async () => {
        let price = await depository.marketPrice(bid);
        let amount = "10000000000000000000000"; // 10,000
        await treasury.assetValue.returns(amount)
        let expectedPayout = amount / price;
        let lowerBound = mulDiv(expectedPayout, 0.9999, 1);
        const payout = await depository.payoutFor(amount, 0)
        expect(payout.gt(lowerBound)).to.be.equal(true);
    });

    it("should increase leverage", async () => {
        let preTerms = await depository.terms(0);

        await network.provider.send("evm_increaseTime", [100]);
        await depository.connect(bob).deposit(bid, "0", initialPrice, timeSlippage, carol.address);

        let postTerms = await depository.terms(0);
        expect(Number(postTerms.currentLeverage)).to.be.greaterThan(Number(preTerms.currentLeverage));
    });


    it("should provide linked pricing", async () => {
        let amount = one18; // 10,000
        await treasury.assetValue.returns(amount)
        let mp0 = await depository.marketPrice(bid)
        let lev = await depository.currentLeverage(bid)
        // set price to 10% increas
        const price0 = one18.mul(11).div(10)
        await mockOracle.setPrice(price0)
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice.mul(2), timeSlippage, bob.address);

        // check reference price
        let mp1 = await depository.metadata(bid)
        expect(mp0).to.equal(mp1.lastReferenceBondPrice)
        userTerms = await depository.userTerms(bob.address, 0)
        metadata = await depository.metadata(bid)

        // increase time
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        await network.provider.send("evm_mine")

        let time = await mockOracle.latestRoundData()
        let mpPre = await depository.marketPrice(bid)
        let levPre = await depository.currentLeverage(bid)
        let incr = await depository.currentLeverageIncrement(bid)
        terms = await depository.terms(bid)

        // deposit
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice.mul(2), timeSlippage, bob.address);

        // fetch price
        let mp2 = await depository.marketPrice(bid)
        // let levPost = await depository.currentLeverage(bid)
        expect(mp2.gt(mp1.lastReferenceBondPrice.mul(11).div(10))).to.equal(true)

        // fetch attained price
        userTerms = await depository.userTerms(bob.address, 1)

        // check whether prices match 
        // let expectedPriceUser = calcBondPrice(price0, one18, mp1.lastReferenceBondPrice, levPre)
        let actualPriceUser = ethers.BigNumber.from(amount).mul(one18).div(userTerms.baseNotional)
        let lowerBound = mulDiv(mpPre, 0.9999, 1);
        let upperBound = mulDiv(mpPre, 1.0001, 1);

        expect(actualPriceUser.gt(lowerBound)).to.be.equal(true);
        expect(actualPriceUser.lt(upperBound)).to.be.equal(true);

        // expect(actualPriceUser).to.equal(expectedPriceUser)

        // set price to decrease 
        const price1 = one18.mul(95).div(100)
        await mockOracle.setPrice(price1)

        // increase time
        await network.provider.send("evm_increaseTime", [tuneInterval]);
        await network.provider.send("evm_mine")

        // calculate expected price
        lev = await depository.currentLeverage(bid)
        let mp3 = await depository.marketPrice(bid)
        let bmp = await depository.metadata(bid)
        const expPr = one18.add(lev.mul(price1.sub(price0).mul(one18).div(price0)).div(one18)).mul(bmp.lastReferenceBondPrice).div(one18)

        lowerBound = mulDiv(mp3, 0.9999, 1);
        upperBound = mulDiv(mp3, 1.0001, 1);

        // comparen to actual one
        expect(expPr.gt(lowerBound)).to.be.equal(true);
        expect(expPr.lt(upperBound)).to.be.equal(true);

        mpPre = await depository.marketPrice(bid)
        await depository
            .connect(bob)
            .deposit(bid, amount, initialPrice.mul(2), timeSlippage, bob.address);

        metadata = await depository.metadata(bid)
        const inds = await depository.indexesFor(bob.address)
        userTerms = await depository.userTerms(bob.address, inds[inds.length - 1])

        actualPriceUser = ethers.BigNumber.from(amount).mul(one18).div(userTerms.baseNotional)
        lowerBound = mulDiv(mpPre, 0.9999, 1);
        upperBound = mulDiv(mpPre, 1.0001, 1);

        expect(actualPriceUser.gt(lowerBound)).to.be.equal(true);
        expect(actualPriceUser.lt(upperBound)).to.be.equal(true);

    });


    it("should allow notional claim with no option exercise", async () => {
        let amount = one18.mul(10000); // 10,000
        await treasury.assetValue.returns(amount)
        const price0 = one18
        await mockOracle.setPrice(price0)

        await depository.connect(bob).deposit(bid, amount, initialPrice, timeSlippage, carol.address);

        await network.provider.send("evm_increaseTime", [vesting]);
        await network.provider.send("evm_mine")
        userTerms = await depository.userTerms(carol.address, 0)
        await depository.claimAndExercise(carol.address, [0]);
        let balance = await req.balanceOf(carol.address)
        expect(balance).to.be.equal(userTerms.baseNotional);
    });


    it("should allow notional claim with option exercise", async () => {
        let amount = one18.mul(10000); // 10,000
        await treasury.assetValue.returns(amount)
        const price0 = one18
        await mockOracle.setPrice(price0)

        await depository.connect(bob).deposit(bid, amount, initialPrice, timeSlippage, carol.address);

        await network.provider.send("evm_increaseTime", [vesting + 5]);
        await network.provider.send("evm_mine")

        userTerms = await depository.userTerms(carol.address, 0)
        const price1 = price0.mul(107).div(100)
        await mockOracle.setPrice(price1)
        await depository.claimAndExercise(carol.address, [0]);
        let balance = await req.balanceOf(carol.address)
        expect(balance).to.be.equal(userTerms.baseNotional.mul(105).div(100));
    });

    it("should allow notional claim with later option exercise", async () => {
        let amount = one18.mul(10000); // 10,000
        await treasury.assetValue.returns(amount)
        const price0 = one18
        await mockOracle.setPrice(price0)

        await depository.connect(bob).deposit(bid, amount, initialPrice, timeSlippage, carol.address);

        await network.provider.send("evm_increaseTime", [vesting + 5]);
        await network.provider.send("evm_mine")
        userTerms = await depository.userTerms(carol.address, 0)
        const price1 = price0.mul(102).div(100)
        await mockOracle.setPrice(price1)


        await depository.claimAndExercise(carol.address, [0]);
        let balance = await req.balanceOf(carol.address)

        expect(balance).to.be.equal(userTerms.baseNotional);

        await network.provider.send("evm_increaseTime", [exerciseDuration - 100]);
        await network.provider.send("evm_mine")
        const price2 = price0.mul(107).div(100)
        await mockOracle.setPrice(price2)

        await depository.claimAndExercise(carol.address, [0]);
        balance = await req.balanceOf(carol.address)

        expect(balance).to.be.equal(userTerms.baseNotional.mul(105).div(100));
    });

    it("should not option exercise after exercise duration", async () => {
        let amount = one18.mul(10000); // 10,000
        await treasury.assetValue.returns(amount)
        const price0 = one18
        await mockOracle.setPrice(price0)

        await depository.connect(bob).deposit(bid, amount, initialPrice, timeSlippage, carol.address);

        await network.provider.send("evm_increaseTime", [vesting + 5]);
        await network.provider.send("evm_mine")
        userTerms = await depository.userTerms(carol.address, 0)
        const price1 = price0.mul(102).div(100)
        await mockOracle.setPrice(price1)

        await depository.claimAndExercise(carol.address, [0]);
        let balance = await req.balanceOf(carol.address)

        expect(balance).to.be.equal(userTerms.baseNotional);

        await network.provider.send("evm_increaseTime", [exerciseDuration + 5]);
        await network.provider.send("evm_mine")
        const price2 = price0.mul(107).div(100)
        await mockOracle.setPrice(price2)

        await depository.claimAndExercise(carol.address, [0]);
        balance = await req.balanceOf(carol.address)

        expect(balance).to.be.equal(userTerms.baseNotional);
    });

    it("should not price below floor", async () => {
        let amount = one18.mul(10000); // 10,000
        await treasury.assetValue.returns(amount)
        const price0 = one18.mul(5).div(1000)
        await mockOracle.setPrice(price0)
        let price = await depository.marketPrice(bid)
        expect(price).to.equal(floor)
        await depository.connect(bob).deposit(bid, amount, initialPrice, timeSlippage, carol.address);

        userTerms = await depository.userTerms(carol.address, 0)

        let actualPriceUser = ethers.BigNumber.from(amount).mul(one18).div(userTerms.baseNotional)
        expect(actualPriceUser).to.equal(floor)
    });


    // it("should not start adjustment if ahead of schedule", async () => {
    //     let amount = "650000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice.mul(2), timeSlippage, carol.address);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice.mul(2), timeSlippage, carol.address);

    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice.mul(2), timeSlippage, carol.address);
    //     // let [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
    //     // expect(Boolean(active)).to.equal(false);
    // });

    // it("should start adjustment if behind schedule", async () => {
    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, timeSlippage, carol.address);
    //     // let [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
    //     expect(Boolean(false)).to.equal(true);
    // });

    // it("adjustment should lower control variable by change in tune interval if behind", async () => {
    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     let [, controlVariable, , ,] = await depository.terms(bid);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     let [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     let [, newControlVariable, , ,] = await depository.terms(bid);
    //     expect(newControlVariable).to.equal(controlVariable.sub(change));
    // });

    // it("adjustment should lower control variable by half of change in half of a tune interval", async () => {
    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     let [, controlVariable, , ,] = await depository.terms(bid);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     let [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);
    //     await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     let [, newControlVariable, , ,] = await depository.terms(bid);
    //     let lowerBound = (controlVariable - change / 2) * 0.999;
    //     expect(Number(newControlVariable)).to.lessThanOrEqual(
    //         Number(controlVariable.sub(change.div(2)))
    //     );
    //     expect(Number(newControlVariable)).to.greaterThan(Number(lowerBound));
    // });

    // it("adjustment should continue lowering over multiple deposits in same tune interval", async () => {
    //     await network.provider.send("evm_increaseTime", [tuneInterval]);
    //     [, controlVariable, , ,] = await depository.terms(bid);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     let [change, lastAdjustment, timeToAdjusted, active] = await depository.adjustments(bid);

    //     await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);

    //     await network.provider.send("evm_increaseTime", [tuneInterval / 2]);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     let [, newControlVariable, , ,] = await depository.terms(bid);
    //     expect(newControlVariable).to.equal(controlVariable.sub(change));
    // });

    // it("should allow a deposit", async () => {
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);

    //     expect(Array(await depository.indexesFor(bob.address)).length).to.equal(1);
    // });

    // it("should not allow a deposit greater than max payout", async () => {
    //     let amount = "6700000000000000000000000"; // 6.7m (400 * 10000 / 6 + 0.5%)
    //     await treasury.assetValue.returns(amount)
    //     await expect(
    //         depository.connect(bob).deposit(bid, amount, initialPrice, bob.address, carol.address)
    //     ).to.be.revertedWith("Depository: max size exceeded");
    // });

    // it("should not redeem before vested", async () => {
    //     let balance = await req.balanceOf(bob.address);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     await depository.connect(bob).redeemAll(bob.address);
    //     expect(await req.balanceOf(bob.address)).to.equal(balance);
    // });

    // it("should redeem after vested", async () => {
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     let [expectedPayout, expiry, index] = await depository
    //         .connect(bob)
    //         .callStatic.deposit(bid, amount, initialPrice, bob.address, carol.address);

    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);

    //     await network.provider.send("evm_increaseTime", [1000]);
    //     await depository.redeemAll(bob.address);

    //     const bobBalance = await req.balanceOf(bob.address);
    //     expect(bobBalance.gte(expectedPayout)).to.equal(true);
    //     expect(bobBalance.lt(mulDiv(expectedPayout, 1.0001, 1))).to.equal(true);
    // });

    // it("should give correct rewards to referrer and dao", async () => {
    //     let daoBalance = await req.balanceOf(deployer.address);
    //     let refBalance = await req.balanceOf(carol.address);
    //     let amount = "10000000000000000000000"; // 10,000
    //     await treasury.assetValue.returns(amount)
    //     let [payout, expiry, index] = await depository
    //         .connect(bob)
    //         .callStatic.deposit(bid, amount, initialPrice, bob.address, carol.address);
    //     await depository
    //         .connect(bob)
    //         .deposit(bid, amount, initialPrice, bob.address, carol.address);

    //     // Mint ohm for depository to payout reward
    //     await req.mint(depository.address, "1000000000000000000000");

    //     let daoExpected = Number(daoBalance) + Number((Number(payout) * daoReward) / 1e4);
    //     await depository.getReward();

    //     const frontendReward = Number(await req.balanceOf(deployer.address));
    //     expect(frontendReward).to.be.greaterThan(Number(daoExpected));
    //     expect(frontendReward).to.be.lessThan(Number(daoExpected) * 1.0001);

    //     let refExpected = Number(refBalance) + Number((Number(payout) * refReward) / 1e4);
    //     await depository.connect(carol).getReward();

    //     const carolReward = Number(await req.balanceOf(carol.address));
    //     expect(carolReward).to.be.greaterThan(Number(refExpected));
    //     expect(carolReward).to.be.lessThan(Number(refExpected) * 1.0001);
    // });

    // it("should decay a max payout in target deposit interval", async () => {
    //     market = await depository.markets(bid);
    //     let price = await depository.marketPrice(bid);
    //     let amount = market.maxPayout.mul(price).div(one18);
    //     await depository.connect(bob).deposit(
    //         bid,
    //         amount, // amount for max payout
    //         initialPrice,
    //         bob.address,
    //         carol.address
    //     );
    //     await network.provider.send("evm_increaseTime", [depositInterval]);
    //     let newPrice = await depository.marketPrice(bid);
    //     expect(newPrice.lt(initialPrice)).to.equal(true);
    // });

    it("should close a market", async () => {
        market = await depository.markets(bid);
        expect(Number(market.capacity)).to.be.greaterThan(0);
        await depository.close(bid);
        market = await depository.markets(bid);
        expect(Number(market.capacity)).to.equal(0);
    });

    // // FIXME Works in isolation but not when run in suite
    // it.skip("should not allow deposit past conclusion", async () => {
    //     await network.provider.send("evm_increaseTime", [timeToConclusion * 10000]);
    //     await expect(
    //         depository.connect(bob).deposit(bid, 0, initialPrice, bob.address, carol.address)
    //     ).to.be.revertedWith("Depository: market concluded");
    // });
});
