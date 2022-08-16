/* eslint-disable */

const { BN, constants: ozConstants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');
const {
  // MAX_UINT256, 
  ZERO_ADDRESS, ZERO_BYTES32 } = ozConstants;

const { fromRpcSig } = require('ethereumjs-util');
const ethSigUtil = require('eth-sig-util');
const Wallet = require('ethereumjs-wallet').default;

const { promisify } = require('util');
const queue = promisify(setImmediate);

const ERC20VotesMock = artifacts.require('GovernanceRequiemMock');
const MockRegisteredToken = artifacts.require('MockRegisteredToken');
const VotingRegister = artifacts.require('MockVotesRegister');
const ERC20Mock = artifacts.require('ERC20Mock');


const { EIP712Domain, domainSeparator } = require('../helpers/eip712');
const { ethers } = require('hardhat');
const { BigNumber, constants } = require('ethers');

const Delegation = [
  { name: 'delegatee', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
];

async function countPendingTransactions() {
  return parseInt(
    await network.provider.send('eth_getBlockTransactionCountByNumber', ['pending'])
  );
}

async function batchInBlock(txs) {
  try {
    // disable auto-mining
    await network.provider.send('evm_setAutomine', [false]);
    // send all transactions
    const promises = txs.map(fn => fn());
    // wait for node to have all pending transactions
    while (txs.length > await countPendingTransactions()) {
      await queue();
    }
    // mine one block
    await network.provider.send('evm_mine');
    // fetch receipts
    const receipts = await Promise.all(promises);
    // Sanity check, all tx should be in the same block
    const minedBlocks = new Set(receipts.map(({ receipt }) => receipt.blockNumber));
    expect(minedBlocks.size).to.equal(1);

    return receipts;
  } finally {
    // enable auto-mining
    await network.provider.send('evm_setAutomine', [true]);
  }
}

contract('Requiem Votes Register', function (accounts) {
  // const [deployer.address, dave.address, alice.address, dave.addressDelegatee, bob.address, carol.address] = accounts;
  let deployer, alice, bob, carol, dave;
  const MAX_UINT256 = BigNumber.from(2).pow(256).sub(1)
  const name = 'My Token';
  const symbol = 'MTKN';
  const version = '1';
  const supply = BigNumber.from('10000000000000000000000000');

  beforeEach(async function () {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();

    const factoryToken = await ethers.getContractFactory('MockRegisteredToken')
    const factoryRegister = await ethers.getContractFactory('MockVotesRegister')

    this.register = await factoryRegister.deploy()
    this.token1 = await factoryToken.deploy(name, symbol, this.register.address)

    this.lockedToken = await ERC20Mock.new(name, symbol, deployer.address, supply);
    this.token = await ERC20VotesMock.new(name, symbol, this.lockedToken.address, '0x0000000000000000000000000000000000000000', '1');
    // this.register = await VotingRegister.new({ from: deployer.address })
    // this.token1 = await MockRegisteredToken.new(name, symbol, this.register.address);
    await this.register.authorize(deployer.address, { from: deployer.address })
    await this.register.registerToken(this.token1.address, { from: deployer.address })

    // We get the chain id from the contract because Ganache (used for coverage) does not return the same chain id
    // from within the EVM as from the JSON RPC interface.
    // See https://github.com/trufflesuite/ganache-core/issues/515
    this.chainId = await this.register.getChainId();
  });

  it('initial nonce is 0', async function () {
    expect((await this.register.nonces(deployer.address)).toString()).to.be.equal('0');
  });

  it('register token:unauthorized', async function () {
    await expect(
      this.register.connect(bob).registerToken(this.token1.address)).to.be.revertedWith(
        "VotesRegister: unauthorized"
      );
  });

  it('register token', async function () {

    expect(
      await this.register.isRegistered(this.token1.address),
    ).to.equal(
      true,
    );
  });


  it('domain separator', async function () {
    expect(
      await this.register.DOMAIN_SEPARATOR(),
    ).to.equal(
      await domainSeparator('Requiem Pool Voting Register', version, this.chainId.toString(), this.register.address),
    );
  });

  it('minting restriction', async function () {
    const amount = new BN('2').pow(new BN('224'));
    await expectRevert(
      this.token.mint(deployer.address, amount),
      'ERC20Votes: total supply risks overflowing votes',
    );
  });

  describe('set delegation', function () {
    describe('call', function () {
      it('delegation with balance', async function () {
        await this.token1.mint(deployer.address, supply);
        expect(await this.register.delegates(deployer.address, this.token1.address)).to.be.equal(ZERO_ADDRESS);

        expect(await this.register.connect(deployer).delegate(deployer.address, this.token1.address)
        ).to.emit('DelegateChanged').withArgs(
          this.token1.address,
          deployer.address,
          ZERO_ADDRESS,
          deployer.address,
        ).and.to.emit('DelegateVotesChanged').withArgs(
          this.token1.address,
          deployer.address,
          '0',
          supply,
        )

        const latestBlock = await hre.ethers.provider.getBlock("latest")

        expect(await this.register.delegates(deployer.address, this.token1.address)).to.be.equal(deployer.address);

        expect(await this.register.getVotes(deployer.address, this.token1.address)).to.be.equal(supply);
        expect(await this.register.getPastVotes(deployer.address, this.token1.address, latestBlock.number - 1)).to.be.equal('0');
        await time.advanceBlock();
        expect(await this.register.getPastVotes(deployer.address, this.token1.address, latestBlock.number)).to.be.equal(supply);
      });

      it('delegation without balance', async function () {
        expect(await this.register.delegates(deployer.address, this.token1.address)).to.be.equal(ZERO_ADDRESS);

        // const { receipt } = await this.token.delegate(deployer.address, { from: deployer.address });

        expect(await this.register.connect(deployer).delegate(deployer.address, this.token1.address)
        ).to.emit('DelegateChanged').withArgs(
          this.token1.address,
          deployer.address,
          ZERO_ADDRESS,
          deployer.address,
        )
        // expectEvent(receipt, 'DelegateChanged', {
        //   delegator: deployer.address,
        //   fromDelegate: ZERO_ADDRESS,
        //   toDelegate: deployer.address,
        // });
        // expectEvent.notEmitted(receipt, 'DelegateVotesChanged');

        expect(await this.register.delegates(deployer.address, this.token1.address)).to.be.equal(deployer.address);
      });
    });

    describe('with signature', function () {
      const delegatorWallet = Wallet.generate();
      console.log("WW",delegatorWallet)
      const delegatorAddress = web3.utils.toChecksumAddress(delegator.getAddressString());
      const nonce = 0;

      const buildData = (chainId, verifyingContract, message) => ({
        data: {
          primaryType: 'Delegation',
          types: { EIP712Domain, Delegation },
          domain: { name, version, chainId, verifyingContract },
          message,
        }
      });

      beforeEach(async function () {
        await this.token1.mint(delegator.address, supply);
      });

      it('accept signed delegation', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId.toString(), this.register.address, {
            pool: this.token1.address,
            delegatee: delegator.address,
            nonce,
            expiry: MAX_UINT256.toString(),
          }),
        ));

        expect(await this.register.delegates(delegator.address, this.token1.address)).to.be.equal(ZERO_ADDRESS);

        // const { receipt } = await this.token.delegateBySig(delegator.address, nonce, MAX_UINT256, v, r, s);
        // expectEvent(receipt, 'DelegateChanged', {
        //   delegator: delegator.address,
        //   fromDelegate: ZERO_ADDRESS,
        //   toDelegate: delegator.address,
        // });
        // expectEvent(receipt, 'DelegateVotesChanged', {
        //   delegate: delegator.address,
        //   previousBalance: '0',
        //   newBalance: supply,
        // });

        expect(await this.register.connect(delegator).delegateBySig(delegator.address, this.token1.address, nonce, MAX_UINT256, v, r, s)
        ).to.emit('DelegateChanged').withArgs(
          this.token1.address,
          delegator.address,
          ZERO_ADDRESS,
          delegator.address,
        ).and.to.emit('DelegateVotesChanged').withArgs(
          this.token1.address,
          delegator.address,
          '0',
          supply,
        )
        console.log("TEST")

        const latestBlock = await hre.ethers.provider.getBlock("latest")
        expect(await this.register.delegates(delegator.address, this.token1.address)).to.be.equal(delegator.address);
        console.log("TEST1")
        expect(await this.register.getVotes(delegator.address, this.token1.address)).to.be.equal(supply);
        console.log("TEST2")
        expect(await this.register.getPastVotes(delegator.address, this.token1.address, latestBlock.number - 1)).to.be.equal('0');
        console.log("TEST3")
        await time.advanceBlock();
        expect(await this.register.getPastVotes(delegator.address, this.token1.address, latestBlock.number)).to.be.equal(supply);
      });

      it('rejects reused signature', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.token.address, {
            delegatee: delegator.address,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));

        await this.token.delegateBySig(delegator.address, nonce, MAX_UINT256, v, r, s);

        await expectRevert(
          this.token.delegateBySig(delegator.address, nonce, MAX_UINT256, v, r, s),
          'ERC20Votes: invalid nonce',
        );
      });

      it('rejects bad delegatee', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.token.address, {
            delegatee: delegator.address,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));

        const receipt = await this.token.delegateBySig(alice.address, nonce, MAX_UINT256, v, r, s);
        const { args } = receipt.logs.find(({ event }) => event == 'DelegateChanged');
        expect(args.delegator).to.not.be.equal(delegator.address);
        expect(args.fromDelegate).to.be.equal(ZERO_ADDRESS);
        expect(args.toDelegate).to.be.equal(alice.address);
      });

      it('rejects bad nonce', async function () {
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.token.address, {
            delegatee: delegator.address,
            nonce,
            expiry: MAX_UINT256,
          }),
        ));
        await expectRevert(
          this.token.delegateBySig(delegator.address, nonce + 1, MAX_UINT256, v, r, s),
          'ERC20Votes: invalid nonce',
        );
      });

      it('rejects expired permit', async function () {
        const expiry = (await time.latest()) - time.duration.weeks(1);
        const { v, r, s } = fromRpcSig(ethSigUtil.signTypedMessage(
          delegator.getPrivateKey(),
          buildData(this.chainId, this.token.address, {
            delegatee: delegator.address,
            nonce,
            expiry,
          }),
        ));

        await expectRevert(
          this.token.delegateBySig(delegator.address, nonce, expiry, v, r, s),
          'ERC20Votes: signature expired',
        );
      });
    });
  });

  describe('change delegation', function () {
    beforeEach(async function () {
      await this.token.mint(deployer.address, supply);
      await this.token.delegate(deployer.address, { from: deployer.address });
    });

    it('call', async function () {
      expect(await this.token.delegates(deployer.address)).to.be.equal(deployer.address);

      const { receipt } = await this.token.delegate(alice.address, { from: deployer.address });
      expectEvent(receipt, 'DelegateChanged', {
        delegator: deployer.address,
        fromDelegate: deployer.address,
        toDelegate: alice.address,
      });
      expectEvent(receipt, 'DelegateVotesChanged', {
        delegate: deployer.address,
        previousBalance: supply,
        newBalance: '0',
      });
      expectEvent(receipt, 'DelegateVotesChanged', {
        delegate: alice.address,
        previousBalance: '0',
        newBalance: supply,
      });

      expect(await this.token.delegates(deployer.address)).to.be.equal(alice.address);

      expect(await this.token.getVotes(deployer.address)).to.be.bignumber.equal('0');
      expect(await this.token.getVotes(alice.address)).to.be.bignumber.equal(supply);
      expect(await this.token.getPastVotes(deployer.address, receipt.blockNumber - 1)).to.be.bignumber.equal(supply);
      expect(await this.token.getPastVotes(alice.address, receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      await time.advanceBlock();
      expect(await this.token.getPastVotes(deployer.address, receipt.blockNumber)).to.be.bignumber.equal('0');
      expect(await this.token.getPastVotes(alice.address, receipt.blockNumber)).to.be.bignumber.equal(supply);
    });
  });

  describe('transfers', function () {
    beforeEach(async function () {
      await this.token.mint(deployer.address, supply);
    });

    it('no delegation', async function () {
      const { receipt } = await this.token.transfer(dave.address, 1, { from: deployer.address });
      expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      expectEvent.notEmitted(receipt, 'DelegateVotesChanged');

      this.deployer.addressVotes = '0';
      this.dave.addressVotes = '0';
    });

    it('sender delegation', async function () {
      await this.token.delegate(deployer.address, { from: deployer.address });

      const { receipt } = await this.token.transfer(dave.address, 1, { from: deployer.address });
      expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      expectEvent(receipt, 'DelegateVotesChanged', { delegate: deployer.address, previousBalance: supply, newBalance: supply.subn(1) });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.deployer.addressVotes = supply.subn(1);
      this.dave.addressVotes = '0';
    });

    it('receiver delegation', async function () {
      await this.token.delegate(dave.address, { from: dave.address });

      const { receipt } = await this.token.transfer(dave.address, 1, { from: deployer.address });
      expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      expectEvent(receipt, 'DelegateVotesChanged', { delegate: dave.address, previousBalance: '0', newBalance: '1' });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.deployer.addressVotes = '0';
      this.dave.addressVotes = '1';
    });

    it('full delegation', async function () {
      await this.token.delegate(deployer.address, { from: deployer.address });
      await this.token.delegate(dave.address, { from: dave.address });

      const { receipt } = await this.token.transfer(dave.address, 1, { from: deployer.address });
      expectEvent(receipt, 'Transfer', { from: deployer.address, to: dave.address, value: '1' });
      expectEvent(receipt, 'DelegateVotesChanged', { delegate: deployer.address, previousBalance: supply, newBalance: supply.subn(1) });
      expectEvent(receipt, 'DelegateVotesChanged', { delegate: dave.address, previousBalance: '0', newBalance: '1' });

      const { logIndex: transferLogIndex } = receipt.logs.find(({ event }) => event == 'Transfer');
      expect(receipt.logs.filter(({ event }) => event == 'DelegateVotesChanged').every(({ logIndex }) => transferLogIndex < logIndex)).to.be.equal(true);

      this.deployer.addressVotes = supply.subn(1);
      this.dave.addressVotes = '1';
    });

    afterEach(async function () {
      expect(await this.token.getVotes(deployer.address)).to.be.bignumber.equal(this.deployer.addressVotes);
      expect(await this.token.getVotes(dave.address)).to.be.bignumber.equal(this.dave.addressVotes);

      // need to advance 2 blocks to see the effect of a transfer on "getPastVotes"
      const blockNumber = await time.latestBlock();
      await time.advanceBlock();
      expect(await this.token.getPastVotes(deployer.address, blockNumber)).to.be.bignumber.equal(this.deployer.addressVotes);
      expect(await this.token.getPastVotes(dave.address, blockNumber)).to.be.bignumber.equal(this.dave.addressVotes);
    });
  });

  // The following tests are a adaptation of https://github.com/compound-finance/compound-protocol/blob/master/tests/Governance/CompTest.js.
  describe('Compound test suite', function () {
    beforeEach(async function () {
      await this.token.mint(deployer.address, supply);
    });

    describe('balanceOf', function () {
      it('grants to initial account', async function () {
        expect(await this.token.balanceOf(deployer.address)).to.be.bignumber.equal('10000000000000000000000000');
      });
    });

    describe('numCheckpoints', function () {
      it('returns the number of checkpoints for a delegate', async function () {
        await this.token.transfer(dave.address, '100', { from: deployer.address }); //give an account a few tokens for readability
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('0');

        const t1 = await this.token.delegate(bob.address, { from: dave.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('1');

        const t2 = await this.token.transfer(carol.address, 10, { from: dave.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('2');

        const t3 = await this.token.transfer(carol.address, 10, { from: dave.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('3');

        const t4 = await this.token.transfer(dave.address, 20, { from: deployer.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('4');

        expect(await this.token.checkpoints(bob.address, 0)).to.be.deep.equal([t1.receipt.blockNumber.toString(), '100']);
        expect(await this.token.checkpoints(bob.address, 1)).to.be.deep.equal([t2.receipt.blockNumber.toString(), '90']);
        expect(await this.token.checkpoints(bob.address, 2)).to.be.deep.equal([t3.receipt.blockNumber.toString(), '80']);
        expect(await this.token.checkpoints(bob.address, 3)).to.be.deep.equal([t4.receipt.blockNumber.toString(), '100']);

        await time.advanceBlock();
        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber)).to.be.bignumber.equal('100');
        expect(await this.token.getPastVotes(bob.address, t2.receipt.blockNumber)).to.be.bignumber.equal('90');
        expect(await this.token.getPastVotes(bob.address, t3.receipt.blockNumber)).to.be.bignumber.equal('80');
        expect(await this.token.getPastVotes(bob.address, t4.receipt.blockNumber)).to.be.bignumber.equal('100');
      });

      it('does not add more than one checkpoint in a block', async function () {
        await this.token.transfer(dave.address, '100', { from: deployer.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('0');

        const [t1, t2, t3] = await batchInBlock([
          () => this.token.delegate(bob.address, { from: dave.address, gas: 100000 }),
          () => this.token.transfer(carol.address, 10, { from: dave.address, gas: 100000 }),
          () => this.token.transfer(carol.address, 10, { from: dave.address, gas: 100000 }),
        ]);
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('1');
        expect(await this.token.checkpoints(bob.address, 0)).to.be.deep.equal([t1.receipt.blockNumber.toString(), '80']);
        // expectReve(await this.token.checkpoints(bob.address, 1)).to.be.deep.equal([ '0', '0' ]); // Reverts due to array overflow check
        // expect(await this.token.checkpoints(bob.address, 2)).to.be.deep.equal([ '0', '0' ]); // Reverts due to array overflow check

        const t4 = await this.token.transfer(dave.address, 20, { from: deployer.address });
        expect(await this.token.numCheckpoints(bob.address)).to.be.bignumber.equal('2');
        expect(await this.token.checkpoints(bob.address, 1)).to.be.deep.equal([t4.receipt.blockNumber.toString(), '100']);
      });
    });

    describe('getPastVotes', function () {
      it('reverts if block number >= current block', async function () {
        await expectRevert(
          this.token.getPastVotes(bob.address, 5e10),
          'ERC20Votes: block not yet mined',
        );
      });

      it('returns 0 if there are no checkpoints', async function () {
        expect(await this.token.getPastVotes(bob.address, 0)).to.be.bignumber.equal('0');
      });

      it('returns the latest block if >= last checkpoint block', async function () {
        const t1 = await this.token.delegate(bob.address, { from: deployer.address });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });

      it('returns zero if < first checkpoint block', async function () {
        await time.advanceBlock();
        const t1 = await this.token.delegate(bob.address, { from: deployer.address });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });

      it('generally returns the voting balance at the appropriate checkpoint', async function () {
        const t1 = await this.token.delegate(bob.address, { from: deployer.address });
        await time.advanceBlock();
        await time.advanceBlock();
        const t2 = await this.token.transfer(carol.address, 10, { from: deployer.address });
        await time.advanceBlock();
        await time.advanceBlock();
        const t3 = await this.token.transfer(carol.address, 10, { from: deployer.address });
        await time.advanceBlock();
        await time.advanceBlock();
        const t4 = await this.token.transfer(deployer.address, 20, { from: carol.address });
        await time.advanceBlock();
        await time.advanceBlock();

        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.token.getPastVotes(bob.address, t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.token.getPastVotes(bob.address, t2.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999990');
        expect(await this.token.getPastVotes(bob.address, t2.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999990');
        expect(await this.token.getPastVotes(bob.address, t3.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999980');
        expect(await this.token.getPastVotes(bob.address, t3.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999980');
        expect(await this.token.getPastVotes(bob.address, t4.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
        expect(await this.token.getPastVotes(bob.address, t4.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      });
    });
  });

  describe('getPastTotalSupply', function () {
    beforeEach(async function () {
      await this.token.delegate(deployer.address, { from: deployer.address });
    });

    it('reverts if block number >= current block', async function () {
      await expectRevert(
        this.token.getPastTotalSupply(5e10),
        'ERC20Votes: block not yet mined',
      );
    });

    it('returns 0 if there are no checkpoints', async function () {
      expect(await this.token.getPastTotalSupply(0)).to.be.bignumber.equal('0');
    });

    it('returns the latest block if >= last checkpoint block', async function () {
      t1 = await this.token.mint(deployer.address, supply);

      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber)).to.be.bignumber.equal(supply);
      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber + 1)).to.be.bignumber.equal(supply);
    });

    it('returns zero if < first checkpoint block', async function () {
      await time.advanceBlock();
      const t1 = await this.token.mint(deployer.address, supply);
      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
    });

    it('generally returns the voting balance at the appropriate checkpoint', async function () {
      const t1 = await this.token.mint(deployer.address, supply);
      await time.advanceBlock();
      await time.advanceBlock();
      const t2 = await this.token.burn(deployer.address, 10);
      await time.advanceBlock();
      await time.advanceBlock();
      const t3 = await this.token.burn(deployer.address, 10);
      await time.advanceBlock();
      await time.advanceBlock();
      const t4 = await this.token.mint(deployer.address, 20);
      await time.advanceBlock();
      await time.advanceBlock();

      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber - 1)).to.be.bignumber.equal('0');
      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.token.getPastTotalSupply(t1.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.token.getPastTotalSupply(t2.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999990');
      expect(await this.token.getPastTotalSupply(t2.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999990');
      expect(await this.token.getPastTotalSupply(t3.receipt.blockNumber)).to.be.bignumber.equal('9999999999999999999999980');
      expect(await this.token.getPastTotalSupply(t3.receipt.blockNumber + 1)).to.be.bignumber.equal('9999999999999999999999980');
      expect(await this.token.getPastTotalSupply(t4.receipt.blockNumber)).to.be.bignumber.equal('10000000000000000000000000');
      expect(await this.token.getPastTotalSupply(t4.receipt.blockNumber + 1)).to.be.bignumber.equal('10000000000000000000000000');
    });
  });
});
