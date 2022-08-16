/* eslint-disable */
// const { ethers } = require('hardhat');
const { expect } = require('chai');

const { promisify } = require('util');
const queue = promisify(setImmediate);
const GREQArtifact = require('../../artifacts/contracts/GovernanceRequiemToken.sol/GovernanceRequiemToken.json')
const { ethers } = require('hardhat');


async function countPendingTransactions() {
  return parseInt(
    await network.provider.send('eth_getBlockTransactionCountByNumber', ['pending'])
  );
}


contract('Governance Requiem Locks Upgradeable', function () {
  let deployer, alice, bob, carol;
  let userLocks, lock, newLock
  let currentTimestamp
  let end, lateEnd
  let block
  const name = 'My Token';
  const symbol = 'MTKN';
  const version = '1';
  const one_18 = new ethers.BigNumber.from('1000000000000000000');
  const supply = new ethers.BigNumber.from('10000000000000000000000000');
  const distAmount = supply.div(10)
  const maturity = 60 * 60 * 24

  before(async () => {
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity

    lateEnd = end + maturity
  })

  beforeEach(async function () {
    [deployer, alice, bob, carol] = await ethers.getSigners();
    const factoryLocked = await ethers.getContractFactory('ERC20BurnableMock')
    const factoryCurveProvder = await ethers.getContractFactory('MockCurveProvider')
    const GovernanceRequiem = await ethers.getContractFactory('GovernanceRequiemTokenMock')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')

    // deploy admin
    const admin = await ProxyAdmin.deploy()
    // deploy logic
    const governanceRequiem = await GovernanceRequiem.deploy()
    // deploy proxy
    const proxy = await TransparentUpgradeableProxy.deploy(governanceRequiem.address, admin.address, Buffer.from(""))


    this.lockedToken = await factoryLocked.deploy(name, symbol, deployer.address, supply);
    this.curveProvider = await factoryCurveProvder.deploy();

    // define contract using proxy address and GREQ ABI
    const greqContract = await ethers.getContractAt(GREQArtifact.abi, proxy.address)
    // initialize 
    await greqContract.initialize("Governance Requiem", "GREQ", this.lockedToken.address, this.curveProvider.address, ethers.BigNumber.from(10).pow(16))

    this.token = greqContract;

    // distribute tokens
    await this.lockedToken.connect(deployer).transfer(alice.address, distAmount)
    await this.lockedToken.connect(deployer).transfer(bob.address, distAmount)
    await this.lockedToken.connect(deployer).transfer(carol.address, distAmount)

    // approve governance
    await this.lockedToken.connect(alice).approve(this.token.address, ethers.constants.MaxUint256)
    await this.lockedToken.connect(bob).approve(this.token.address, ethers.constants.MaxUint256)
    await this.lockedToken.connect(carol).approve(this.token.address, ethers.constants.MaxUint256)

  });

  it('initial count and rate', async function () {
    // validate init count
    const count = await this.token.lockCount()
    expect(count.toString()).to.equal('0');


    const maxtime = await this.token.MAXTIME()

    // read supplies
    const govSupp = await this.token.totalSupply()
    const lSupp = await this.lockedToken.totalSupply()

    // calcualte value manually
    const a = await this.curveProvider.calculateGovernanceUtilityCurve(govSupp, lSupp)
    const arg = (a.add(one_18).mul(one_18)).div(a)
    const log_b = await this.curveProvider.ln(arg)
    const exp_val = await this.curveProvider.exp(log_b.mul(maturity).div(maxtime))
    const manual = a.mul(exp_val.sub(one_18)).div(one_18)

    // read out rate
    const rawRate = await this.curveProvider.rate(maxtime, currentTimestamp, end, lSupp, govSupp)

    // check for match
    expect(manual.toString()).to.equal(rawRate.toString())

    // check whether amount is less than linear version
    expect(rawRate.lte(one_18.mul(maturity).div(maxtime))).to.equal(true)

    // calculte rate via contract for amount
    const amount = '1000000000000000000000' //10k
    const rate = await this.token.getAmountMinted(amount, currentTimestamp, end)

    expect(rate.toString()).to.equal(manual.mul(amount).div(one_18).toString())
  });

  it('creation of lock', async function () {
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, alice.address)
    const count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');

    userLocks = await this.token.getLocks(alice.address)

    const userBalance = await this.token.balanceOf(alice.address)

    const lock = userLocks[0]
    expect(userBalance.toString()).to.equal(userLocks[0].minted.toString())
    expect(lock.amount.toString()).to.equal(amount);
    expect(Number(lock.end)).to.equal(end);
  });

  it('lock views', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, end, bob.address)

    await network.provider.send("evm_increaseTime", [100]);

    const amountFourth = '750000000000000000000' //5k
    await this.token.connect(carol).createLock(amountFourth, end, carol.address)

    const amountThird = '750000000000000000000' //5k
    await this.token.connect(bob).createLock(amountThird, end, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    let otherUserLocks = await this.token.getLocks(carol.address)

    // length validation
    expect(userLocks.length).to.equal(3)
    expect(otherUserLocks.length).to.equal(1)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)
    const secondAmount = await this.token.getTotalAmountLocked(carol.address)


    // amount validation
    expect(firstAmount.toString()).to.equal('2250000000000000000000')
    expect(secondAmount.toString()).to.equal(amountFourth)

    // indexes
    const firstIndexes = await this.token.getUserIndexes(bob.address)
    const secondIndexes = await this.token.getUserIndexes(carol.address)

    //lock should have target amount
    const expIndexes = ['0', '1', '3']
    firstIndexes.map((x, index) => expect(x.toString()).to.equal(expIndexes[index]))

    expect(secondIndexes[0].toString()).to.equal('2');
    expect(secondIndexes.length).to.equal(1);

    // voting power
    const firstMinted = await this.token.getUserMinted(bob.address)
    const secondMinted = await this.token.getUserMinted(carol.address)

    const balFirst = await this.token.balanceOf(bob.address)
    const balSecond = await this.token.balanceOf(carol.address)

    // validate via balances
    expect(firstMinted.toString()).to.equal(balFirst.toString())
    expect(secondMinted.toString()).to.equal(balSecond.toString())

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('4');
  });

  it('increase of locked amount', async function () {
    const amount = '1000000000000000000000' //10k
    const targetAmount = '2000000000000000000000' //10k
    let count = await this.token.lockCount()
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await this.token.connect(bob).increasePosition(amount, count, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)
    const lock = userLocks[0]

    //lock should have target amount
    expect(lock.amount.toString()).to.equal(targetAmount);

    // end should be unchanged
    expect(Number(lock.end)).to.equal(end);

    // count should be unchanged
    count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });

  it('increase of locked time full lock', async function () {
    const amount = '1000000000000000000000' //10k

    let count = await this.token.lockCount()
    await this.token.connect(bob).createLock(amount, end, bob.address)

    // fetch lock beore maturity increase
    userLocks = await this.token.getLocks(bob.address)
    let lock = userLocks[0]
    let minted = lock.minted

    // get current timestamp
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;

    let additionalMinted = await this.token.getAdditionalAmountMinted(amount, currentTimestamp, end, lateEnd)

    await this.token.connect(bob).increaseTimeToMaturity(amount, 0, lateEnd)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)
    lock = userLocks[0]

    //lock should have target amount
    expect(lock.amount.toString()).to.equal(amount);

    // end should be the longer end
    expect(Number(lock.end)).to.equal(lateEnd);

    let benchLow = minted.add(additionalMinted).mul(999).div(1000)

    let benchHigh = minted.add(additionalMinted).mul(1001).div(1000)
    // validate minted
    expect(lock.minted.gte(benchLow)).to.equal(true)
    expect(lock.minted.lte(benchHigh)).to.equal(true)

    // count should be unchanged
    count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });

  it('increase of locked time for half a lock', async function () {
    const amount = '1000000000000000000000' //10k

    let count = await this.token.lockCount()
    await this.token.connect(bob).createLock(amount, end, bob.address)

    // fetch lock beore maturity increase
    userLocks = await this.token.getLocks(bob.address)
    const lockBefore = userLocks[0]

    // get current timestamp
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;

    const amountToIncreaseMaturity = '500000000000000000000' //5k
    let additionalMinted = await this.token.getAdditionalAmountMinted(amountToIncreaseMaturity, currentTimestamp, end, lateEnd)

    await this.token.connect(bob).increaseTimeToMaturity(amountToIncreaseMaturity, 0, lateEnd)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    // that one is the original lock with half the amount
    lock = userLocks[0]

    // that is the new one that was spun off
    newLock = userLocks[1]

    //lock should have target amount
    expect(lock.amount.toString()).to.equal(amountToIncreaseMaturity);
    expect(newLock.amount.toString()).to.equal(amountToIncreaseMaturity);

    // end should be unchanged
    expect(Number(lock.end)).to.equal(end);

    // second should have late end
    expect(Number(newLock.end)).to.equal(lateEnd);

    let benchLow = additionalMinted.add(lockBefore.minted.div(2)).mul(999).div(1000)
    let benchHigh = additionalMinted.add(lockBefore.minted.div(2)).mul(1001).div(1000)

    // validate minted
    expect(newLock.minted.gte(benchLow)).to.equal(true)
    expect(newLock.minted.lte(benchHigh)).to.equal(true)

    // count should be unchanged
    count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });


  it('lock split', async function () {
    const amount = '1000000000000000000000' //10k

    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // fetch lock beore maturity increase
    userLocks = await this.token.getLocks(bob.address)
    const lockBefore = userLocks[0]

    // get current timestamp
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;

    const amountToSplitOff = '500000000000000000000' //5k

    await this.token.connect(bob).splitLock(amountToSplitOff, 0, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    // that one is the original lock with half the amount
    lock = userLocks[0]

    // that is the new one that was spun off
    newLock = userLocks[1]

    //lock should have target amount
    expect(lock.amount.toString()).to.equal(amountToSplitOff);
    expect(newLock.amount.toString()).to.equal(amountToSplitOff);

    // end should be unchanged
    expect(Number(lock.end)).to.equal(end);

    // second should have late end
    expect(Number(newLock.end)).to.equal(end);

    expect(newLock.amount.toString()).to.equal(amountToSplitOff)
    expect(lock.amount.toString()).to.equal(amountToSplitOff)


    // validate minted
    expect(newLock.minted.toString()).to.equal(lockBefore.minted.div(2).toString())
    expect(lock.minted.toString()).to.equal(lockBefore.minted.div(2).toString())

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });


  it('lock merge same maturity', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, end, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [2000]);

    await this.token.connect(bob).mergeLocks(0, 1)

    let newUserLocks = await this.token.getLocks(bob.address)
    const newLock = newUserLocks[0]

    // length validation
    expect(newUserLocks.length).to.equal(1)

    //lock should have target amount
    expect(newLock.amount.toString()).to.equal(userLocks[0].amount.add(userLocks[1].amount).toString());
    expect(newLock.minted.toString()).to.equal(userLocks[0].minted.add(userLocks[1].minted).toString());
    expect(Number(newLock.end.toString())).to.equal(end);

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });


  it('lock merge different maturity, first lower', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, lateEnd, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [2000]);
    await this.token.connect(bob).mergeLocks(0, 1)

    // get current timestamp
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;

    let additionalMinted = await this.token.getAdditionalAmountMinted(amount, currentTimestamp, end, lateEnd)
    let benchLow = additionalMinted.mul(999).div(1000)
    let benchHigh = additionalMinted.mul(1001).div(1000)

    let newUserLocks = await this.token.getLocks(bob.address)
    const newLock = newUserLocks[0]

    // length validation
    expect(newUserLocks.length).to.equal(1)

    // lock should have target amount
    expect(newLock.amount.toString()).to.equal(userLocks[0].amount.add(userLocks[1].amount).toString());

    // minted amound should have increased
    expect(newLock.minted.gte(userLocks[0].minted.add(userLocks[1].minted.add(benchLow)))).to.equal(true);
    expect(newLock.minted.lte(userLocks[0].minted.add(userLocks[1].minted.add(benchHigh)))).to.equal(true);
    expect(Number(newLock.end.toString())).to.equal(lateEnd);

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });

  it('lock merge different maturity, second lower', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, lateEnd, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, end, bob.address)

    // fetch lock
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [2000]);
    await this.token.connect(bob).mergeLocks(0, 1)

    // get current timestamp
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;

    let additionalMinted = await this.token.getAdditionalAmountMinted(amountSecond, currentTimestamp, end, lateEnd)
    let benchLow = additionalMinted.mul(999).div(1000)
    let benchHigh = additionalMinted.mul(1001).div(1000)

    let newUserLocks = await this.token.getLocks(bob.address)
    const newLock = newUserLocks[0]

    // length validation
    expect(newUserLocks.length).to.equal(1)

    // lock should have target amount
    expect(newLock.amount.toString()).to.equal(userLocks[0].amount.add(userLocks[1].amount).toString());

    // minted amound should have increased
    expect(newLock.minted.gte(userLocks[0].minted.add(userLocks[1].minted.add(benchLow)))).to.equal(true);
    expect(newLock.minted.lte(userLocks[0].minted.add(userLocks[1].minted.add(benchHigh)))).to.equal(true);
    expect(Number(newLock.end.toString())).to.equal(lateEnd);

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });

  it('full lock transfer no gov tokens sent', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, lateEnd, bob.address)

    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    await this.token.connect(bob).transferLock(amount, 0, carol.address, false)


    let firstLocks = await this.token.getLocks(bob.address)
    let secondLocks = await this.token.getLocks(carol.address)

    // length validation
    expect(firstLocks.length).to.equal(0)
    expect(secondLocks.length).to.equal(1)
    let newLock = secondLocks[0]

    // lock should have target amount
    expect(newLock.amount.toString()).to.equal(amount);

    // minted amound should have increased
    expect(newLock.minted.toString()).to.equal(userLocks[0].minted.toString());
    expect(Number(newLock.end.toString())).to.equal(Number(userLocks[0].end.toString()));

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });


  it('paritial transfer no gov tokens sent', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, lateEnd, bob.address)

    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    const amountToSend = '700000000000000000000' //10k
    await this.token.connect(bob).transferLock(amountToSend, 0, carol.address, false)


    let firstLocks = await this.token.getLocks(bob.address)
    let secondLocks = await this.token.getLocks(carol.address)

    // length validation
    expect(firstLocks.length).to.equal(1)
    expect(secondLocks.length).to.equal(1)
    let oldLock = firstLocks[0]
    let newLock = secondLocks[0]

    // lock should have target amount
    expect(oldLock.amount.toString()).to.equal('300000000000000000000');
    expect(newLock.amount.toString()).to.equal(amountToSend);

    const newMinted = userLocks[0].minted.mul(amountToSend).div(amount)
    // minted amound should have increased
    expect(newLock.minted.toString()).to.equal(newMinted.toString());
    expect(oldLock.minted.toString()).to.equal(userLocks[0].minted.sub(newMinted).toString());
    expect(Number(newLock.end.toString())).to.equal(Number(userLocks[0].end.toString()));

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('2');
  });

  it('full lock transfer gov tokens sent', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, lateEnd, bob.address)

    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    await this.token.connect(bob).approve(this.token.address, ethers.constants.MaxUint256)
    await this.token.connect(bob).transferLock(amount, 0, carol.address, true)

    const balance = await this.token.balanceOf(carol.address)

    // minted amound should have increased
    expect(balance.toString()).to.equal(userLocks[0].minted.toString());
  });

  it('paritial transfer gov tokens sent', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, lateEnd, bob.address)

    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    const amountToSend = '700000000000000000000' //10k
    await this.token.connect(bob).approve(this.token.address, ethers.constants.MaxUint256)
    await this.token.connect(bob).transferLock(amountToSend, 0, carol.address, true)

    let secondLocks = await this.token.getLocks(carol.address)

    let newLock = secondLocks[0]

    const balance = await this.token.balanceOf(carol.address)

    // minted should be balance
    expect(newLock.minted.toString()).to.equal(balance.toString());
  });

  it('withdraws full', async function () {

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, lateEnd, bob.address)

    await network.provider.send("evm_increaseTime", [maturity]);

    const amountThird = '750000000000000000000' //5k
    await this.token.connect(bob).createLock(amountThird, lateEnd, bob.address)

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [100]);

    await this.token.connect(bob).withdrawAll()

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(3)
    expect(newLocks.length).to.equal(2)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)

    // amount validation
    expect(firstAmount.toString()).to.equal('1250000000000000000000')

    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal(userLocks[1].minted.add(userLocks[2].minted).toString())
    expect(minted.toString()).to.equal(userLocks[1].minted.add(userLocks[2].minted).toString())

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('3');
  });

  it('withdraws single full', async function () {

    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    const balBeforeWithdraw = await this.lockedToken.balanceOf(bob.address)

    await network.provider.send("evm_increaseTime", [maturity + 100]);

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [100]);


    await this.token.connect(bob).withdraw(0, amount)

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(1)
    expect(newLocks.length).to.equal(0)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)

    const balAfterWithdraw = await this.lockedToken.balanceOf(bob.address)

    // amount validation
    expect(firstAmount.toString()).to.equal('0')
    expect(balAfterWithdraw.sub(balBeforeWithdraw).toString()).to.equal(amount)

    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal('0')
    expect(minted.toString()).to.equal('0')

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });


  it('withdraws single partly', async function () {

    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    const balBeforeWithdraw = await this.lockedToken.balanceOf(bob.address)
    const votingBeforeWithdraw = await this.token.balanceOf(bob.address)

    await network.provider.send("evm_increaseTime", [maturity + 100]);

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [100]);

    const amountToWithdraw = '750000000000000000000' //5k
    await this.token.connect(bob).withdraw(0, amountToWithdraw)

    const votingAfterWithdraw = await this.token.balanceOf(bob.address)

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(1)
    expect(newLocks.length).to.equal(1)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)


    const balAfterWithdraw = await this.lockedToken.balanceOf(bob.address)

    // amount validation
    expect(firstAmount.toString()).to.equal('250000000000000000000')
    expect(balAfterWithdraw.sub(balBeforeWithdraw).toString()).to.equal(amountToWithdraw)

    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal(newLocks[0].minted.toString())
    expect(voting.toString()).to.equal(minted.toString())
    expect(userLocks[0].minted.sub(newLocks[0].minted).toString()).to.equal(votingBeforeWithdraw.sub(votingAfterWithdraw).toString())

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });

  it('emergency withdraws full', async function () {
    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity
    lateEnd = end + maturity


    const penaltyRate = await this.token.earlyWithdrawPenaltyRate()
    const precistion = await this.token.PRECISION()

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    await network.provider.send("evm_increaseTime", [1000]);

    // create second lock
    const amountSecond = '500000000000000000000' //5k
    await this.token.connect(bob).createLock(amountSecond, lateEnd, bob.address)

    await network.provider.send("evm_increaseTime", [maturity]);

    const amountThird = '750000000000000000000' //5k
    await this.token.connect(bob).createLock(amountThird, lateEnd, bob.address)
    const totalAmountPreWithdraw = await this.token.getTotalAmountLocked(bob.address)

    const balBeforeWithdraw = await this.lockedToken.balanceOf(bob.address)

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [100]);

    await this.token.connect(bob).emergencyWithdrawAll()

    const balAfterWithdraw = await this.lockedToken.balanceOf(bob.address)

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(3)
    expect(newLocks.length).to.equal(0)
    const penalty = (penaltyRate.mul(amountSecond).div(precistion)).add(penaltyRate.mul(amountThird).div(precistion))
    const totalAmount = await this.token.getTotalAmountLocked(bob.address)
    const balDiff = balAfterWithdraw.sub(balBeforeWithdraw)
    // amount validation
    expect(totalAmount.toString()).to.equal('0')
    expect(balDiff.toString()).to.equal(totalAmountPreWithdraw.sub(penalty).toString())
    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal('0')
    expect(minted.toString()).to.equal('0')

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('3');
  });


  it('emergency withdraws single expired', async function () {

    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    const balBeforeWithdraw = await this.lockedToken.balanceOf(bob.address)

    await network.provider.send("evm_increaseTime", [maturity + 100]);

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await network.provider.send("evm_increaseTime", [100]);


    await this.token.connect(bob).emergencyWithdraw(0)

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(1)
    expect(newLocks.length).to.equal(0)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)

    const balAfterWithdraw = await this.lockedToken.balanceOf(bob.address)

    // amount validation
    expect(firstAmount.toString()).to.equal('0')
    expect(balAfterWithdraw.sub(balBeforeWithdraw).toString()).to.equal(amount)

    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal('0')
    expect(minted.toString()).to.equal('0')

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });

  it('emergency withdraws single with penalty', async function () {

    block = await ethers.provider.getBlock("latest");
    currentTimestamp = block.timestamp;
    end = currentTimestamp + maturity


    const penaltyRate = await this.token.earlyWithdrawPenaltyRate()
    const precistion = await this.token.PRECISION()

    // create first lock
    const amount = '1000000000000000000000' //10k
    await this.token.connect(bob).createLock(amount, end, bob.address)

    const balBeforeWithdraw = await this.lockedToken.balanceOf(bob.address)

    await network.provider.send("evm_increaseTime", [maturity - 100]);

    // fetch lock pre
    userLocks = await this.token.getLocks(bob.address)

    await this.token.connect(bob).emergencyWithdraw(0)

    // fetch lock post
    let newLocks = await this.token.getLocks(bob.address)

    // length validation
    expect(userLocks.length).to.equal(1)
    expect(newLocks.length).to.equal(0)

    const firstAmount = await this.token.getTotalAmountLocked(bob.address)

    const balAfterWithdraw = await this.lockedToken.balanceOf(bob.address)

    // amount validation
    expect(firstAmount.toString()).to.equal('0')
    expect(balAfterWithdraw.sub(balBeforeWithdraw).toString()).to.equal(ethers.BigNumber.from(amount).sub(penaltyRate.mul(amount).div(precistion)).toString())

    // voting power
    const minted = await this.token.getUserMinted(bob.address)
    const voting = await this.token.balanceOf(bob.address)

    // validate via balances
    expect(voting.toString()).to.equal('0')
    expect(minted.toString()).to.equal('0')

    // count should be unchanged
    let count = await this.token.lockCount()
    expect(count.toString()).to.equal('1');
  });

});
